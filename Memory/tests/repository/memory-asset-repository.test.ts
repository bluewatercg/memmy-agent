import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryDb } from "../../src/storage/db.js";
import {
  MemoryAssetRepository,
  MemoryAssetVersionConflictError,
  Repositories
} from "../../src/storage/repositories.js";
import type { MemoryAssetRecord } from "../../src/types.js";

const NOW = "2026-08-13T10:00:00.000Z";
const LATER = "2026-08-13T11:00:00.000Z";

function asset(overrides: Partial<MemoryAssetRecord> = {}): MemoryAssetRecord {
  return {
    id: "asset-runbook",
    namespaceId: "local:project-a",
    assetType: "skill",
    stableKey: "repository/recovery-runbook",
    version: 1,
    status: "active",
    title: "Repository recovery runbook",
    summary: "Recover a repository after an interrupted migration",
    contentRef: "memory://assets/repository-recovery/v1",
    ownerId: "agent-curator",
    visibility: "restricted",
    allowedAgentIds: ["agent-codex", "agent-reviewer"],
    sourceMemoryIds: ["memory-1", "memory-2"],
    sourceEpisodeIds: ["episode-1"],
    sourceTraceIds: ["trace-1", "trace-2"],
    sourceTopicIds: ["topic-1"],
    applicability: {
      scope: "project",
      taskTypes: ["repository-migration"],
      projectIds: ["project-a"],
      planIds: ["plan-1"],
      workItemIds: ["work-1"],
      requiredSignals: ["migration-interrupted"],
      excludedSignals: ["read-only-worktree"],
      invocationHints: ["Use before resuming schema changes"],
      validFrom: "2026-08-01T00:00:00.000Z",
      validUntil: "2026-12-31T23:59:59.000Z",
      retireWhen: "project_completed"
    },
    validation: {
      attempts: 7,
      successes: 5,
      failures: 1,
      unknowns: 1,
      transferRewardSum: 3.75,
      riskPenaltySum: 0.5,
      lastUsedAt: "2026-08-12T09:00:00.000Z",
      lastValidatedAt: "2026-08-12T09:30:00.000Z"
    },
    provenance: {
      generator: "skill-pipeline",
      source: { adapter: "codex", requestId: "request-1" },
      confidence: 0.91
    },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  };
}

function withRepo<T>(run: (repo: MemoryAssetRepository) => T): T {
  const root = mkdtempSync(join(tmpdir(), "memory-asset-repository-"));
  const db = new MemoryDb({ path: join(root, "memory.sqlite") });
  try {
    return run(new Repositories(db.db).assets);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}

describe("memory asset repository", () => {
  it("round-trips every asset field including nested JSON", () => withRepo((repo) => {
    const record = asset();

    expect(repo.create(record)).toEqual(record);
    expect(repo.get(record.namespaceId, record.id, record.version)).toEqual(record);
    expect(repo.getByStableKey(record.namespaceId, record.stableKey, record.version)).toEqual(record);
  }));

  it("isolates reads and stable keys by namespace", () => withRepo((repo) => {
    const first = asset();
    const second = asset({
      namespaceId: "local:project-b",
      title: "Project B recovery runbook",
      contentRef: "memory://assets/project-b/repository-recovery/v1"
    });
    repo.create(first);
    repo.create(second);

    expect(repo.get("local:project-a", first.id)).toEqual(first);
    expect(repo.get("local:project-b", second.id)).toEqual(second);
    expect(repo.getByStableKey("local:project-a", first.stableKey)).toEqual(first);
    expect(repo.getByStableKey("local:project-b", second.stableKey)).toEqual(second);
    expect(repo.list("local:project-a")).toEqual([first]);
    expect(repo.list("local:project-b")).toEqual([second]);
    expect(repo.get("local:missing", first.id)).toBeUndefined();
  }));

  it("makes identical stable-key versions idempotent and rejects conflicting content", () => withRepo((repo) => {
    const record = asset();

    expect(repo.create(record)).toEqual(record);
    expect(repo.create({ ...record })).toEqual(record);
    expect(repo.list(record.namespaceId, { stableKey: record.stableKey })).toEqual([record]);

    expect(() => repo.create({
      ...record,
      id: "asset-conflicting-retry",
      summary: "Conflicting content",
      updatedAt: LATER
    })).toThrow(MemoryAssetVersionConflictError);
    expect(repo.list(record.namespaceId, { stableKey: record.stableKey })).toEqual([record]);
  }));

  it("returns versions in stable ascending order and resolves the latest when omitted", () => withRepo((repo) => {
    const versionTwo = asset({
      version: 2,
      title: "Repository recovery runbook v2",
      contentRef: "memory://assets/repository-recovery/v2",
      createdAt: LATER,
      updatedAt: LATER
    });
    const versionOne = asset();
    repo.create(versionTwo);
    repo.create(versionOne);

    expect(repo.list(versionOne.namespaceId, { stableKey: versionOne.stableKey }))
      .toEqual([versionOne, versionTwo]);
    expect(repo.get(versionOne.namespaceId, versionOne.id)).toEqual(versionTwo);
    expect(repo.getByStableKey(versionOne.namespaceId, versionOne.stableKey)).toEqual(versionTwo);
    expect(repo.get(versionOne.namespaceId, versionOne.id, 1)).toEqual(versionOne);
  }));

  it("returns undefined for missing ids, stable keys, and versions", () => withRepo((repo) => {
    const record = asset();
    repo.create(record);

    expect(repo.get(record.namespaceId, "missing")).toBeUndefined();
    expect(repo.get(record.namespaceId, record.id, 99)).toBeUndefined();
    expect(repo.getByStableKey(record.namespaceId, "missing")).toBeUndefined();
    expect(repo.getByStableKey(record.namespaceId, record.stableKey, 99)).toBeUndefined();
  }));
});
