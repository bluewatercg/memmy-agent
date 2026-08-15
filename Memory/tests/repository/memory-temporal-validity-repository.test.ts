import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryDb } from "../../src/storage/db.js";
import {
  MemoryTemporalValidityRepository,
  MemoryTemporalVersionConflictError,
  Repositories
} from "../../src/storage/repositories.js";
import type {
  MemoryTemporalValidity,
  MemoryTemporalValidityEvent
} from "../../src/types.js";

const OBSERVED_AT = "2026-08-10T08:00:00.000Z";
const REVIEWED_AT = "2026-08-13T10:00:00.000Z";
const EVENT_AT = "2026-08-13T10:05:00.000Z";

function validity(overrides: Partial<MemoryTemporalValidity> = {}): MemoryTemporalValidity {
  return {
    namespaceId: "local:project-a",
    memoryId: "memory-1",
    observedAt: OBSERVED_AT,
    effectiveFrom: "2026-08-10T00:00:00.000Z",
    effectiveUntil: "2026-09-01T00:00:00.000Z",
    reviewAfter: "2026-08-20T00:00:00.000Z",
    freshness: "review_due",
    invalidationKeys: ["package-lock", "schema-version"],
    invalidatedAt: "2026-08-13T09:00:00.000Z",
    invalidationReason: "Schema changed",
    supersededByMemoryId: "memory-2",
    lastReviewedAt: REVIEWED_AT,
    version: 1,
    ...overrides
  };
}

function event(overrides: Partial<MemoryTemporalValidityEvent> = {}): MemoryTemporalValidityEvent {
  return {
    id: "event-1",
    namespaceId: "local:project-a",
    memoryId: "memory-1",
    validityVersion: 2,
    type: "reviewed",
    actor: {
      source: "codex",
      agentId: "agent-reviewer",
      adapterId: "memory-panel",
      requestId: "request-review-1"
    },
    reason: "Validated against the current repository state",
    evidenceIds: ["memory-evidence-1", "trace-evidence-1"],
    projectStateRef: {
      projectId: "project-a",
      planId: "plan-1",
      workItemId: "work-1",
      revision: "git:abc123"
    },
    createdAt: EVENT_AT,
    ...overrides
  };
}

function withRepo<T>(run: (repo: MemoryTemporalValidityRepository) => T): T {
  const root = mkdtempSync(join(tmpdir(), "memory-temporal-validity-repository-"));
  const db = new MemoryDb({ path: join(root, "memory.sqlite") });
  try {
    return run(new Repositories(db.db).temporalValidity);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}

describe("memory temporal validity repository", () => {
  it("round-trips every temporal validity field", () => withRepo((repo) => {
    const record = validity();

    expect(repo.create(record)).toEqual(record);
    expect(repo.get(record.namespaceId, record.memoryId)).toEqual(record);
  }));

  it("isolates records and missing reads by namespace", () => withRepo((repo) => {
    const first = validity();
    const second = validity({
      namespaceId: "local:project-b",
      freshness: "current",
      invalidationKeys: [],
      invalidatedAt: undefined,
      invalidationReason: undefined,
      supersededByMemoryId: undefined
    });
    repo.create(first);
    repo.create(second);

    expect(repo.get("local:project-a", first.memoryId)).toEqual(first);
    expect(repo.get("local:project-b", second.memoryId)).toEqual(second);
    expect(repo.get("local:missing", first.memoryId)).toBeUndefined();
    expect(repo.get(first.namespaceId, "missing")).toBeUndefined();
  }));

  it("updates with memoryId and expectedVersion, increments once, and preserves observedAt", () => withRepo((repo) => {
    const original = validity({
      effectiveUntil: undefined,
      invalidatedAt: undefined,
      invalidationReason: undefined,
      supersededByMemoryId: undefined
    });
    repo.create(original);
    const proposed = {
      ...original,
      observedAt: "2026-08-13T09:59:59.000Z",
      freshness: "current" as const,
      invalidationKeys: [],
      lastReviewedAt: REVIEWED_AT,
      version: 99
    };

    const updated = repo.update(original.namespaceId, original.memoryId, 1, proposed);

    expect(updated).toEqual({
      ...proposed,
      observedAt: OBSERVED_AT,
      version: 2
    });
    expect(repo.get(original.namespaceId, original.memoryId)).toEqual(updated);
  }));

  it("rejects stale expected versions without changing the current record", () => withRepo((repo) => {
    const original = validity();
    repo.create(original);
    const updated = repo.update(original.namespaceId, original.memoryId, 1, {
      ...original,
      freshness: "stale",
      version: 2
    });

    expect(() => repo.update(original.namespaceId, original.memoryId, 1, {
      ...updated,
      freshness: "historical",
      version: 3
    })).toThrow(MemoryTemporalVersionConflictError);
    expect(repo.get(original.namespaceId, original.memoryId)).toEqual(updated);
  }));

  it("appends immutable audit events with complete review provenance", () => withRepo((repo) => {
    const first = event();

    expect(repo.appendEvent(first)).toEqual(first);
    expect(repo.listEvents(first.namespaceId, first.memoryId)).toEqual([first]);

    expect(() => repo.appendEvent({
      ...first,
      reason: "Attempted rewrite",
      evidenceIds: ["different-evidence"]
    })).toThrow();
    expect(repo.listEvents(first.namespaceId, first.memoryId)).toEqual([first]);
  }));

  it("isolates events by namespace and orders them by createdAt then id", () => withRepo((repo) => {
    const middleB = event({ id: "event-b" });
    const last = event({ id: "event-last", createdAt: "2026-08-13T10:06:00.000Z", type: "invalidated" });
    const middleA = event({ id: "event-a" });
    const first = event({ id: "event-first", createdAt: "2026-08-13T10:04:00.000Z", type: "review_due" });
    const otherNamespace = event({ id: "event-other", namespaceId: "local:project-b" });
    for (const item of [middleB, last, middleA, first, otherNamespace]) repo.appendEvent(item);

    expect(repo.listEvents("local:project-a", "memory-1"))
      .toEqual([first, middleA, middleB, last]);
    expect(repo.listEvents("local:project-b", "memory-1")).toEqual([otherNamespace]);
    expect(repo.listEvents("local:missing", "memory-1")).toEqual([]);
  }));
});
