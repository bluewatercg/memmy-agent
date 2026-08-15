import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AssetRewardService } from "../../../src/service/evolution/asset-reward-service.js";
import { MemoryDb } from "../../../src/storage/db.js";
import { Repositories } from "../../../src/storage/repositories.js";
import type { AssetRecallEventRecord, ExperienceSequenceMemberRecord, MemoryAssetRecord } from "../../../src/types.js";

const NOW = "2026-08-13T15:00:00.000Z";
const NAMESPACE = "local:project-a";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function asset(overrides: Partial<MemoryAssetRecord> = {}): MemoryAssetRecord {
  return {
    id: "asset-runbook",
    namespaceId: NAMESPACE,
    assetType: "skill",
    stableKey: "skill/recovery",
    version: 1,
    status: "active",
    title: "Recovery runbook",
    summary: "Recover interrupted migrations",
    contentRef: "memory://skill-recovery/v1",
    ownerId: "agent-curator",
    visibility: "team",
    allowedAgentIds: [],
    sourceMemoryIds: ["skill-recovery"],
    sourceEpisodeIds: ["episode-solve"],
    sourceTraceIds: ["trace-solve"],
    sourceTopicIds: ["topic-recovery"],
    applicability: {
      scope: "work_item",
      taskTypes: ["repository-migration"],
      projectIds: ["project-a"],
      planIds: ["plan-1"],
      workItemIds: ["work-verify"],
      requiredSignals: [],
      excludedSignals: [],
      invocationHints: [],
      retireWhen: "work_item_completed"
    },
    validation: {
      attempts: 0,
      successes: 0,
      failures: 0,
      unknowns: 0,
      transferRewardSum: 0,
      riskPenaltySum: 0
    },
    provenance: {},
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  };
}

function member(overrides: Partial<ExperienceSequenceMemberRecord> = {}): ExperienceSequenceMemberRecord {
  return {
    id: "member-solve",
    namespaceId: NAMESPACE,
    sequenceId: "sequence-recovery",
    episodeId: "episode-solve",
    position: 0,
    role: "solve",
    taskId: "repository-migration",
    planId: "plan-1",
    workItemId: "work-solve",
    topicId: "topic-recovery",
    provenance: {},
    createdAt: NOW,
    ...overrides
  };
}

function recall(outcome: AssetRecallEventRecord["outcome"] = "used"): AssetRecallEventRecord {
  return {
    id: `recall-${outcome}`,
    namespaceId: NAMESPACE,
    assetId: "asset-runbook",
    assetVersion: 1,
    agentId: "agent-codex",
    episodeId: "episode-verify",
    taskId: "repository-migration",
    mode: "recall",
    eventKey: `verify-${outcome}`,
    outcome,
    temporalValidityVersion: 1,
    freshnessAtRecall: "current",
    eligibilityEvaluatedAt: NOW,
    scoreInputs: {},
    evidenceIds: ["trace-verify"],
    createdAt: NOW
  };
}

function withFixture<T>(run: (context: { repos: Repositories; service: AssetRewardService }) => T): T {
  const root = mkdtempSync(join(tmpdir(), "asset-transfer-reward-"));
  roots.push(root);
  const db = new MemoryDb({ path: join(root, "memory.sqlite") });
  const repos = new Repositories(db.db);
  let nextId = 0;
  const service = new AssetRewardService({
    repositories: repos,
    now: () => NOW,
    id: (prefix) => `${prefix}-${++nextId}`
  });
  try {
    return run({ repos, service });
  } finally {
    db.close();
  }
}

function seedExplicitTransfer(repos: Repositories, recallOutcome: AssetRecallEventRecord["outcome"] = "used"): void {
  repos.assets.create(asset());
  repos.experienceSequences.create({
    id: "sequence-recovery",
    namespaceId: NAMESPACE,
    title: "Recovery sequence",
    metadata: { source: "explicit" },
    createdAt: NOW
  });
  repos.experienceSequences.appendMember(member());
  repos.experienceSequences.appendMember(member({
    id: "member-verify",
    episodeId: "episode-verify",
    position: 1,
    role: "verify",
    workItemId: "work-verify"
  }));
  repos.assetRecallEvents.append(recall(recallOutcome));
}

describe("AssetRewardService", () => {
  it("records explicit used transfer and updates validation statistics once", () => withFixture(({ repos, service }) => {
    seedExplicitTransfer(repos);

    const first = service.recordForEpisode({ namespaceId: NAMESPACE, targetEpisodeId: "episode-verify", targetTaskReward: 0.8 });
    const retry = service.recordForEpisode({ namespaceId: NAMESPACE, targetEpisodeId: "episode-verify", targetTaskReward: 0.8 });

    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      sequenceId: "sequence-recovery",
      sourceEpisodeId: "episode-solve",
      targetEpisodeId: "episode-verify",
      recallEventId: "recall-used",
      relation: "explicit_sequence",
      usageFactor: 1,
      relationConfidence: 1,
      applicabilityFactor: 1,
      transferReward: 0.8,
      riskPenalty: 0,
      outcome: "success"
    });
    expect(retry).toEqual(first);
    expect(repos.assetRewardEvidence.listForEpisode(NAMESPACE, "episode-verify")).toEqual(first);
    expect(repos.assets.get(NAMESPACE, "asset-runbook", 1)?.validation).toEqual({
      attempts: 1,
      successes: 1,
      failures: 0,
      unknowns: 0,
      transferRewardSum: 0.8,
      riskPenaltySum: 0,
      lastUsedAt: NOW,
      lastValidatedAt: NOW
    });
  }));

  it("preserves negative transfer evidence and increments failure risk", () => withFixture(({ repos, service }) => {
    seedExplicitTransfer(repos);

    const [evidence] = service.recordForEpisode({ namespaceId: NAMESPACE, targetEpisodeId: "episode-verify", targetTaskReward: -0.5 });

    expect(evidence).toMatchObject({ transferReward: -0.5, riskPenalty: 0.5, outcome: "failure" });
    expect(repos.assets.get(NAMESPACE, "asset-runbook", 1)?.validation).toMatchObject({
      attempts: 1,
      successes: 0,
      failures: 1,
      unknowns: 0,
      transferRewardSum: -0.5,
      riskPenaltySum: 0.5
    });
  }));

  it.each(["offered", "ignored", "failed"] as const)("does not reward a %s recall", (outcome) => withFixture(({ repos, service }) => {
    seedExplicitTransfer(repos, outcome);

    expect(service.recordForEpisode({ namespaceId: NAMESPACE, targetEpisodeId: "episode-verify", targetTaskReward: 1 })).toEqual([]);
    expect(repos.assetRewardEvidence.listForEpisode(NAMESPACE, "episode-verify")).toEqual([]);
    expect(repos.assets.get(NAMESPACE, "asset-runbook", 1)?.validation.attempts).toBe(0);
  }));

  it("does not infer transfer without explicit sequence membership", () => withFixture(({ repos, service }) => {
    repos.assets.create(asset());
    repos.assetRecallEvents.append(recall());

    expect(service.recordForEpisode({ namespaceId: NAMESPACE, targetEpisodeId: "episode-verify", targetTaskReward: 1 })).toEqual([]);
    expect(repos.assets.get(NAMESPACE, "asset-runbook", 1)?.validation.attempts).toBe(0);
  }));

  it("rejects reward when the target member falls outside asset applicability", () => withFixture(({ repos, service }) => {
    seedExplicitTransfer(repos);
    const stored = repos.assets.get(NAMESPACE, "asset-runbook", 1)!;
    repos.assets.updateValidation(NAMESPACE, stored.id, stored.version, {
      ...stored.validation
    }, NOW);
    repos.db.prepare("UPDATE memory_assets SET applicability_json = ? WHERE namespace_id = ? AND id = ? AND version = ?")
      .run(JSON.stringify({ ...stored.applicability, workItemIds: ["different-work"] }), NAMESPACE, stored.id, stored.version);

    expect(service.recordForEpisode({ namespaceId: NAMESPACE, targetEpisodeId: "episode-verify", targetTaskReward: 1 })).toEqual([]);
  }));
});
