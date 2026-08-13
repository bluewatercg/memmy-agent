import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_MEMMY_CONFIG, MemoryDb, MemoryService, Repositories } from "../../../src/index.js";
import { loadMemmyConfig } from "../../../src/config/index.js";
import type { RuntimeNamespace, TopicAgentSpec } from "../../../src/types.js";
import { nowIso } from "../../../src/utils/time.js";
import { stableHash } from "../../../src/utils/id.js";

const roots: string[] = [];
const envBackup: Record<string, string | undefined> = {};

beforeEach(() => {
  setEnv("MEMMY_TOPIC_DECISIONS_ENABLED", "true");
  setEnv("MEMMY_TOPIC_DECISION_MODELS", "MiniMax-M2.5,qwen3.7-plus,kimi-k2.5,glm-5");
});

afterEach(() => {
  for (const [key, value] of Object.entries(envBackup)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    delete envBackup[key];
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("topic decision config", () => {
  it("defaults topic decisions disabled", () => {
    delete process.env.MEMMY_TOPIC_DECISIONS_ENABLED;
    const root = tempRoot();
    const configPath = join(root, "config.yaml");
    writeFileSync(configPath, YAML.stringify({ memmyMemory: {} }));

    const { config } = loadMemmyConfig(configPath);
    expect(config.algorithm.topicDecisions?.enabled).toBe(false);
  });

  it("reads topic decisions enabled from env", () => {
    setEnv("MEMMY_TOPIC_DECISIONS_ENABLED", "true");
    const root = tempRoot();
    const configPath = join(root, "config.yaml");
    writeFileSync(configPath, YAML.stringify({ memmyMemory: {} }));

    const { config } = loadMemmyConfig(configPath);
    expect(config.algorithm.topicDecisions?.enabled).toBe(true);
  });

  it("trims and dedupes decision models", () => {
    setEnv("MEMMY_TOPIC_DECISION_MODELS", "MiniMax-M2.5, qwen3.7-plus ,MiniMax-M2.5,glm-5");
    const root = tempRoot();
    const configPath = join(root, "config.yaml");
    writeFileSync(configPath, YAML.stringify({ memmyMemory: {} }));

    const { config } = loadMemmyConfig(configPath);
    expect(config.algorithm.topicDecisions?.models).toEqual(["MiniMax-M2.5", "qwen3.7-plus", "glm-5"]);
  });

  it("returns default four-model roster when not configured", () => {
    delete process.env.MEMMY_TOPIC_DECISION_MODELS;
    const root = tempRoot();
    const configPath = join(root, "config.yaml");
    writeFileSync(configPath, YAML.stringify({ memmyMemory: {} }));

    const { config } = loadMemmyConfig(configPath);
    expect(config.algorithm.topicDecisions?.models).toEqual([
      "MiniMax-M2.5",
      "qwen3.7-plus",
      "kimi-k2.5",
      "glm-5"
    ]);
  });
});

describe("TopicDecisionService.recommendAgents", () => {
  it("returns four default roles in stable order", async () => {
    const { service } = await setupService();
    const namespace: RuntimeNamespace = { source: "test", profileId: "test-profile", userId: "user-1" };

    const agents = service.recommendAgents(namespace, "topic-1");

    expect(agents.length).toBeGreaterThanOrEqual(3);
    expect(agents.length).toBeLessThanOrEqual(5);
    const roles = agents.map((a) => a.role);
    expect(roles.slice(0, 4)).toEqual(["evidence_analyst", "domain_analyst", "risk_challenger", "action_planner"]);
  });

  it("adds at most one specialist from topic signals", async () => {
    const { service, repos, namespaceId } = await setupService();

    // Create topic with specialist signal in metadata
    repos.topics.insertTopic({
      id: "topic-1",
      namespaceId,
      title: "Test Topic",
      summary: "Test summary",
      status: "active",
      version: 1,
      sourceMemoryIds: [],
      metadata: { specialist: "security_expert" },
      createdAt: nowIso(),
      updatedAt: nowIso()
    });

    const namespace: RuntimeNamespace = { source: "test", profileId: "test-profile", userId: "user-1" };
    const agents = service.recommendAgents(namespace, "topic-1");

    const specialists = agents.filter((a) => a.role === "specialist");
    expect(specialists.length).toBeLessThanOrEqual(1);
  });

  it("never duplicates role-model pairs without reason", async () => {
    const { service } = await setupService();
    const namespace: RuntimeNamespace = { source: "test", profileId: "test-profile", userId: "user-1" };

    const agents = service.recommendAgents(namespace, "topic-1");

    const seen = new Set<string>();
    for (const agent of agents) {
      const key = `${agent.role}:${agent.model}`;
      if (!agent.reason || agent.reason.trim() === "") {
        expect(seen.has(key)).toBe(false);
      }
      seen.add(key);
    }
  });
});

describe("TopicDecisionService.start", () => {
  it("throws feature disabled when flag is off", async () => {
    delete process.env.MEMMY_TOPIC_DECISIONS_ENABLED;
    const { service } = await setupService();
    const namespace: RuntimeNamespace = { source: "test", profileId: "test-profile", userId: "user-1" };

    expect(() => service.startTopicDecisionSession({ namespace, topicId: "topic-1" }))
      .toThrow("topic decisions disabled");
  });

  it("throws not found for cross-namespace topic", async () => {
    const { service } = await setupService();
    const namespace: RuntimeNamespace = { source: "test", profileId: "test-profile", userId: "user-1" };

    expect(() => service.startTopicDecisionSession({ namespace, topicId: "topic-1" }))
      .toThrow("topic not found");
  });

  it("creates snapshot with topic version, evidence hashes, and inputHash", async () => {
    const { service, repos, namespaceId } = await setupService();

    // Create topic and evidence
    repos.topics.insertTopic({
      id: "topic-2",
      namespaceId,
      title: "Test Topic",
      summary: "Test summary",
      status: "active",
      version: 3,
      sourceMemoryIds: [],
      metadata: {},
      createdAt: nowIso(),
      updatedAt: nowIso()
    });

    repos.topics.insertEvidence({
      id: "ev-1",
      topicId: "topic-2",
      namespaceId,
      memoryId: "mem-1",
      role: "support",
      summary: "Evidence 1",
      metadata: {},
      createdAt: nowIso()
    });

    const namespace: RuntimeNamespace = { source: "test", profileId: "test-profile", userId: "user-1" };
    const result = service.startTopicDecisionSession({ namespace, topicId: "topic-2" });

    expect(result.session.id).toBeDefined();
    expect(result.session.topicId).toBe("topic-2");
    expect(result.session.namespaceId).toBe(namespaceId);
    expect(result.snapshot.id).toBeDefined();
    expect(result.snapshot.sessionId).toBe(result.session.id);
    expect(result.snapshot.namespaceId).toBe(namespaceId);
    expect(result.reused).toBe(false);

    // Verify snapshot payload
    expect(result.snapshot.payload.topicVersion).toBe(3);
    expect(result.snapshot.payload.evidenceIds).toEqual(["ev-1"]);
    expect(result.snapshot.payload.evidenceHashes).toBeDefined();
    expect(result.snapshot.payload.inputHash).toBeDefined();
    expect(typeof result.snapshot.payload.inputHash).toBe("string");
    expect(result.snapshot.payload.inputHash.length).toBe(64); // sha256 hex
  });

  it("reuses session when same namespace/topic/evidence/roster", async () => {
    const { service, repos, namespaceId } = await setupService();

    repos.topics.insertTopic({
      id: "topic-3",
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

    repos.topics.insertEvidence({
      id: "ev-2",
      topicId: "topic-3",
      namespaceId,
      memoryId: "mem-2",
      role: "support",
      summary: "Evidence",
      metadata: {},
      createdAt: nowIso()
    });

    const agents: TopicAgentSpec[] = [
      { id: "agent-1", role: "evidence_analyst", model: "qwen3.7-plus", reason: "" }
    ];

    const namespace: RuntimeNamespace = { source: "test", profileId: "test-profile", userId: "user-1" };
    const first = service.startTopicDecisionSession({ namespace, topicId: "topic-3", agents });
    const second = service.startTopicDecisionSession({ namespace, topicId: "topic-3", agents });

    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(second.session.id).toBe(first.session.id);
  });

  it("creates new session when evidence changes", async () => {
    const { service, repos, namespaceId } = await setupService();

    repos.topics.insertTopic({
      id: "topic-4",
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

    const agents: TopicAgentSpec[] = [
      { id: "agent-1", role: "evidence_analyst", model: "qwen3.7-plus", reason: "" }
    ];

    const namespace: RuntimeNamespace = { source: "test", profileId: "test-profile", userId: "user-1" };
    const first = service.startTopicDecisionSession({ namespace, topicId: "topic-4", agents });

    // Add evidence after first session
    repos.topics.insertEvidence({
      id: "ev-3",
      topicId: "topic-4",
      namespaceId,
      memoryId: "mem-3",
      role: "support",
      summary: "New evidence",
      metadata: {},
      createdAt: nowIso()
    });

    const second = service.startTopicDecisionSession({ namespace, topicId: "topic-4", agents });

    expect(second.reused).toBe(false);
    expect(second.session.id).not.toBe(first.session.id);
  });

  it("throws for cross-namespace evidence", async () => {
    const { service, repos, namespaceId } = await setupService();
    const otherNamespace: RuntimeNamespace = { source: "test", profileId: "other-profile", userId: "user-2" };
    const otherNamespaceId = stableHash(otherNamespace);

    repos.topics.insertTopic({
      id: "topic-5",
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

    // Evidence linked to topic but in wrong namespace - must throw, not filter
    repos.topics.insertEvidence({
      id: "ev-cross",
      topicId: "topic-5",
      namespaceId: otherNamespaceId,
      memoryId: "mem-cross",
      role: "support",
      summary: "Cross evidence",
      metadata: {},
      createdAt: nowIso()
    });

    const namespace: RuntimeNamespace = { source: "test", profileId: "test-profile", userId: "user-1" };
    expect(() => service.startTopicDecisionSession({ namespace, topicId: "topic-5" }))
      .toThrow("evidence not found in namespace: ev-cross");
  });

  it("starts session with empty evidence when topic has no evidence attached", async () => {
    const { service, repos, namespaceId } = await setupService();

    repos.topics.insertTopic({
      id: "topic-no-evidence",
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

    const namespace: RuntimeNamespace = { source: "test", profileId: "test-profile", userId: "user-1" };
    const result = service.startTopicDecisionSession({ namespace, topicId: "topic-no-evidence" });
    expect(result.session.topicId).toBe("topic-no-evidence");
    expect(result.snapshot.payload.evidenceIds).toEqual([]);
  });

  it("includes project constraints in snapshot", async () => {
    const { service, repos, namespaceId } = await setupService({ projectId: "proj-1" });

    repos.topics.insertTopic({
      id: "topic-6",
      namespaceId,
      projectId: "proj-1",
      title: "Test Topic",
      summary: "Test summary",
      status: "active",
      version: 1,
      sourceMemoryIds: [],
      metadata: {},
      createdAt: nowIso(),
      updatedAt: nowIso()
    });

    // Create project context constraint
    repos.projectContext.insertGoal({
      id: "goal-1",
      namespaceId,
      projectId: "proj-1",
      userId: "user-1",
      title: "Project Goal",
      summary: "Goal summary",
      detail: "Goal description",
      acceptanceCriteria: [],
      constraints: [],
      status: "active",
      version: 1,
      sourceMemoryIds: [],
      provenance: {},
      createdAt: nowIso(),
      updatedAt: nowIso()
    });

    const namespace: RuntimeNamespace = { source: "test", profileId: "test-profile", userId: "user-1", projectId: "proj-1" };
    const result = service.startTopicDecisionSession({ namespace, topicId: "topic-6" });

    expect(result.snapshot.payload.projectConstraints).toBeDefined();
    expect(Array.isArray(result.snapshot.payload.projectConstraints)).toBe(true);
  });

  it("includes roster in snapshot and inputHash", async () => {
    const { service, repos, namespaceId } = await setupService();

    repos.topics.insertTopic({
      id: "topic-7",
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

    const agents: TopicAgentSpec[] = [
      { id: "agent-1", role: "evidence_analyst", model: "qwen3.7-plus", reason: "primary" },
      { id: "agent-2", role: "risk_challenger", model: "MiniMax-M2.5", reason: "adversarial" }
    ];

    const namespace: RuntimeNamespace = { source: "test", profileId: "test-profile", userId: "user-1" };
    const result = service.startTopicDecisionSession({ namespace, topicId: "topic-7", agents });

    expect(result.snapshot.payload.roster).toEqual(agents);
    expect(result.snapshot.payload.inputHash).toBeDefined();
  });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "topic-decision-"));
  roots.push(root);
  return root;
}

function setEnv(name: string, value: string): void {
  if (!(name in envBackup)) envBackup[name] = process.env[name];
  process.env[name] = value;
}

async function setupService(options: { projectId?: string } = {}): Promise<{
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

  const namespace: RuntimeNamespace = {
    source: "test",
    profileId: "test-profile",
    userId: "user-1",
    projectId: options.projectId
  };
  const namespaceId = stableHash(namespace);

  const service = new MemoryService({
    db,
    config,
    configPath,
    mode: "dev"
  });

  return { service, repos, namespaceId, db };
}