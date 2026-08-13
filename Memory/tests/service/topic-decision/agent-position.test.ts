import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryDb, MemoryService, Repositories } from "../../../src/index.js";
import { loadMemmyConfig } from "../../../src/config/index.js";
import type { RuntimeNamespace } from "../../../src/types.js";
import { nowIso } from "../../../src/utils/time.js";
import { stableHash } from "../../../src/utils/id.js";

const roots: string[] = [];

beforeEach(() => {
  setEnv("MEMMY_TOPIC_DECISIONS_ENABLED", "true");
  setEnv("MEMMY_TOPIC_DECISION_MODELS", "MiniMax-M2.5,qwen3.7-plus,kimi-k2.5,glm-5");
});

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

// Tests that verify the position parsing logic without needing actual LLM calls
describe("parseAgentPosition", () => {
  it("parses valid position with all fields", async () => {
    const { service } = await setupService();

    // Import the parsing function
    const { parseAgentPosition } = await import("../../../src/service/topic-decision/agent-position.js");

    const validPosition = {
      judgment: "support",
      confidence: 0.8,
      evidenceIds: ["ev-1"],
      facts: [{ claim: "test fact", evidenceIds: ["ev-1"] }],
      assumptions: ["assumption 1"],
      missingInformation: [{ key: "key1", question: "what is X?", blocking: true, decisionImpact: "high" }],
      risks: [{ severity: "medium" as const, description: "some risk" }],
      counterarguments: ["counter 1"],
      suggestedActions: ["action 1"]
    };

    const result = parseAgentPosition(validPosition, new Set(["ev-1"]));
    expect(result).not.toHaveProperty("code");
    if (!("code" in result)) {
      expect(result.judgment).toBe("support");
      expect(result.confidence).toBe(0.8);
    }
  });

  it("rejects invalid confidence outside [0,1]", async () => {
    const { service } = await setupService();

    const { parseAgentPosition } = await import("../../../src/service/topic-decision/agent-position.js");

    const invalidPosition = {
      judgment: "support",
      confidence: 1.5,
      evidenceIds: ["ev-1"],
      facts: [],
      assumptions: [],
      missingInformation: [],
      risks: [],
      counterarguments: [],
      suggestedActions: []
    };

    const result = parseAgentPosition(invalidPosition, new Set(["ev-1"]));
    expect(result).toHaveProperty("code", "INVALID_CONFIDENCE");
  });

  it("rejects unknown evidence citation", async () => {
    const { service } = await setupService();

    const { parseAgentPosition } = await import("../../../src/service/topic-decision/agent-position.js");

    const positionWithUnknownEvidence = {
      judgment: "support",
      confidence: 0.8,
      evidenceIds: ["unknown-ev"],
      facts: [],
      assumptions: [],
      missingInformation: [],
      risks: [],
      counterarguments: [],
      suggestedActions: []
    };

    const result = parseAgentPosition(positionWithUnknownEvidence, new Set(["ev-1"]));
    expect(result).toHaveProperty("code", "UNKNOWN_EVIDENCE_CITATION");
  });

  it("accepts unknown judgment with type guard", async () => {
    const { service } = await setupService();

    const { parseAgentPosition } = await import("../../../src/service/topic-decision/agent-position.js");

    const unknownJudgment = {
      judgment: "unknown",
      confidence: 0.5,
      evidenceIds: [],
      facts: [],
      assumptions: ["some assumption"],
      missingInformation: [],
      risks: [],
      counterarguments: [],
      suggestedActions: []
    };

    const result = parseAgentPosition(unknownJudgment, new Set());
    expect(result).not.toHaveProperty("code");
    if (!("code" in result)) {
      expect(result.judgment).toBe("unknown");
    }
  });

  it("validates risk severity values", async () => {
    const { service } = await setupService();

    const { parseAgentPosition } = await import("../../../src/service/topic-decision/agent-position.js");

    const invalidRiskPosition = {
      judgment: "support",
      confidence: 0.8,
      evidenceIds: [],
      facts: [],
      assumptions: [],
      missingInformation: [],
      risks: [{ severity: "invalid" as any, description: "test" }],
      counterarguments: [],
      suggestedActions: []
    };

    const result = parseAgentPosition(invalidRiskPosition, new Set());
    expect(result).toHaveProperty("code", "MISSING_FIELD");
  });
});

// Tests for session state management
describe("topic decision session state", () => {
  it("reads session after start", async () => {
    const { service, repos, namespaceId } = await setupService();
    const namespace: RuntimeNamespace = { source: "test", profileId: "test-profile", userId: "user-1" };
    const result = service.startTopicDecisionSession({ namespace, topicId: "topic-1" });

    // Read the session
    const readResult = service.readTopicDecisionSession(namespace, result.session.id);
    expect(readResult.session.id).toBe(result.session.id);
    expect(readResult.snapshots.length).toBeGreaterThan(0);
  });

  it("throws when session not found", async () => {
    const { service } = await setupService();
    const namespace: RuntimeNamespace = { source: "test", profileId: "test-profile", userId: "user-1" };

    expect(() => service.readTopicDecisionSession(namespace, "nonexistent"))
      .toThrow("session not found");
  });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "agent-position-"));
  roots.push(root);
  return root;
}

function setEnv(name: string, value: string): void {
  process.env[name] = value;
}

async function setupService(): Promise<{
  service: MemoryService;
  repos: Repositories;
  namespaceId: string;
  db: MemoryDb;
}> {
  const root = tempRoot();
  const configPath = join(root, "config.yaml");
  const dbPath = join(root, "memory.sqlite");
  writeFileSync(configPath, YAML.stringify({ memmyMemory: {} }));

  const { config } = loadMemmyConfig(configPath);
  const db = new MemoryDb({ path: dbPath });
  const repos = new Repositories(db.db);

  const namespace: RuntimeNamespace = { source: "test", profileId: "test-profile", userId: "user-1" };
  const namespaceId = stableHash(namespace);

  // Insert topic
  repos.topics.insertTopic({
    id: "topic-1",
    namespaceId,
    title: "Test Topic",
    summary: "Test summary",
    status: "active",
    version: 1,
    sourceMemoryIds: [],
    metadata: {},
    createdAt: nowIso(),
    updatedAt: nowIso()
  });

  // Insert evidence
  repos.topics.insertEvidence({
    id: "ev-1",
    topicId: "topic-1",
    namespaceId,
    memoryId: "mem-1",
    role: "support",
    summary: "Evidence 1 content",
    metadata: {},
    createdAt: nowIso()
  });

  const service = new MemoryService({
    db,
    config,
    configPath,
    mode: "dev"
  });

  return { service, repos, namespaceId, db };
}
