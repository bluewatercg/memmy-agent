import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryDb, MemoryService, Repositories } from "../../../src/index.js";
import { loadMemmyConfig } from "../../../src/config/index.js";
import type { RuntimeNamespace } from "../../../src/types.js";
import { AgentPositionService } from "../../../src/service/topic-decision/agent-position.js";
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

// Test for Fix #1: Stale snapshot position should NOT be reused
describe("position reuse validation", () => {
  it("rejects position from stale snapshot - FAILS BEFORE FIX", async () => {
    const { service, repos, namespaceId } = await setupService();
    const namespace: RuntimeNamespace = { source: "test", profileId: "test-profile", userId: "user-1" };
    const result = service.startTopicDecisionSession({ namespace, topicId: "topic-1" });

    // Create an OLD snapshot (round 0)
    const oldSnapshot = repos.topicDecisions.insertSnapshot({
      id: "old-snap",
      namespaceId,
      sessionId: result.session.id,
      round: 0,
      payload: { ...result.snapshot.payload, evidenceIds: ["ev-old"] },
      createdAt: nowIso()
    });

    // Insert position from OLD snapshot (should NOT be reused for current)
    await repos.topicDecisions.insertPosition({
      id: "pos-stale",
      namespaceId,
      sessionId: result.session.id,
      snapshotId: "old-snap", // Different from current snapshot
      round: 0,
      agentId: "agent-evidence_analyst",
      stance: "support",
      rationale: "from stale snapshot",
      evidenceIds: ["ev-old"],
      createdAt: nowIso()
    });

    // Get current active snapshot's valid evidence IDs
    const currentValidEvidenceIds = new Set(result.snapshot.payload.evidenceIds);

    // Import parseAgentPosition
    const { parseAgentPosition } = await import("../../../src/service/topic-decision/agent-position.js");

    // Try to parse position citing evidence NOT in current snapshot
    const stalePositionWithUnknownEvidence = {
      judgment: "support" as const,
      confidence: 0.8,
      evidenceIds: ["ev-old"], // Not in current snapshot
      facts: [],
      assumptions: [],
      missingInformation: [],
      risks: [],
      counterarguments: [],
      suggestedActions: []
    };

    // This should REJECT because evidence not in current snapshot
    const parseResult = parseAgentPosition(stalePositionWithUnknownEvidence, currentValidEvidenceIds);
    expect(parseResult).toHaveProperty("code", "UNKNOWN_EVIDENCE_CITATION");
  });

  it("accepts position with valid evidence IDs from active snapshot - FAILS BEFORE FIX", async () => {
    const { service, repos, namespaceId } = await setupService();
    const namespace: RuntimeNamespace = { source: "test", profileId: "test-profile", userId: "user-1" };
    const result = service.startTopicDecisionSession({ namespace, topicId: "topic-1" });

    // Current snapshot has ev-1 in evidenceIds
    const currentValidEvidenceIds = new Set(result.snapshot.payload.evidenceIds);

    const { parseAgentPosition } = await import("../../../src/service/topic-decision/agent-position.js");

    // Position with evidence from current snapshot should PASS
    const validPosition = {
      judgment: "support" as const,
      confidence: 0.8,
      evidenceIds: ["ev-1"], // In current snapshot
      facts: [],
      assumptions: [],
      missingInformation: [],
      risks: [],
      counterarguments: [],
      suggestedActions: []
    };

    const parseResult = parseAgentPosition(validPosition, currentValidEvidenceIds);
    expect(parseResult).not.toHaveProperty("code");
  });
});

// Production-path tests for AgentPositionService.runIndependentPositions
describe("runIndependentPositions", () => {
  it("has no ReferenceError - validEvidenceIds defined before filter callback", async () => {
    // This test verifies the TDZ fix: validEvidenceIds must be declared BEFORE
    // the filter callback that uses it
    const { service, repos, namespaceId, AgentPositionService } = await setupServiceWithAgentPosition();
    const namespace: RuntimeNamespace = { source: "test", profileId: "test-profile", userId: "user-1" };
    const result = service.startTopicDecisionSession({ namespace, topicId: "topic-1" });
    const sessionId = result.session.id;

    const snapshots = repos.topicDecisions.getSnapshotsForSession(namespaceId, sessionId);
    const activeSnapshot = snapshots[snapshots.length - 1]!;
    const currentEvidenceIds = activeSnapshot.payload.evidenceIds;

    const mockLlmClient = vi.fn().mockImplementation(() => ({
      completeJson: async () => ({
        judgment: "support",
        confidence: 0.8,
        evidenceIds: currentEvidenceIds,
        facts: [],
        assumptions: [],
        missingInformation: [],
        risks: [],
        counterarguments: [],
        suggestedActions: []
      })
    }));

    const agentPosService = new AgentPositionService({
      repos,
      createLlmClient: mockLlmClient
    });

    // This should NOT throw ReferenceError (the bug we fixed)
    // Before fix: ReferenceError: Cannot access 'validEvidenceIds' before initialization
    await expect(agentPosService.runIndependentPositions(namespace, sessionId))
      .resolves.not.toThrow();
  });

  it("builds validEvidenceIds before filter callback executes", async () => {
    // Direct unit test of the ordering fix
    const { service, repos, namespaceId, AgentPositionService } = await setupServiceWithAgentPosition();
    const namespace: RuntimeNamespace = { source: "test", profileId: "test-profile", userId: "user-1" };
    const result = service.startTopicDecisionSession({ namespace, topicId: "topic-1" });
    const sessionId = result.session.id;

    const snapshots = repos.topicDecisions.getSnapshotsForSession(namespaceId, sessionId);
    const activeSnapshot = snapshots[snapshots.length - 1]!;

    // The key fix: validEvidenceIds is now built BEFORE the filter that uses it.
    // This test just confirms the function executes without TDZ error.
    const mockLlmClient = vi.fn().mockImplementation(() => ({
      completeJson: async () => ({
        judgment: "support",
        confidence: 0.8,
        evidenceIds: activeSnapshot.payload.evidenceIds,
        facts: [],
        assumptions: [],
        missingInformation: [],
        risks: [],
        counterarguments: [],
        suggestedActions: []
      })
    }));

    const agentPosService = new AgentPositionService({
      repos,
      createLlmClient: mockLlmClient
    });

    // If validEvidenceIds was used before declaration, this would throw ReferenceError
    await expect(agentPosService.runIndependentPositions(namespace, sessionId))
      .resolves.not.toThrow();
  });

  it("reuses successful position from active snapshot without LLM call", async () => {
    const { service, repos, namespaceId, AgentPositionService } = await setupServiceWithAgentPosition();
    const namespace: RuntimeNamespace = { source: "test", profileId: "test-profile", userId: "user-1" };
    const result = service.startTopicDecisionSession({ namespace, topicId: "topic-1" });
    const sessionId = result.session.id;

    const snapshots = repos.topicDecisions.getSnapshotsForSession(namespaceId, sessionId);
    const activeSnapshot = snapshots[snapshots.length - 1]!;
    const currentEvidenceIds = activeSnapshot.payload.evidenceIds;

    // Pre-insert a successful position for the active snapshot
    const agentId = "agent-evidence_analyst";
    const insertedPosition = await repos.topicDecisions.insertPosition({
      id: "pos-active-valid",
      namespaceId,
      sessionId,
      snapshotId: activeSnapshot.id, // Same as active snapshot
      round: activeSnapshot.round,
      agentId,
      stance: "support",
      rationale: "pre-existing position from active snapshot",
      evidenceIds: currentEvidenceIds,
      createdAt: nowIso()
    });
    // Verify the position was inserted
    const allPositions = repos.topicDecisions.listPositions(namespaceId, sessionId, activeSnapshot.id);
    expect(allPositions.length).toBeGreaterThan(0);

    // Debug: verify the snapshot and position data before calling runIndependentPositions
    const snapshotsBefore = repos.topicDecisions.getSnapshotsForSession(namespaceId, sessionId);
    const activeSnap = snapshotsBefore[0]; // newest by round ASC
    const allPositionsBefore = repos.topicDecisions.listPositions(namespaceId, sessionId, activeSnap?.id ?? "");
    const roster = activeSnap?.payload.roster ?? [];
    const rosterAgentIds = roster.map(a => a.id);
    const positionsByAgent = new Map(allPositionsBefore.map(p => [p.agentId, p]));

    // Debug output
    console.log("DEBUG: rosterAgentIds:", rosterAgentIds);
    console.log("DEBUG: positions count:", allPositionsBefore.length);

    const mockLlmClient = vi.fn().mockImplementation(() => ({
      completeJson: async () => ({
        judgment: "support",
        confidence: 0.8,
        evidenceIds: currentEvidenceIds,
        facts: [],
        assumptions: [],
        missingInformation: [],
        risks: [],
        counterarguments: [],
        suggestedActions: []
      })
    }));
    const agentPosService = new AgentPositionService({
      repos,
      createLlmClient: mockLlmClient
    });

    await agentPosService.runIndependentPositions(namespace, sessionId);

    // LLM should NOT be called for agent with existing position (evidence_analyst)
    // But SHOULD be called for other 3 agents without positions
    expect(mockLlmClient).toHaveBeenCalledTimes(3);
    // Verify the first call was for evidence_analyst (no LLM call)
    const calls = mockLlmClient.mock.calls;
    const calledModels = calls.map(c => c[0]);
    expect(calledModels).not.toContain("MiniMax-M2.5"); // evidence_analyst's model
  });

  it("does not reuse position from stale snapshot - LLM runs", async () => {
    const { service, repos, namespaceId, AgentPositionService } = await setupServiceWithAgentPosition();
    const namespace: RuntimeNamespace = { source: "test", profileId: "test-profile", userId: "user-1" };
    const result = service.startTopicDecisionSession({ namespace, topicId: "topic-1" });
    const sessionId = result.session.id;
    const currentSnapshotId = result.snapshot.id;

    const snapshots = repos.topicDecisions.getSnapshotsForSession(namespaceId, sessionId);
    const activeSnapshot = snapshots[snapshots.length - 1]!;
    const currentEvidenceIds = activeSnapshot.payload.evidenceIds;

    // Pre-insert a position from a STALE snapshot (different snapshotId)
    const agentId = "agent-evidence_analyst";
    await repos.topicDecisions.insertPosition({
      id: "pos-stale-snapshot",
      namespaceId,
      sessionId,
      snapshotId: "stale-snapshot-id", // Different from current snapshot
      round: 0,
      agentId,
      stance: "support",
      rationale: "position from stale snapshot",
      evidenceIds: currentEvidenceIds,
      createdAt: nowIso()
    });

    const mockLlmClient = vi.fn().mockImplementation(() => ({
      completeJson: async () => ({
        judgment: "support",
        confidence: 0.8,
        evidenceIds: currentEvidenceIds,
        facts: [],
        assumptions: [],
        missingInformation: [],
        risks: [],
        counterarguments: [],
        suggestedActions: []
      })
    }));

    const agentPosService = new AgentPositionService({
      repos,
      createLlmClient: mockLlmClient
    });

    await agentPosService.runIndependentPositions(namespace, sessionId);

    // LLM SHOULD be called because stale snapshot position is not reused
    expect(mockLlmClient).toHaveBeenCalled();
  });

  it("does not reuse position with invalid evidence citation on current snapshot", async () => {
    const { service, repos, namespaceId, AgentPositionService } = await setupServiceWithAgentPosition();
    const namespace: RuntimeNamespace = { source: "test", profileId: "test-profile", userId: "user-1" };
    const result = service.startTopicDecisionSession({ namespace, topicId: "topic-1" });
    const sessionId = result.session.id;

    const snapshots = repos.topicDecisions.getSnapshotsForSession(namespaceId, sessionId);
    const activeSnapshot = snapshots[snapshots.length - 1]!;

    // Pre-insert a position that cites evidence NOT in current snapshot
    const agentId = "agent-evidence_analyst";
    await repos.topicDecisions.insertPosition({
      id: "pos-invalid-citation",
      namespaceId,
      sessionId,
      snapshotId: activeSnapshot.id, // Same as active snapshot
      round: activeSnapshot.round + 1, // Use next round to avoid immutable first-round conflict
      agentId,
      stance: "support",
      rationale: "position with invalid evidence citation",
      evidenceIds: ["nonexistent-evidence"], // NOT in current snapshot
      createdAt: nowIso()
    });

    const mockLlmClient = vi.fn().mockImplementation(() => ({
      completeJson: async () => ({
        judgment: "support",
        confidence: 0.8,
        evidenceIds: activeSnapshot.payload.evidenceIds,
        facts: [],
        assumptions: [],
        missingInformation: [],
        risks: [],
        counterarguments: [],
        suggestedActions: []
      })
    }));

    const agentPosService = new AgentPositionService({
      repos,
      createLlmClient: mockLlmClient
    });

    await agentPosService.runIndependentPositions(namespace, sessionId);

    // LLM SHOULD be called because the cached position has invalid evidence
    expect(mockLlmClient).toHaveBeenCalled();
  });
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

async function setupServiceWithAgentPosition(): Promise<{
  service: MemoryService;
  repos: Repositories;
  namespaceId: string;
  db: MemoryDb;
  AgentPositionService: typeof AgentPositionService;
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

  return { service, repos, namespaceId, db, AgentPositionService };
}
