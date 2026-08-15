import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryDb, MemoryService, type MemoryAssetRecord, type MemoryRow } from "../../../src/index.js";
import { AgentLoadoutService } from "../../../src/service/assets/agent-loadout-service.js";
import { TemporalValidityService } from "../../../src/service/assets/temporal-validity-service.js";
import { Repositories } from "../../../src/storage/repositories.js";
import { createCapturingEmbedder } from "../../fixtures/memory-service-fixture.js";

const NOW = "2026-08-15T12:00:00.000Z";
const REVIEW_DUE_AT = "2026-08-14T12:00:00.000Z";
const ALPHA = "local:project-a";
const NAMESPACE = { source: "local", profileId: "default", userId: "user-a", projectId: "project-a" };
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function memory(id: string): MemoryRow {
  return {
    id,
    timeline: NOW,
    userId: "user-a",
    agentId: "agent-codex",
    appId: "project-a",
    memoryType: "LongTermMemory",
    status: "activated",
    visibility: "private",
    memoryKey: `skill:${id}`,
    memoryValue: `${id} governed procedure`,
    tags: ["asset-recall"],
    info: { project_id: "project-a", profile_id: "default" },
    properties: { internal_info: { memory_layer: "Skill", memory_kind: "skill" } },
    memoryLayer: "Skill",
    contentHash: `${id}-hash`,
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null
  };
}

function asset(memoryId: string, overrides: Partial<MemoryAssetRecord> = {}): MemoryAssetRecord {
  return {
    id: `asset-${memoryId}`,
    namespaceId: ALPHA,
    assetType: "skill",
    stableKey: `skill/${memoryId}`,
    version: 1,
    status: "active",
    title: `${memoryId} skill`,
    summary: `${memoryId} summary`,
    contentRef: `memory://${memoryId}/v1`,
    ownerId: "agent-curator",
    visibility: "restricted",
    allowedAgentIds: ["agent-codex"],
    sourceMemoryIds: [memoryId],
    sourceEpisodeIds: ["source-episode"],
    sourceTraceIds: ["source-trace"],
    sourceTopicIds: [],
    applicability: {
      scope: "project",
      taskTypes: ["repository-migration"],
      projectIds: ["project-a"],
      planIds: [],
      workItemIds: [],
      requiredSignals: ["migration-interrupted"],
      excludedSignals: [],
      invocationHints: [],
      retireWhen: "project_completed"
    },
    validation: { attempts: 2, successes: 1, failures: 1, unknowns: 0, transferRewardSum: 1, riskPenaltySum: 0 },
    provenance: { skillMemoryId: memoryId },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  };
}

async function withFixture<T>(run: (context: {
  service: MemoryService;
  repos: Repositories;
  validity: TemporalValidityService;
  loadouts: AgentLoadoutService;
}) => T | Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "asset-recall-flow-"));
  roots.push(root);
  const db = new MemoryDb({ path: join(root, "memory.sqlite") });
  const repos = new Repositories(db.db);
  let nextId = 0;
  const id = (prefix: string) => `${prefix}-${++nextId}`;
  const service = new MemoryService({ db, mode: "dev", embedder: createCapturingEmbedder([]) });
  const validity = new TemporalValidityService({ repositories: repos, now: () => NOW, id });
  const loadouts = new AgentLoadoutService({ repositories: repos, now: () => NOW, id });
  try {
    return await run({ service, repos, validity, loadouts });
  } finally {
    db.close();
  }
}

function seedGoverned(context: {
  repos: Repositories;
  validity: TemporalValidityService;
  loadouts: AgentLoadoutService;
}, input: {
  memoryId: string;
  priority: number;
  reviewAfter?: string;
  validation?: MemoryAssetRecord["validation"];
}): MemoryAssetRecord {
  context.repos.memories.insert(memory(input.memoryId));
  const stored = context.repos.assets.create(asset(input.memoryId, { validation: input.validation ?? asset(input.memoryId).validation }));
  context.validity.initialize({
    namespaceId: ALPHA,
    memoryId: input.memoryId,
    expectedVersion: 0,
    observedAt: NOW,
    reviewAfter: input.reviewAfter,
    actor: { source: "test" },
    reason: "Verified governed asset",
    evidenceIds: [input.memoryId],
    projectStateRef: { projectId: "project-a" }
  });
  context.loadouts.bind({
    namespaceId: ALPHA,
    agentId: "agent-codex",
    assetId: stored.id,
    assetVersion: stored.version,
    mode: "recall",
    priority: input.priority,
    projectId: "project-a",
    taskTypes: ["repository-migration"],
    retireWhen: "project_completed"
  });
  return stored;
}

const recallRequest = {
  namespaceId: ALPHA,
  agentId: "agent-codex",
  mode: "recall" as const,
  projectId: "project-a",
  taskType: "repository-migration",
  signals: ["migration-interrupted"],
  at: NOW,
  episodeId: "episode-recall",
  eventKey: "turn-1-offer",
  risk: "low" as const
};

describe("MemoryService governed asset recall", () => {
  it("filters before ranking and orders by semantic, validation, then loadout priority", () => withFixture((context) => {
    const semanticWinner = seedGoverned(context, { memoryId: "memory-semantic", priority: 1 });
    const validationWinner = seedGoverned(context, {
      memoryId: "memory-validation",
      priority: 5,
      validation: { attempts: 4, successes: 4, failures: 0, unknowns: 0, transferRewardSum: 3, riskPenaltySum: 0 }
    });
    const priorityWinner = seedGoverned(context, {
      memoryId: "memory-priority",
      priority: 20,
      validation: { attempts: 4, successes: 4, failures: 0, unknowns: 0, transferRewardSum: 2, riskPenaltySum: 0 }
    });

    const recalled = context.service.recallAvailableAssets({
      ...recallRequest,
      semanticScores: {
        [semanticWinner.id]: 0.9,
        [validationWinner.id]: 0.8,
        [priorityWinner.id]: 0.8
      }
    });

    expect(recalled.map((item) => item.asset.id)).toEqual([
      semanticWinner.id,
      priorityWinner.id,
      validationWinner.id
    ]);
    expect(recalled.every((item) => item.offeredEvent.outcome === "offered")).toBe(true);
    expect(context.repos.assetRecallEvents.listForEpisode(ALPHA, "episode-recall")).toHaveLength(3);
  }));

  it("allows review_due only for explicit low-risk non-bootstrap recall", () => withFixture((context) => {
    seedGoverned(context, { memoryId: "memory-review-due", priority: 10, reviewAfter: REVIEW_DUE_AT });

    expect(context.service.recallAvailableAssets(recallRequest)).toHaveLength(1);
    expect(context.service.recallAvailableAssets({ ...recallRequest, eventKey: "high-risk", risk: "high" })).toEqual([]);
    expect(context.service.recallAvailableAssets({ ...recallRequest, eventKey: "bootstrap", mode: "bootstrap" })).toEqual([]);
  }));

  it("excludes stale assets and freezes recall-time validity on later outcomes", () => withFixture((context) => {
    seedGoverned(context, { memoryId: "memory-frozen", priority: 10 });
    const recalled = context.service.recallAvailableAssets(recallRequest)[0]!;

    context.validity.invalidate({
      namespaceId: ALPHA,
      memoryId: "memory-frozen",
      expectedVersion: 1,
      invalidationKeys: ["schema-version"],
      actor: { source: "test" },
      reason: "Schema changed",
      evidenceIds: ["schema-v2"],
      projectStateRef: { projectId: "project-a" },
      at: NOW
    });

    expect(context.service.recallAvailableAssets({ ...recallRequest, eventKey: "after-stale" })).toEqual([]);
    const used = context.service.recordAssetRecallOutcome({
      namespaceId: ALPHA,
      agentId: "agent-codex",
      offeredEventId: recalled.offeredEvent.id,
      eventKey: "turn-1-used",
      outcome: "used",
      evidenceIds: ["tool-result"]
    });
    expect(used).toMatchObject({
      outcome: "used",
      temporalValidityVersion: 1,
      freshnessAtRecall: "current",
      eligibilityEvaluatedAt: NOW
    });
    expect(used.evidenceIds).toEqual(expect.arrayContaining(["memory-frozen", "tool-result"]));
  }));

  it("authorizes the terminal outcome against the agent that received the offer", () => withFixture((context) => {
    seedGoverned(context, { memoryId: "memory-authorized", priority: 10 });
    const offered = context.service.recallAvailableAssets(recallRequest)[0]!.offeredEvent;

    expect(() => context.service.recordAssetRecallOutcome({
      namespaceId: ALPHA,
      agentId: "agent-reviewer",
      offeredEventId: offered.id,
      eventKey: "turn-1-forged",
      outcome: "used"
    })).toThrow("asset recall outcome agent does not match offered event");
    expect(context.repos.assetRecallEvents.listForEpisode(ALPHA, "episode-recall")).toEqual([offered]);
  }));

  it("allows one idempotent terminal outcome and rejects another outcome for the same offer", () => withFixture((context) => {
    seedGoverned(context, { memoryId: "memory-single-outcome", priority: 10 });
    const offered = context.service.recallAvailableAssets(recallRequest)[0]!.offeredEvent;
    const input = {
      namespaceId: ALPHA,
      agentId: "agent-codex",
      offeredEventId: offered.id,
      eventKey: "turn-1-used",
      outcome: "used" as const,
      evidenceIds: ["tool-result"]
    };

    const used = context.service.recordAssetRecallOutcome(input);
    expect(context.service.recordAssetRecallOutcome(input)).toEqual(used);
    expect(() => context.service.recordAssetRecallOutcome({
      ...input,
      eventKey: "turn-1-failed",
      outcome: "failed",
      failureReason: "late conflicting result"
    })).toThrow("asset recall offer already has a terminal outcome");
    const persisted = context.repos.assetRecallEvents.listForEpisode(ALPHA, "episode-recall");
    expect(persisted).toHaveLength(2);
    expect(persisted).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: offered.id, outcome: "offered" }),
      expect.objectContaining({ id: used.id, offeredEventId: offered.id, outcome: "used" })
    ]));
  }));

  it("keeps unbound memory search compatible", async () => withFixture(async ({ service }) => {
    const added = service.addMemory({
      namespace: NAMESPACE,
      source: "local",
      layer: "L2",
      title: "Legacy unbound guidance",
      content: "legacy unbound recall marker remains searchable"
    });

    expect(service.recallAvailableAssets(recallRequest)).toEqual([]);
    const search = await service.search({ namespace: NAMESPACE, query: "legacy unbound recall marker" });
    expect(search.hits.map((hit) => hit.id)).toContain(added.id);
  }));
});
