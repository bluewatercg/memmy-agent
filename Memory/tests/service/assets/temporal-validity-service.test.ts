import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TemporalValidityService } from "../../../src/service/assets/temporal-validity-service.js";
import { MemoryDb } from "../../../src/storage/db.js";
import { Repositories } from "../../../src/storage/repositories.js";
import type { MemoryRow, MemoryTemporalValidityEvent } from "../../../src/types.js";

const OBSERVED_AT = "2026-08-10T08:00:00.000Z";
const EFFECTIVE_FROM = "2026-08-10T00:00:00.000Z";
const REVIEW_AFTER = "2026-08-20T00:00:00.000Z";
const EFFECTIVE_UNTIL = "2026-09-01T00:00:00.000Z";
const NOW = "2026-08-15T09:00:00.000Z";
const REVIEWED_AT = "2026-08-21T11:00:00.000Z";
const INVALIDATED_AT = "2026-08-21T10:00:00.000Z";
const SUPERSEDED_AT = "2026-08-22T10:00:00.000Z";
const ALPHA = "local:project-a";
const BETA = "local:project-b";

const ACTOR = {
  source: "codex",
  agentId: "agent-reviewer",
  adapterId: "memory-panel",
  requestId: "request-review-1"
};
const EVIDENCE = ["memory-evidence-1", "trace-evidence-1"];
const PROJECT_STATE = {
  projectId: "project-a",
  planId: "plan-1",
  workItemId: "work-1",
  revision: "git:abc123"
};

function memory(id: string, projectId = "project-a"): MemoryRow {
  return {
    id,
    timeline: OBSERVED_AT,
    userId: "user-a",
    agentId: "codex",
    appId: projectId,
    memoryType: "LongTermMemory",
    status: "activated",
    visibility: "private",
    memoryKey: `policy:${id}`,
    memoryValue: id,
    tags: ["temporal-validity"],
    info: { project_id: projectId },
    properties: {
      internal_info: {
        memory_layer: "L2",
        memory_kind: "policy"
      }
    },
    memoryLayer: "L2",
    contentHash: `${id}-hash`,
    version: 1,
    createdAt: OBSERVED_AT,
    updatedAt: OBSERVED_AT,
    deletedAt: null
  };
}

function mutation(expectedVersion: number, reason: string, at: string) {
  return {
    expectedVersion,
    actor: ACTOR,
    reason,
    evidenceIds: EVIDENCE,
    projectStateRef: PROJECT_STATE,
    at
  };
}

function withService<T>(run: (context: {
  service: TemporalValidityService;
  repos: Repositories;
}) => T): T {
  const root = mkdtempSync(join(tmpdir(), "temporal-validity-service-"));
  const db = new MemoryDb({ path: join(root, "memory.sqlite") });
  const repos = new Repositories(db.db);
  let nextId = 0;
  const service = new TemporalValidityService({
    repositories: repos,
    now: () => NOW,
    id: (prefix) => `${prefix}-${++nextId}`
  });
  try {
    return run({ service, repos });
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function initialize(service: TemporalValidityService, memoryId = "memory-a") {
  return service.initialize({
    namespaceId: ALPHA,
    expectedVersion: 0,
    memoryId,
    observedAt: OBSERVED_AT,
    effectiveFrom: EFFECTIVE_FROM,
    effectiveUntil: EFFECTIVE_UNTIL,
    reviewAfter: REVIEW_AFTER,
    invalidationKeys: ["package-lock", "schema-version"],
    actor: ACTOR,
    reason: "Established from verified repository evidence",
    evidenceIds: EVIDENCE,
    projectStateRef: PROJECT_STATE
  });
}

function expectAudit(event: MemoryTemporalValidityEvent | undefined, input: {
  type: MemoryTemporalValidityEvent["type"];
  version: number;
  reason: string;
  createdAt: string;
}): void {
  expect(event).toMatchObject({
    namespaceId: ALPHA,
    memoryId: "memory-a",
    validityVersion: input.version,
    type: input.type,
    actor: ACTOR,
    reason: input.reason,
    evidenceIds: EVIDENCE,
    projectStateRef: PROJECT_STATE,
    createdAt: input.createdAt
  });
}

describe("TemporalValidityService mutations", () => {
  it("initializes a visible memory as current version one and audits provenance", () => withService(({ service, repos }) => {
    repos.memories.insert(memory("memory-a"));

    const initialized = initialize(service);

    expect(initialized).toMatchObject({
      namespaceId: ALPHA,
      memoryId: "memory-a",
      freshness: "current",
      invalidationKeys: ["package-lock", "schema-version"],
      version: 1
    });
    expectAudit(repos.temporalValidity.listEvents(ALPHA, "memory-a")[0], {
      type: "initialized",
      version: 1,
      reason: "Established from verified repository evidence",
      createdAt: NOW
    });
  }));

  it("reviews with expectedVersion, clears invalidation state, and records lastReviewedAt", () => withService(({ service, repos }) => {
    repos.memories.insert(memory("memory-a"));
    initialize(service);
    const stale = service.invalidate({
      namespaceId: ALPHA,
      memoryId: "memory-a",
      invalidationKeys: ["schema-version"],
      ...mutation(1, "Schema changed", INVALIDATED_AT)
    });

    const reviewed = service.review({
      namespaceId: ALPHA,
      memoryId: "memory-a",
      reviewAfter: "2026-09-20T00:00:00.000Z",
      ...mutation(stale.version, "Validated against current repository state", REVIEWED_AT)
    });

    expect(reviewed).toMatchObject({
      freshness: "current",
      invalidationKeys: [],
      lastReviewedAt: REVIEWED_AT,
      reviewAfter: "2026-09-20T00:00:00.000Z",
      version: 3
    });
    expect(reviewed.invalidatedAt).toBeUndefined();
    expect(reviewed.invalidationReason).toBeUndefined();
    expectAudit(repos.temporalValidity.listEvents(ALPHA, "memory-a").at(-1), {
      type: "reviewed",
      version: 3,
      reason: "Validated against current repository state",
      createdAt: REVIEWED_AT
    });
  }));

  it("invalidates with expectedVersion and marks the record stale", () => withService(({ service, repos }) => {
    repos.memories.insert(memory("memory-a"));
    initialize(service);

    const stale = service.invalidate({
      namespaceId: ALPHA,
      memoryId: "memory-a",
      invalidationKeys: ["package-lock", "schema-version"],
      ...mutation(1, "Dependency evidence changed", INVALIDATED_AT)
    });

    expect(stale).toMatchObject({
      freshness: "stale",
      invalidationKeys: ["package-lock", "schema-version"],
      invalidatedAt: INVALIDATED_AT,
      invalidationReason: "Dependency evidence changed",
      version: 2
    });
    expectAudit(repos.temporalValidity.listEvents(ALPHA, "memory-a").at(-1), {
      type: "invalidated",
      version: 2,
      reason: "Dependency evidence changed",
      createdAt: INVALIDATED_AT
    });
  }));

  it("supersedes with expectedVersion and a memory visible in the same namespace", () => withService(({ service, repos }) => {
    repos.memories.insert(memory("memory-a"));
    repos.memories.insert(memory("memory-b"));
    initialize(service);

    const superseded = service.supersede({
      namespaceId: ALPHA,
      memoryId: "memory-a",
      supersededByMemoryId: "memory-b",
      ...mutation(1, "A newer verified memory replaces this claim", SUPERSEDED_AT)
    });

    expect(superseded).toMatchObject({
      freshness: "superseded",
      supersededByMemoryId: "memory-b",
      version: 2
    });
    expectAudit(repos.temporalValidity.listEvents(ALPHA, "memory-a").at(-1), {
      type: "superseded",
      version: 2,
      reason: "A newer verified memory replaces this claim",
      createdAt: SUPERSEDED_AT
    });
  }));

  it("rejects stale expectedVersion on every mutating transition", () => withService(({ service, repos }) => {
    repos.memories.insert(memory("memory-a"));
    repos.memories.insert(memory("memory-b"));
    const initialized = initialize(service);
    service.review({
      namespaceId: ALPHA,
      memoryId: "memory-a",
      ...mutation(initialized.version, "First review", REVIEWED_AT)
    });

    expect(() => service.review({ namespaceId: ALPHA, memoryId: "memory-a", ...mutation(1, "Stale review", REVIEWED_AT) })).toThrow();
    expect(() => service.invalidate({ namespaceId: ALPHA, memoryId: "memory-a", invalidationKeys: ["schema-version"], ...mutation(1, "Stale invalidation", INVALIDATED_AT) })).toThrow();
    expect(() => service.supersede({ namespaceId: ALPHA, memoryId: "memory-a", supersededByMemoryId: "memory-b", ...mutation(1, "Stale supersession", SUPERSEDED_AT) })).toThrow();
    expect(repos.temporalValidity.get(ALPHA, "memory-a")?.version).toBe(2);
  }));

  it("rejects missing and cross-namespace supersession targets", () => withService(({ service, repos }) => {
    repos.memories.insert(memory("memory-a"));
    repos.memories.insert(memory("memory-beta", "project-b"));
    initialize(service);

    expect(() => service.supersede({
      namespaceId: ALPHA,
      memoryId: "memory-a",
      supersededByMemoryId: "missing",
      ...mutation(1, "Missing target", SUPERSEDED_AT)
    })).toThrow();
    expect(() => service.supersede({
      namespaceId: ALPHA,
      memoryId: "memory-a",
      supersededByMemoryId: "memory-beta",
      ...mutation(1, "Cross namespace target", SUPERSEDED_AT)
    })).toThrow();
    expect(repos.temporalValidity.get(ALPHA, "memory-a")?.freshness).toBe("current");
  }));

  it("rejects self-reference and an A to B to A supersession cycle", () => withService(({ service, repos }) => {
    repos.memories.insert(memory("memory-a"));
    repos.memories.insert(memory("memory-b"));
    initialize(service, "memory-a");
    initialize(service, "memory-b");

    expect(() => service.supersede({
      namespaceId: ALPHA,
      memoryId: "memory-a",
      supersededByMemoryId: "memory-a",
      ...mutation(1, "Self reference", SUPERSEDED_AT)
    })).toThrow();

    service.supersede({
      namespaceId: ALPHA,
      memoryId: "memory-a",
      supersededByMemoryId: "memory-b",
      ...mutation(1, "B replaces A", SUPERSEDED_AT)
    });
    expect(() => service.supersede({
      namespaceId: ALPHA,
      memoryId: "memory-b",
      supersededByMemoryId: "memory-a",
      ...mutation(1, "A replaces B", SUPERSEDED_AT)
    })).toThrow();
    expect(repos.temporalValidity.get(ALPHA, "memory-b")?.freshness).toBe("current");
  }));

  it("rejects initialization and mutation through another namespace", () => withService(({ service, repos }) => {
    repos.memories.insert(memory("memory-a"));
    initialize(service);

    expect(() => service.initialize({
      namespaceId: BETA,
      expectedVersion: 0,
      memoryId: "memory-a",
      observedAt: OBSERVED_AT,
      actor: ACTOR,
      reason: "Cross namespace initialize",
      evidenceIds: EVIDENCE,
      projectStateRef: PROJECT_STATE
    })).toThrow();
    expect(() => service.invalidate({
      namespaceId: BETA,
      memoryId: "memory-a",
      invalidationKeys: ["schema-version"],
      ...mutation(1, "Cross namespace mutation", INVALIDATED_AT)
    })).toThrow();
    expect(repos.temporalValidity.get(ALPHA, "memory-a")?.freshness).toBe("current");
  }));
});

describe("TemporalValidityService projections", () => {
  it("projects current records inside their effective interval as Current Truth", () => withService(({ service, repos }) => {
    repos.memories.insert(memory("memory-a"));
    initialize(service);

    expect(service.project(ALPHA, "memory-a", {
      at: "2026-08-19T23:59:59.000Z",
      scopeActive: true
    })).toEqual({ view: "current_truth", freshness: "current", eligible: true });
  }));

  it("projects reviewAfter as review_due in Review Queue without making it historical", () => withService(({ service, repos }) => {
    repos.memories.insert(memory("memory-a"));
    initialize(service);

    expect(service.project(ALPHA, "memory-a", {
      at: REVIEW_AFTER,
      scopeActive: true
    })).toEqual({ view: "review_queue", freshness: "review_due", eligible: false });
  }));

  it.each([
    ["invalidation signal", { at: "2026-08-19T00:00:00.000Z", scopeActive: true, invalidationSignals: ["schema-version"] }],
    ["effective interval ended", { at: EFFECTIVE_UNTIL, scopeActive: true }],
    ["scope ended", { at: "2026-08-19T00:00:00.000Z", scopeActive: false }]
  ])("projects %s as Historical Evidence", (_case, options) => withService(({ service, repos }) => {
    repos.memories.insert(memory("memory-a"));
    initialize(service);

    const projection = service.project(ALPHA, "memory-a", options);
    expect(projection).toMatchObject({
      view: "historical_evidence",
      eligible: false
    });
  }));

  it("projects explicitly invalidated and superseded records as Historical Evidence", () => withService(({ service, repos }) => {
    repos.memories.insert(memory("memory-a"));
    repos.memories.insert(memory("memory-b"));
    repos.memories.insert(memory("memory-c"));
    initialize(service, "memory-a");
    initialize(service, "memory-b");
    service.invalidate({
      namespaceId: ALPHA,
      memoryId: "memory-a",
      invalidationKeys: ["schema-version"],
      ...mutation(1, "Schema changed", INVALIDATED_AT)
    });
    service.supersede({
      namespaceId: ALPHA,
      memoryId: "memory-b",
      supersededByMemoryId: "memory-c",
      ...mutation(1, "C replaces B", SUPERSEDED_AT)
    });

    expect(service.project(ALPHA, "memory-a", { at: SUPERSEDED_AT, scopeActive: true }))
      .toEqual({ view: "historical_evidence", freshness: "stale", eligible: false });
    expect(service.project(ALPHA, "memory-b", { at: SUPERSEDED_AT, scopeActive: true }))
      .toEqual({ view: "historical_evidence", freshness: "superseded", eligible: false });
  }));

  it("does not expose a temporal projection across namespaces", () => withService(({ service, repos }) => {
    repos.memories.insert(memory("memory-a"));
    initialize(service);

    expect(service.project(BETA, "memory-a", { at: NOW, scopeActive: true })).toBeUndefined();
  }));
});
