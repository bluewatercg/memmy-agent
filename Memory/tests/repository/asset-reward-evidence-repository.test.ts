import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryDb } from "../../src/storage/db.js";
import {
  AssetRewardEvidenceIdempotencyConflictError,
  AssetRewardEvidenceRepository,
  Repositories
} from "../../src/storage/repositories.js";
import type { AssetRewardEvidenceRecord } from "../../src/types.js";

const NOW = "2026-08-13T14:00:00.000Z";

function evidence(overrides: Partial<AssetRewardEvidenceRecord> = {}): AssetRewardEvidenceRecord {
  return {
    id: "asset-reward-1",
    namespaceId: "local:project-a",
    eventKey: "verify-episode-asset-runbook-v1",
    sequenceId: "sequence-recovery",
    sourceEpisodeId: "episode-solve",
    targetEpisodeId: "episode-verify",
    assetId: "asset-runbook",
    assetVersion: 1,
    recallEventId: "recall-used-1",
    relation: "explicit_sequence",
    targetTaskReward: 0.8,
    usageFactor: 1,
    relationConfidence: 1,
    applicabilityFactor: 0.75,
    transferReward: 0.6,
    riskPenalty: 0,
    outcome: "success",
    reason: "verified recovery outcome",
    evidenceIds: ["recall-used-1", "trace-verify"],
    createdAt: NOW,
    ...overrides
  };
}

function withRepo<T>(run: (repo: AssetRewardEvidenceRepository) => T): T {
  const root = mkdtempSync(join(tmpdir(), "asset-reward-evidence-repository-"));
  const db = new MemoryDb({ path: join(root, "memory.sqlite") });
  try {
    return run(new Repositories(db.db).assetRewardEvidence);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}

describe("asset reward evidence repository", () => {
  it("round-trips every immutable reward component", () => withRepo((repo) => {
    const record = evidence();

    expect(repo.append(record)).toEqual(record);
    expect(repo.get(record.namespaceId, record.id)).toEqual(record);
    expect(repo.listForAsset(record.namespaceId, record.assetId, record.assetVersion)).toEqual([record]);
    expect(repo.listForEpisode(record.namespaceId, record.targetEpisodeId)).toEqual([record]);
  }));

  it("makes an identical namespace event retry stable", () => withRepo((repo) => {
    const record = evidence();

    expect(repo.append(record)).toEqual(record);
    expect(repo.append({ ...record, id: "retry-id" })).toEqual(record);
    expect(repo.listForAsset(record.namespaceId, record.assetId, record.assetVersion)).toEqual([record]);
  }));

  it("rejects conflicting content for the same idempotency key", () => withRepo((repo) => {
    const record = evidence();
    repo.append(record);

    expect(() => repo.append({
      ...record,
      id: "conflicting-id",
      transferReward: 0,
      riskPenalty: 0.4,
      outcome: "failure"
    })).toThrow(AssetRewardEvidenceIdempotencyConflictError);
  }));

  it("keeps reward reads namespace isolated", () => withRepo((repo) => {
    const record = evidence();
    repo.append(record);

    expect(repo.get("local:project-b", record.id)).toBeUndefined();
    expect(repo.listForAsset("local:project-b", record.assetId, record.assetVersion)).toEqual([]);
    expect(repo.listForEpisode("local:project-b", record.targetEpisodeId)).toEqual([]);
  }));
});
