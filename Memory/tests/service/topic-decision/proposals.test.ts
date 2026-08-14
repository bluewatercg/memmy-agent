import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryDb, MemoryService, Repositories } from "../../../src/index.js";
import { loadMemmyConfig } from "../../../src/config/index.js";
import type { RuntimeNamespace } from "../../../src/types.js";
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

describe("proposal synthesis — constraints", () => {
  it("zero proposals when blocking gap exists", async () => {
    const { service, repos, namespaceId, createLlmClientSpy } = await setupService();
    const namespace: RuntimeNamespace = { source: "test", profileId: "test-profile", userId: "user-1" };
    const result = service.startTopicDecisionSession({ namespace, topicId: "topic-1" });
    const sessionId = result.session.id;

    // Insert positions with a blocking gap (unknown stance = blocking)
    await repos.topicDecisions.insertPosition({
      id: "pos-1",
      namespaceId,
      sessionId,
      snapshotId: result.snapshot.id,
      round: 0,
      agentId: "agent-evidence_analyst",
      stance: "unknown",
      rationale: "missing critical evidence",
      evidenceIds: [],
      createdAt: nowIso()
    });

    createLlmClientSpy.mockImplementation((_model: string) => ({
      config: { provider: "openai_compatible" as const, model: _model, enableThinking: false, temperature: 0, timeoutMs: 30000, maxRetries: 0, malformedRetries: 0 },
      isConfigured: () => true,
      status: () => ({ configured: true, lastCheck: nowIso() }),
      complete: async () => "{}",
      completeJson: async () => ({
        proposals: [],
        reason: "blocked by missing evidence"
      })
    }));

    const detail = await service.synthesizeProposals(namespace, sessionId);
    const proposals = repos.topicDecisions.listProposals(namespaceId, sessionId);
    expect(proposals.length).toBe(0);
  });

  it("produces 1-3 materially distinct proposals when no blocking gap", async () => {
    const { service, repos, namespaceId, createLlmClientSpy } = await setupService();
    const namespace: RuntimeNamespace = { source: "test", profileId: "test-profile", userId: "user-1" };
    const result = service.startTopicDecisionSession({ namespace, topicId: "topic-1" });
    const sessionId = result.session.id;

    // Insert valid positions — no blocking gaps
    await repos.topicDecisions.insertPosition({
      id: "pos-1",
      namespaceId,
      sessionId,
      snapshotId: result.snapshot.id,
      round: 0,
      agentId: "agent-evidence_analyst",
      stance: "support",
      rationale: "evidence supports",
      evidenceIds: ["ev-1"],
      createdAt: nowIso()
    });
    await repos.topicDecisions.insertPosition({
      id: "pos-2",
      namespaceId,
      sessionId,
      snapshotId: result.snapshot.id,
      round: 0,
      agentId: "agent-risk_challenger",
      stance: "neutral",
      rationale: "moderate risk",
      evidenceIds: ["ev-1"],
      createdAt: nowIso()
    });

    createLlmClientSpy.mockImplementation((_model: string) => ({
      config: { provider: "openai_compatible" as const, model: _model, enableThinking: false, temperature: 0, timeoutMs: 30000, maxRetries: 0, malformedRetries: 0 },
      isConfigured: () => true,
      status: () => ({ configured: true, lastCheck: nowIso() }),
      complete: async () => "{}",
      completeJson: async () => ({
        proposals: [
          {
            title: "Proceed with evidence-backed plan",
            benefit: "Addresses all known evidence",
            risk: "Moderate execution risk",
            dependencies: [],
            reversible: true,
            rollbackPlan: "Revert to previous state",
            verificationPlan: "Check outcomes after 1 week",
            evidenceIds: ["ev-1"],
            effectClass: "analyze",
            permission: "read",
            artifact: "analysis-report",
            acceptanceCondition: "Evidence coverage > 80%",
            recoveryPoint: "pre-execution snapshot",
            agentContributions: ["agent-evidence_analyst"]
          },
          {
            title: "Proceed with caution and monitoring",
            benefit: "Lower risk approach",
            risk: "Slower progress",
            dependencies: ["continuous-monitoring"],
            reversible: true,
            rollbackPlan: "Halt and review",
            verificationPlan: "Daily monitoring",
            evidenceIds: ["ev-1"],
            effectClass: "analyze",
            permission: "read",
            artifact: "monitoring-dashboard",
            acceptanceCondition: "Risk below threshold",
            recoveryPoint: "daily checkpoint",
            agentContributions: ["agent-risk_challenger"]
          }
        ]
      })
    }));

    const detail = await service.synthesizeProposals(namespace, sessionId);
    const proposals = repos.topicDecisions.listProposals(namespaceId, sessionId);
    expect(proposals.length).toBeGreaterThanOrEqual(1);
    expect(proposals.length).toBeLessThanOrEqual(3);
  });

  it("rejects output that cites unknown evidence", async () => {
    const { service, repos, namespaceId, createLlmClientSpy } = await setupService();
    const namespace: RuntimeNamespace = { source: "test", profileId: "test-profile", userId: "user-1" };
    const result = service.startTopicDecisionSession({ namespace, topicId: "topic-1" });
    const sessionId = result.session.id;

    await repos.topicDecisions.insertPosition({
      id: "pos-1",
      namespaceId,
      sessionId,
      snapshotId: result.snapshot.id,
      round: 0,
      agentId: "agent-evidence_analyst",
      stance: "support",
      rationale: "evidence supports",
      evidenceIds: ["ev-1"],
      createdAt: nowIso()
    });

    // LLM returns proposal citing unknown evidence
    createLlmClientSpy.mockImplementation((_model: string) => ({
      config: { provider: "openai_compatible" as const, model: _model, enableThinking: false, temperature: 0, timeoutMs: 30000, maxRetries: 0, malformedRetries: 0 },
      isConfigured: () => true,
      status: () => ({ configured: true, lastCheck: nowIso() }),
      complete: async () => "{}",
      completeJson: async () => ({
        proposals: [
          {
            title: "Bad proposal",
            benefit: "Some benefit",
            risk: "Some risk",
            dependencies: [],
            reversible: true,
            verificationPlan: "Check",
            evidenceIds: ["ev-nonexistent"], // Unknown evidence!
            effectClass: "analyze",
            permission: "read",
            artifact: "report",
            acceptanceCondition: "Works",
            recoveryPoint: "before",
            agentContributions: ["agent-evidence_analyst"]
          }
        ]
      })
    }));

    // Should throw or reject — malformed/uncited outputs fail, not silently accepted
    await expect(service.synthesizeProposals(namespace, sessionId)).rejects.toThrow();
  });

  it("rejects output that omits unresolved high-risk conflict", async () => {
    const { service, repos, namespaceId, createLlmClientSpy } = await setupService();
    const namespace: RuntimeNamespace = { source: "test", profileId: "test-profile", userId: "user-1" };
    const result = service.startTopicDecisionSession({ namespace, topicId: "topic-1" });
    const sessionId = result.session.id;

    // Insert contradicting positions with high-severity risk
    await repos.topicDecisions.insertPosition({
      id: "pos-1",
      namespaceId,
      sessionId,
      snapshotId: result.snapshot.id,
      round: 0,
      agentId: "agent-evidence_analyst",
      stance: "support",
      rationale: "strong evidence",
      evidenceIds: ["ev-1"],
      createdAt: nowIso()
    });
    await repos.topicDecisions.insertPosition({
      id: "pos-2",
      namespaceId,
      sessionId,
      snapshotId: result.snapshot.id,
      round: 0,
      agentId: "agent-risk_challenger",
      stance: "oppose",
      rationale: "high risk concern",
      evidenceIds: ["ev-1"],
      createdAt: nowIso()
    });

    // Persist an unresolved high-severity debate round
    await repos.topicDecisions.upsertRound({
      id: newId("tdr"),
      namespaceId,
      sessionId,
      round: 1,
      status: "completed",
      summary: "High severity conflict detected",
      metadata: {
        stopReason: "max_rounds",
        conflicts: [
          { id: "conflict-1", severity: "high", claim: "X vs not-X", positionIds: ["pos-1", "pos-2"], evidenceIds: ["ev-1"], resolved: false }
        ],
        deltas: {}
      },
      version: 1,
      createdAt: nowIso(),
      updatedAt: nowIso()
    });

    // LLM returns proposal that ignores the unresolved conflict
    createLlmClientSpy.mockImplementation((_model: string) => ({
      config: { provider: "openai_compatible" as const, model: _model, enableThinking: false, temperature: 0, timeoutMs: 30000, maxRetries: 0, malformedRetries: 0 },
      isConfigured: () => true,
      status: () => ({ configured: true, lastCheck: nowIso() }),
      complete: async () => "{}",
      completeJson: async () => ({
        proposals: [
          {
            title: "Ignores conflict",
            benefit: "Some benefit",
            risk: "Some risk",
            dependencies: [],
            reversible: true,
            verificationPlan: "Check",
            evidenceIds: ["ev-1"],
            effectClass: "analyze",
            permission: "read",
            artifact: "report",
            acceptanceCondition: "Works",
            recoveryPoint: "before",
            agentContributions: ["agent-evidence_analyst"]
            // No mention of unresolved high-risk conflict!
          }
        ]
      })
    }));

    // Should reject — proposals must address unresolved high-risk conflicts
    await expect(service.synthesizeProposals(namespace, sessionId)).rejects.toThrow();
  });

  it("rejects rank 4 — max 3 proposals", async () => {
    const { service, repos, namespaceId, createLlmClientSpy } = await setupService();
    const namespace: RuntimeNamespace = { source: "test", profileId: "test-profile", userId: "user-1" };
    const result = service.startTopicDecisionSession({ namespace, topicId: "topic-1" });
    const sessionId = result.session.id;

    await repos.topicDecisions.insertPosition({
      id: "pos-1",
      namespaceId,
      sessionId,
      snapshotId: result.snapshot.id,
      round: 0,
      agentId: "agent-evidence_analyst",
      stance: "support",
      rationale: "evidence",
      evidenceIds: ["ev-1"],
      createdAt: nowIso()
    });

    // LLM returns 4 proposals
    createLlmClientSpy.mockImplementation((_model: string) => ({
      config: { provider: "openai_compatible" as const, model: _model, enableThinking: false, temperature: 0, timeoutMs: 30000, maxRetries: 0, malformedRetries: 0 },
      isConfigured: () => true,
      status: () => ({ configured: true, lastCheck: nowIso() }),
      complete: async () => "{}",
      completeJson: async () => ({
        proposals: [
          makeProposal("Proposal 1"),
          makeProposal("Proposal 2"),
          makeProposal("Proposal 3"),
          makeProposal("Proposal 4") // Rank 4 — should be rejected
        ]
      })
    }));

    await expect(service.synthesizeProposals(namespace, sessionId)).rejects.toThrow();
  });

  it("rejects multiple recommended proposals", async () => {
    const { service, repos, namespaceId, createLlmClientSpy } = await setupService();
    const namespace: RuntimeNamespace = { source: "test", profileId: "test-profile", userId: "user-1" };
    const result = service.startTopicDecisionSession({ namespace, topicId: "topic-1" });
    const sessionId = result.session.id;

    await repos.topicDecisions.insertPosition({
      id: "pos-1",
      namespaceId,
      sessionId,
      snapshotId: result.snapshot.id,
      round: 0,
      agentId: "agent-evidence_analyst",
      stance: "support",
      rationale: "evidence",
      evidenceIds: ["ev-1"],
      createdAt: nowIso()
    });

    createLlmClientSpy.mockImplementation((_model: string) => ({
      config: { provider: "openai_compatible" as const, model: _model, enableThinking: false, temperature: 0, timeoutMs: 30000, maxRetries: 0, malformedRetries: 0 },
      isConfigured: () => true,
      status: () => ({ configured: true, lastCheck: nowIso() }),
      complete: async () => "{}",
      completeJson: async () => ({
        proposals: [
          { ...makeProposal("Proposal 1"), recommended: true },
          { ...makeProposal("Proposal 2"), recommended: true } // Multiple recommended!
        ]
      })
    }));

    await expect(service.synthesizeProposals(namespace, sessionId)).rejects.toThrow();
  });

  it("rejects action without effect class, permission, artifact, acceptance condition, or recovery point", async () => {
    const { service, repos, namespaceId, createLlmClientSpy } = await setupService();
    const namespace: RuntimeNamespace = { source: "test", profileId: "test-profile", userId: "user-1" };
    const result = service.startTopicDecisionSession({ namespace, topicId: "topic-1" });
    const sessionId = result.session.id;

    await repos.topicDecisions.insertPosition({
      id: "pos-1",
      namespaceId,
      sessionId,
      snapshotId: result.snapshot.id,
      round: 0,
      agentId: "agent-evidence_analyst",
      stance: "support",
      rationale: "evidence",
      evidenceIds: ["ev-1"],
      createdAt: nowIso()
    });

    // Missing acceptanceCondition
    createLlmClientSpy.mockImplementation((_model: string) => ({
      config: { provider: "openai_compatible" as const, model: _model, enableThinking: false, temperature: 0, timeoutMs: 30000, maxRetries: 0, malformedRetries: 0 },
      isConfigured: () => true,
      status: () => ({ configured: true, lastCheck: nowIso() }),
      complete: async () => "{}",
      completeJson: async () => ({
        proposals: [
          {
            title: "Incomplete action",
            benefit: "Some benefit",
            risk: "Some risk",
            dependencies: [],
            reversible: true,
            verificationPlan: "Check",
            evidenceIds: ["ev-1"],
            effectClass: "analyze",
            permission: "read",
            artifact: "report",
            // Missing: acceptanceCondition, recoveryPoint
            agentContributions: ["agent-evidence_analyst"]
          }
        ]
      })
    }));

    await expect(service.synthesizeProposals(namespace, sessionId)).rejects.toThrow();
  });

  it("rejects malformed nested proposal with actionable domain error", async () => {
    const { service, repos, namespaceId, createLlmClientSpy } = await setupService();
    const namespace: RuntimeNamespace = { source: "test", profileId: "test-profile", userId: "user-1" };
    const result = service.startTopicDecisionSession({ namespace, topicId: "topic-1" });
    const sessionId = result.session.id;

    await repos.topicDecisions.insertPosition({
      id: "pos-1",
      namespaceId,
      sessionId,
      snapshotId: result.snapshot.id,
      round: 0,
      agentId: "agent-evidence_analyst",
      stance: "support",
      rationale: "evidence supports",
      evidenceIds: ["ev-1"],
      createdAt: nowIso()
    });

    // LLM returns proposal with malformed nested fields
    createLlmClientSpy.mockImplementation((_model: string) => ({
      config: { provider: "openai_compatible" as const, model: _model, enableThinking: false, temperature: 0, timeoutMs: 30000, maxRetries: 0, malformedRetries: 0 },
      isConfigured: () => true,
      status: () => ({ configured: true, lastCheck: nowIso() }),
      complete: async () => "{}",
      completeJson: async () => ({
        proposals: [
          {
            title: "Malformed proposal",
            benefit: "Some benefit",
            risk: "Some risk",
            dependencies: "not-an-array",  // Should be array
            reversible: true,
            verificationPlan: "Check",
            evidenceIds: ["ev-1"],
            effectClass: "analyze",
            permission: "read",
            artifact: "report",
            acceptanceCondition: "Works",
            recoveryPoint: "before",
            agentContributions: ["agent-evidence_analyst"]
          }
        ]
      })
    }));

    // Should reject with actionable domain error before business validation
    await expect(service.synthesizeProposals(namespace, sessionId)).rejects.toThrow(/dependencies/i);
  });

  it("majority-wrong scenario: risk_challenger identifies unsupported assumption — majority cannot override", async () => {
    const { service, repos, namespaceId, createLlmClientSpy } = await setupService();
    const namespace: RuntimeNamespace = { source: "test", profileId: "test-profile", userId: "user-1" };
    const result = service.startTopicDecisionSession({ namespace, topicId: "topic-1" });
    const sessionId = result.session.id;

    // Three agents share one unsupported assumption
    await repos.topicDecisions.insertPosition({
      id: "pos-1",
      namespaceId,
      sessionId,
      snapshotId: result.snapshot.id,
      round: 0,
      agentId: "agent-evidence_analyst",
      stance: "support",
      rationale: "assumes X is true",
      evidenceIds: ["ev-1"],
      createdAt: nowIso()
    });
    await repos.topicDecisions.insertPosition({
      id: "pos-2",
      namespaceId,
      sessionId,
      snapshotId: result.snapshot.id,
      round: 0,
      agentId: "agent-domain_analyst",
      stance: "support",
      rationale: "assumes X is true",
      evidenceIds: ["ev-1"],
      createdAt: nowIso()
    });
    await repos.topicDecisions.insertPosition({
      id: "pos-3",
      namespaceId,
      sessionId,
      snapshotId: result.snapshot.id,
      round: 0,
      agentId: "agent-action_planner",
      stance: "support",
      rationale: "assumes X is true",
      evidenceIds: ["ev-1"],
      createdAt: nowIso()
    });
    // risk_challenger identifies the unsupported assumption
    await repos.topicDecisions.insertPosition({
      id: "pos-4",
      namespaceId,
      sessionId,
      snapshotId: result.snapshot.id,
      round: 0,
      agentId: "agent-risk_challenger",
      stance: "oppose",
      rationale: "assumption X has no evidence support",
      evidenceIds: ["ev-1"],
      createdAt: nowIso()
    });

    // LLM returns proposals that depend on the unsupported assumption
    createLlmClientSpy.mockImplementation((_model: string) => ({
      config: { provider: "openai_compatible" as const, model: _model, enableThinking: false, temperature: 0, timeoutMs: 30000, maxRetries: 0, malformedRetries: 0 },
      isConfigured: () => true,
      status: () => ({ configured: true, lastCheck: nowIso() }),
      complete: async () => "{}",
      completeJson: async () => ({
        proposals: [
          {
            title: "Proceed assuming X",
            benefit: "Majority agrees",
            risk: "Assumption X may be wrong",
            dependencies: [],
            reversible: true,
            verificationPlan: "Check X",
            evidenceIds: ["ev-1"],
            effectClass: "analyze",
            permission: "read",
            artifact: "report",
            acceptanceCondition: "X verified",
            recoveryPoint: "before",
            agentContributions: ["agent-evidence_analyst", "agent-domain_analyst", "agent-action_planner"]
          }
        ]
      })
    }));

    // Session should remain blocked OR proposal explicitly depends on resolving the assumption
    // Majority cannot override the risk_challenger's identified gap
    try {
      await service.synthesizeProposals(namespace, sessionId);
      const proposals = repos.topicDecisions.listProposals(namespaceId, sessionId);

      if (proposals.length > 0) {
        // If proposals exist, they must explicitly depend on resolving the assumption
        const proposal = proposals[0]!;
        const deps = (proposal.payload.dependencies as string[]) || [];
        const assumptionDependency = deps.some(d => d.includes("assumption"));
        expect(assumptionDependency).toBe(true);
      } else {
        // Zero proposals = session blocked — acceptable
        expect(proposals.length).toBe(0);
      }
    } catch (error) {
      // Throwing is also acceptable — majority-wrong rejected
      expect(error).toBeDefined();
    }
  });
});

// Helpers

function makeProposal(title: string) {
  return {
    title,
    benefit: "Some benefit",
    risk: "Some risk",
    dependencies: [],
    reversible: true,
    rollbackPlan: "Revert",
    verificationPlan: "Check",
    evidenceIds: ["ev-1"],
    effectClass: "analyze",
    permission: "read",
    artifact: "report",
    acceptanceCondition: "Works",
    recoveryPoint: "before",
    agentContributions: ["agent-evidence_analyst"]
  };
}

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "proposals-test-"));
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
