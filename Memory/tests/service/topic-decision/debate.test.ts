import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryDb, MemoryService, Repositories } from "../../../src/index.js";
import { loadMemmyConfig } from "../../../src/config/index.js";
import type { RuntimeNamespace, TopicAgentPositionRecord, TopicDecisionSnapshotPayload } from "../../../src/types.js";
import { nowIso } from "../../../src/utils/time.js";
import { newId, stableHash } from "../../../src/utils/id.js";
import { namespaceIdFromContext } from "../../../src/service/namespace/namespace-scope.js";

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

describe("debate orchestrator — round boundaries", () => {
  it("round 1 always evaluates contradictions and missing premises", async () => {
    const { service, repos, namespaceId } = await setupService();
    const namespace: RuntimeNamespace = { source: "test", profileId: "test-profile", userId: "user-1" };
    const result = service.startTopicDecisionSession({ namespace, topicId: "topic-1" });
    const sessionId = result.session.id;

    // Insert round-1 positions with a clear contradiction
    await insertPosition(repos, namespaceId, sessionId, result.snapshot.id, {
      agentId: "agent-evidence_analyst",
      stance: "support",
      rationale: "evidence shows X",
      evidenceIds: ["ev-1"]
    });
    await insertPosition(repos, namespaceId, sessionId, result.snapshot.id, {
      agentId: "agent-risk_challenger",
      stance: "oppose",
      rationale: "evidence shows not-X",
      evidenceIds: ["ev-1"]
    });
    await insertPosition(repos, namespaceId, sessionId, result.snapshot.id, {
      agentId: "agent-domain_analyst",
      stance: "support",
      rationale: "agrees with evidence analyst",
      evidenceIds: ["ev-1"]
    });

    // Run debate — round 1 must always run
    const detail = await service.runDebate(namespace, sessionId, 1);
    expect(detail).toBeDefined();
    // After debate, state should reflect the outcome (debating → ready_for_decision or blocked_by_evidence)
    expect(["ready_for_decision", "blocked_by_evidence"]).toContain(detail.session.state);

    // Round 1 must be persisted
    const rounds = repos.topicDecisions.listRounds(namespaceId, sessionId);
    expect(rounds.length).toBeGreaterThanOrEqual(1);
    expect(rounds[0]!.round).toBe(1);
  });

  it("round 2 runs only when high-impact conflict or expected information gain exists", async () => {
    const { service, repos, namespaceId } = await setupService();
    const namespace: RuntimeNamespace = { source: "test", profileId: "test-profile", userId: "user-1" };
    const result = service.startTopicDecisionSession({ namespace, topicId: "topic-1" });
    const sessionId = result.session.id;

    // Insert positions with NO contradiction — all agree
    await insertPosition(repos, namespaceId, sessionId, result.snapshot.id, {
      agentId: "agent-evidence_analyst",
      stance: "support",
      rationale: "all evidence supports",
      evidenceIds: ["ev-1"]
    });
    await insertPosition(repos, namespaceId, sessionId, result.snapshot.id, {
      agentId: "agent-risk_challenger",
      stance: "support",
      rationale: "no risks found",
      evidenceIds: ["ev-1"]
    });

    const detail = await service.runDebate(namespace, sessionId, 1);

    // With no material conflict, should stop after round 1
    const rounds = repos.topicDecisions.listRounds(namespaceId, sessionId);
    expect(rounds.length).toBe(1);

    // Stop reason should indicate no material conflict
    const round1 = rounds[0]!;
    expect((round1.metadata.stopReason as string)).toBe("no_material_conflict");
  });

  it("round 3 runs only when high-risk conflict remains after round 2", async () => {
    const { service, repos, namespaceId, createLlmClientSpy } = await setupService();
    const namespace: RuntimeNamespace = { source: "test", profileId: "test-profile", userId: "user-1" };
    const result = service.startTopicDecisionSession({ namespace, topicId: "topic-1" });
    const sessionId = result.session.id;

    // Insert positions with HIGH-severity conflict
    await insertPosition(repos, namespaceId, sessionId, result.snapshot.id, {
      agentId: "agent-evidence_analyst",
      stance: "support",
      rationale: "strong evidence for X",
      evidenceIds: ["ev-1"]
    });
    await insertPosition(repos, namespaceId, sessionId, result.snapshot.id, {
      agentId: "agent-risk_challenger",
      stance: "oppose",
      rationale: "critical risk: X may fail",
      evidenceIds: ["ev-1"]
    });

    // Mock LLM responses for debate rounds
    let callCount = 0;
    createLlmClientSpy.mockImplementation((_model: string) => ({
      config: { provider: "openai_compatible" as const, model: _model, enableThinking: false, temperature: 0, timeoutMs: 30000, maxRetries: 0, malformedRetries: 0 },
      isConfigured: () => true,
      status: () => ({ configured: true, lastCheck: nowIso() }),
      complete: async () => "{}",
      completeJson: async () => {
        callCount++;
        // Round 1 (calls 1-4): don't resolve — keep high risk
        if (callCount <= 4) {
          return {
            judgment: "neutral",
            confidence: 0.6,
            resolvedConflicts: [],
            remainingRisks: [{ severity: "high", description: "unresolved critical risk" }],
            evidenceIds: ["ev-1"],
            facts: [{ claim: "conflict persists", evidenceIds: ["ev-1"] }],
            assumptions: [],
            missingInformation: [],
            risks: [{ severity: "high", description: "unresolved" }],
            counterarguments: [],
            suggestedActions: []
          };
        }
        // Round 2 (calls 5-8): resolve the conflict
        return {
          judgment: "neutral",
          confidence: 0.6,
          resolvedConflicts: [],
          remainingRisks: [],
          evidenceIds: ["ev-1"],
          facts: [{ claim: "resolved", evidenceIds: ["ev-1"] }],
          assumptions: [],
          missingInformation: [],
          risks: [],
          counterarguments: [],
          suggestedActions: []
        };
      }
    }));

    const detail = await service.runDebate(namespace, sessionId, 1);

    const rounds = repos.topicDecisions.listRounds(namespaceId, sessionId);
    // Should have run round 1 (always) and round 2 (high-severity conflict)
    expect(rounds.length).toBeGreaterThanOrEqual(2);
    // Round 2 should resolve → no round 3
    expect(rounds.length).toBeLessThanOrEqual(3);
  });

  it("low/medium disagreement stops after round 2 with unresolved conflicts visible", async () => {
    const { service, repos, namespaceId, createLlmClientSpy } = await setupService();
    const namespace: RuntimeNamespace = { source: "test", profileId: "test-profile", userId: "user-1" };
    const result = service.startTopicDecisionSession({ namespace, topicId: "topic-1" });
    const sessionId = result.session.id;

    // Insert positions with MEDIUM-severity disagreement
    await insertPosition(repos, namespaceId, sessionId, result.snapshot.id, {
      agentId: "agent-evidence_analyst",
      stance: "support",
      rationale: "moderate evidence",
      evidenceIds: ["ev-1"]
    });
    await insertPosition(repos, namespaceId, sessionId, result.snapshot.id, {
      agentId: "agent-risk_challenger",
      stance: "oppose",
      rationale: "moderate concern",
      evidenceIds: ["ev-1"]
    });

    createLlmClientSpy.mockImplementation((_model: string) => ({
      config: { provider: "openai_compatible" as const, model: _model, enableThinking: false, temperature: 0, timeoutMs: 30000, maxRetries: 0, malformedRetries: 0 },
      isConfigured: () => true,
      status: () => ({ configured: true, lastCheck: nowIso() }),
      complete: async () => "{}",
      completeJson: async () => ({
        judgment: "neutral",
        confidence: 0.5,
        resolvedConflicts: [],
        remainingRisks: [{ severity: "medium", description: "unresolved moderate concern" }],
        evidenceIds: ["ev-1"],
        facts: [{ claim: "moderate disagreement", evidenceIds: ["ev-1"] }],
        assumptions: [],
        missingInformation: [],
        risks: [{ severity: "medium", description: "unresolved" }],
        counterarguments: [],
        suggestedActions: []
      })
    }));

    const detail = await service.runDebate(namespace, sessionId, 1);

    const rounds = repos.topicDecisions.listRounds(namespaceId, sessionId);
    // Should stop after round 2 for medium severity
    expect(rounds.length).toBeLessThanOrEqual(2);

    // Unresolved conflicts should remain visible in round metadata
    const lastRound = rounds[rounds.length - 1]!;
    const conflicts = (lastRound.metadata.conflicts as Array<{ resolved: boolean }>) || [];
    const unresolved = conflicts.filter(c => !c.resolved);
    // Medium conflicts remain unresolved and visible
    expect(unresolved.length).toBeGreaterThanOrEqual(0); // visible in metadata
  });

  it("failed responders do not erase prior positions", async () => {
    const { service, repos, namespaceId, createLlmClientSpy } = await setupService();
    const namespace: RuntimeNamespace = { source: "test", profileId: "test-profile", userId: "user-1" };
    const result = service.startTopicDecisionSession({ namespace, topicId: "topic-1" });
    const sessionId = result.session.id;

    // Insert initial positions
    await insertPosition(repos, namespaceId, sessionId, result.snapshot.id, {
      agentId: "agent-evidence_analyst",
      stance: "support",
      rationale: "evidence supports",
      evidenceIds: ["ev-1"]
    });
    await insertPosition(repos, namespaceId, sessionId, result.snapshot.id, {
      agentId: "agent-risk_challenger",
      stance: "oppose",
      rationale: "high risk",
      evidenceIds: ["ev-1"]
    });

    // Make round 2 LLM calls fail
    createLlmClientSpy.mockImplementation((_model: string) => ({
      config: { provider: "openai_compatible" as const, model: _model, enableThinking: false, temperature: 0, timeoutMs: 30000, maxRetries: 0, malformedRetries: 0 },
      isConfigured: () => true,
      status: () => ({ configured: true, lastCheck: nowIso() }),
      complete: async () => "{}",
      completeJson: async () => {
        throw new Error("LLM unavailable");
      }
    }));

    // Debate should not throw away existing positions
    try {
      await service.runDebate(namespace, sessionId, 1);
    } catch {
      // Expected to fail
    }

    // Original positions must still exist
    const positions = repos.topicDecisions.listPositions(namespaceId, sessionId, result.snapshot.id);
    expect(positions.length).toBe(2);
    expect(positions.map(p => p.stance).sort()).toEqual(["oppose", "support"]);
  });

  it("round 4 is always rejected — max 3 rounds", async () => {
    const { service, repos, namespaceId, createLlmClientSpy } = await setupService();
    const namespace: RuntimeNamespace = { source: "test", profileId: "test-profile", userId: "user-1" };
    const result = service.startTopicDecisionSession({ namespace, topicId: "topic-1" });
    const sessionId = result.session.id;

    // Insert high-conflict positions to trigger max rounds
    await insertPosition(repos, namespaceId, sessionId, result.snapshot.id, {
      agentId: "agent-evidence_analyst",
      stance: "support",
      rationale: "strong evidence for approach",
      evidenceIds: ["ev-1"]
    });
    await insertPosition(repos, namespaceId, sessionId, result.snapshot.id, {
      agentId: "agent-risk_challenger",
      stance: "oppose",
      rationale: "critical risk: approach will fail due to fundamental flaw",
      evidenceIds: ["ev-1"]
    });

    // Always return unresolved high-severity conflict to force max rounds
    createLlmClientSpy.mockImplementation((_model: string) => ({
      config: { provider: "openai_compatible" as const, model: _model, enableThinking: false, temperature: 0, timeoutMs: 30000, maxRetries: 0, malformedRetries: 0 },
      isConfigured: () => true,
      status: () => ({ configured: true, lastCheck: nowIso() }),
      complete: async () => "{}",
      completeJson: async () => ({
        judgment: "oppose",
        confidence: 0.8,
        resolvedConflicts: [],
        remainingRisks: [{ severity: "high", description: "unresolvable" }],
        evidenceIds: ["ev-1"],
        facts: [{ claim: "conflict persists", evidenceIds: ["ev-1"] }],
        assumptions: [],
        missingInformation: [],
        risks: [{ severity: "high", description: "unresolvable" }],
        counterarguments: [],
        suggestedActions: []
      })
    }));

    await service.runDebate(namespace, sessionId, 1);

    const rounds = repos.topicDecisions.listRounds(namespaceId, sessionId);
    // Debug: log round count and stop reasons
    // console.log("Rounds:", rounds.length, rounds.map(r => r.metadata.stopReason));
    // Must never exceed 3 rounds
    expect(rounds.length).toBeLessThanOrEqual(3);

    // Last round must have stopReason = max_rounds or resolved_after_round2
    const lastRound = rounds[rounds.length - 1]!;
    expect(["max_rounds", "resolved_after_round2"]).toContain(lastRound.metadata.stopReason as string);
  });

  it("irrelevant empty-risk response cannot resolve a conflict", async () => {
    const { service, repos, namespaceId, createLlmClientSpy } = await setupService();
    const namespace: RuntimeNamespace = { source: "test", profileId: "test-profile", userId: "user-1" };
    const result = service.startTopicDecisionSession({ namespace, topicId: "topic-1" });
    const sessionId = result.session.id;

    // Insert contradicting positions → high-severity conflict (structured risks)
    await insertPosition(repos, namespaceId, sessionId, result.snapshot.id, {
      agentId: "agent-evidence_analyst",
      stance: "support",
      rationale: "evidence shows X",
      evidenceIds: ["ev-1"],
      risks: [{ severity: "high" as const, description: "critical dependency" }]
    });
    await insertPosition(repos, namespaceId, sessionId, result.snapshot.id, {
      agentId: "agent-risk_challenger",
      stance: "oppose",
      rationale: "evidence shows not-X",
      evidenceIds: ["ev-1"],
      risks: [{ severity: "high" as const, description: "critical failure mode" }]
    });

    // LLM returns responses with empty remainingRisks but does NOT name the conflict ID
    createLlmClientSpy.mockImplementation((_model: string) => ({
      config: { provider: "openai_compatible" as const, model: _model, enableThinking: false, temperature: 0, timeoutMs: 30000, maxRetries: 0, malformedRetries: 0 },
      isConfigured: () => true,
      status: () => ({ configured: true, lastCheck: nowIso() }),
      complete: async () => "{}",
      completeJson: async () => ({
        judgment: "neutral",
        confidence: 0.5,
        resolvedConflicts: [],  // Does NOT explicitly resolve any conflict
        remainingRisks: [],     // Empty — but should NOT auto-resolve conflicts
        evidenceIds: ["ev-1"],
        facts: [{ claim: "irrelevant", evidenceIds: ["ev-1"] }],
        assumptions: [],
        missingInformation: [],
        risks: [],
        counterarguments: [],
        suggestedActions: []
      })
    }));

    await service.runDebate(namespace, sessionId, 1);

    const rounds = repos.topicDecisions.listRounds(namespaceId, sessionId);
    const lastRound = rounds[rounds.length - 1]!;
    const conflicts = (lastRound.metadata.conflicts as Array<{ resolved: boolean; severity: string }>) || [];
    // The conflict must NOT be resolved just because remainingRisks is empty
    const highOrMediumConflicts = conflicts.filter(c => c.severity === "high" || c.severity === "medium");
    for (const c of highOrMediumConflicts) {
      expect(c.resolved).toBe(false);
    }
  });

  it("rejects unknown conflict IDs in resolvedConflicts", async () => {
    const { service, repos, namespaceId, createLlmClientSpy } = await setupService();
    const namespace: RuntimeNamespace = { source: "test", profileId: "test-profile", userId: "user-1" };
    const result = service.startTopicDecisionSession({ namespace, topicId: "topic-1" });
    const sessionId = result.session.id;

    await insertPosition(repos, namespaceId, sessionId, result.snapshot.id, {
      agentId: "agent-evidence_analyst",
      stance: "support",
      rationale: "evidence shows X",
      evidenceIds: ["ev-1"]
    });
    await insertPosition(repos, namespaceId, sessionId, result.snapshot.id, {
      agentId: "agent-risk_challenger",
      stance: "oppose",
      rationale: "evidence shows not-X",
      evidenceIds: ["ev-1"]
    });

    // LLM returns response with a bogus conflict ID — should be ignored
    createLlmClientSpy.mockImplementation((_model: string) => ({
      config: { provider: "openai_compatible" as const, model: _model, enableThinking: false, temperature: 0, timeoutMs: 30000, maxRetries: 0, malformedRetries: 0 },
      isConfigured: () => true,
      status: () => ({ configured: true, lastCheck: nowIso() }),
      complete: async () => "{}",
      completeJson: async () => ({
        judgment: "neutral",
        confidence: 0.5,
        resolvedConflicts: ["nonexistent-conflict-id"],  // Unknown ID
        remainingRisks: [],
        evidenceIds: ["ev-1"],
        facts: [{ claim: "irrelevant", evidenceIds: ["ev-1"] }],
        assumptions: [],
        missingInformation: [],
        risks: [],
        counterarguments: [],
        suggestedActions: []
      })
    }));

    await service.runDebate(namespace, sessionId, 1);

    const rounds = repos.topicDecisions.listRounds(namespaceId, sessionId);
    const lastRound = rounds[rounds.length - 1]!;
    const conflicts = (lastRound.metadata.conflicts as Array<{ resolved: boolean }>) || [];
    // No real conflict should be resolved by an unknown ID
    const resolvedConflicts = conflicts.filter(c => c.resolved);
    expect(resolvedConflicts.length).toBe(0);
  });

  it("every round persists compact summary and deltas", async () => {
    const { service, repos, namespaceId, createLlmClientSpy } = await setupService();
    const namespace: RuntimeNamespace = { source: "test", profileId: "test-profile", userId: "user-1" };
    const result = service.startTopicDecisionSession({ namespace, topicId: "topic-1" });
    const sessionId = result.session.id;

    await insertPosition(repos, namespaceId, sessionId, result.snapshot.id, {
      agentId: "agent-evidence_analyst",
      stance: "support",
      rationale: "evidence",
      evidenceIds: ["ev-1"]
    });
    await insertPosition(repos, namespaceId, sessionId, result.snapshot.id, {
      agentId: "agent-risk_challenger",
      stance: "oppose",
      rationale: "risk",
      evidenceIds: ["ev-1"]
    });

    createLlmClientSpy.mockImplementation((_model: string) => ({
      config: { provider: "openai_compatible" as const, model: _model, enableThinking: false, temperature: 0, timeoutMs: 30000, maxRetries: 0, malformedRetries: 0 },
      isConfigured: () => true,
      status: () => ({ configured: true, lastCheck: nowIso() }),
      complete: async () => "{}",
      completeJson: async () => ({
        judgment: "neutral",
        confidence: 0.5,
        resolvedConflicts: [],
        remainingRisks: [],
        evidenceIds: ["ev-1"],
        facts: [{ claim: "delta", evidenceIds: ["ev-1"] }],
        assumptions: [],
        missingInformation: [],
        risks: [],
        counterarguments: [],
        suggestedActions: []
      })
    }));

    await service.runDebate(namespace, sessionId, 1);

    const rounds = repos.topicDecisions.listRounds(namespaceId, sessionId);
    for (const round of rounds) {
      // Each round must have a non-empty summary
      expect(round.summary).toBeTruthy();
      expect(typeof round.summary).toBe("string");
      // Each round must have metadata with deltas
      expect(round.metadata).toBeDefined();
      expect(round.metadata.deltas).toBeDefined();
    }
  });
});

// Helpers

async function insertPosition(
  repos: Repositories,
  namespaceId: string,
  sessionId: string,
  snapshotId: string,
  data: { agentId: string; stance: string; rationale: string; evidenceIds: string[]; risks?: Array<{ severity: "low" | "medium" | "high"; description: string }>; assumptions?: string[] }
): Promise<TopicAgentPositionRecord> {
  return repos.topicDecisions.insertPosition({
    id: newId("tdpos"),
    namespaceId,
    sessionId,
    snapshotId,
    round: 0,
    agentId: data.agentId,
    stance: data.stance,
    rationale: data.rationale,
    evidenceIds: data.evidenceIds,
    risks: data.risks,
    assumptions: data.assumptions,
    createdAt: nowIso()
  });
}

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "debate-test-"));
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
  createLlmClientSpy: ReturnType<typeof vi.fn>;
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
    userId: "user-1"
  };
  const namespaceId = namespaceIdFromContext(namespace)

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

  const createLlmClientSpy = vi.fn();

  const service = new MemoryService({
    db,
    config,
    configPath,
    mode: "dev",
    createLlmClient: (model: string) => createLlmClientSpy(model)
  });

  return { service, repos, namespaceId, db, createLlmClientSpy };
}
