import type { Repositories } from "../../storage/repositories.js";
import type {
  AssetRecallEventRecord,
  AssetRewardEvidenceRecord,
  ExperienceSequenceMemberRecord,
  MemoryAssetRecord
} from "../../types.js";
import { newId } from "../../utils/id.js";

export interface RecordAssetRewardInput {
  namespaceId: string;
  targetEpisodeId: string;
  targetTaskReward: number;
}

export interface AssetRewardServiceDependencies {
  repositories: Repositories;
  now?: () => string;
  id?: (prefix: string) => string;
}

const defaultNow = (): string => new Date().toISOString();

export class AssetRewardService {
  private readonly now: () => string;
  private readonly id: (prefix: string) => string;

  constructor(private readonly deps: AssetRewardServiceDependencies) {
    this.now = deps.now ?? defaultNow;
    this.id = deps.id ?? newId;
  }

  recordForEpisode(input: RecordAssetRewardInput): AssetRewardEvidenceRecord[] {
    validateInput(input);
    const target = this.deps.repositories.experienceSequences.getMemberByEpisode(
      input.namespaceId,
      input.targetEpisodeId
    );
    if (!target) return [];

    const members = this.deps.repositories.experienceSequences.listMembers(input.namespaceId, target.sequenceId);
    const priorMembers = members.filter((member) => member.position < target.position);
    if (priorMembers.length === 0) return [];

    const usedRecalls = this.deps.repositories.assetRecallEvents
      .listForEpisode(input.namespaceId, input.targetEpisodeId)
      .filter((event) => event.outcome === "used");

    return usedRecalls.flatMap((recall) => {
      const asset = this.deps.repositories.assets.get(
        input.namespaceId,
        recall.assetId,
        recall.assetVersion
      );
      if (!asset) return [];
      const source = latestAssetSourceMember(asset, priorMembers);
      if (!source || !appliesToTarget(asset, target)) return [];
      return [this.recordEvidence(input, target, source, recall, asset)];
    });
  }

  private recordEvidence(
    input: RecordAssetRewardInput,
    target: ExperienceSequenceMemberRecord,
    source: ExperienceSequenceMemberRecord,
    recall: AssetRecallEventRecord,
    asset: MemoryAssetRecord
  ): AssetRewardEvidenceRecord {
    const eventKey = `asset-transfer:${target.episodeId}:${recall.id}`;
    const existing = this.deps.repositories.assetRewardEvidence
      .listForEpisode(input.namespaceId, target.episodeId)
      .find((record) => record.eventKey === eventKey);
    if (existing) return existing;

    const at = this.now();
    const transferReward = input.targetTaskReward;
    const outcome = rewardOutcome(transferReward);
    const riskPenalty = transferReward < 0 ? Math.abs(transferReward) : 0;
    const evidence: AssetRewardEvidenceRecord = {
      id: this.id("asset-reward"),
      namespaceId: input.namespaceId,
      eventKey,
      sequenceId: target.sequenceId,
      sourceEpisodeId: source.episodeId,
      targetEpisodeId: target.episodeId,
      assetId: asset.id,
      assetVersion: asset.version,
      recallEventId: recall.id,
      relation: "explicit_sequence",
      targetTaskReward: input.targetTaskReward,
      usageFactor: 1,
      relationConfidence: 1,
      applicabilityFactor: 1,
      transferReward,
      riskPenalty,
      outcome,
      reason: outcome === "success"
        ? "used asset contributed to a successful later episode in an explicit sequence"
        : outcome === "failure"
        ? "used asset was followed by a failed later episode in an explicit sequence"
        : "used asset was evaluated in a later episode with a neutral result",
      evidenceIds: unique([
        recall.id,
        source.id,
        target.id,
        ...recall.evidenceIds,
        ...asset.sourceMemoryIds,
        ...asset.sourceTraceIds
      ]),
      createdAt: at
    };

    return this.deps.repositories.transaction(() => {
      const saved = this.deps.repositories.assetRewardEvidence.append(evidence);
      const current = this.deps.repositories.assets.get(input.namespaceId, asset.id, asset.version);
      if (!current) throw new Error(`asset not found: ${input.namespaceId}/${asset.id}/v${asset.version}`);
      this.deps.repositories.assets.updateValidation(
        input.namespaceId,
        asset.id,
        asset.version,
        incrementValidation(current, saved, at),
        at
      );
      return saved;
    });
  }
}

function validateInput(input: RecordAssetRewardInput): void {
  if (!input.namespaceId.trim() || !input.targetEpisodeId.trim()) {
    throw new Error("asset reward requires namespaceId and targetEpisodeId");
  }
  if (!Number.isFinite(input.targetTaskReward)) {
    throw new Error("asset reward targetTaskReward must be finite");
  }
}

function latestAssetSourceMember(
  asset: MemoryAssetRecord,
  priorMembers: ExperienceSequenceMemberRecord[]
): ExperienceSequenceMemberRecord | undefined {
  const sourceEpisodes = new Set(asset.sourceEpisodeIds);
  return priorMembers
    .filter((member) => sourceEpisodes.has(member.episodeId))
    .sort((left, right) => right.position - left.position || left.id.localeCompare(right.id))[0];
}

function appliesToTarget(asset: MemoryAssetRecord, target: ExperienceSequenceMemberRecord): boolean {
  const { applicability } = asset;
  if (applicability.taskTypes.length > 0
    && (!target.taskId || !applicability.taskTypes.includes(target.taskId))) return false;
  if (applicability.planIds.length > 0
    && (!target.planId || !applicability.planIds.includes(target.planId))) return false;
  if (applicability.workItemIds.length > 0
    && (!target.workItemId || !applicability.workItemIds.includes(target.workItemId))) return false;
  return true;
}

function rewardOutcome(reward: number): AssetRewardEvidenceRecord["outcome"] {
  if (reward > 0) return "success";
  if (reward < 0) return "failure";
  return "unknown";
}

function incrementValidation(
  asset: MemoryAssetRecord,
  evidence: AssetRewardEvidenceRecord,
  at: string
): MemoryAssetRecord["validation"] {
  return {
    ...asset.validation,
    attempts: asset.validation.attempts + 1,
    successes: asset.validation.successes + (evidence.outcome === "success" ? 1 : 0),
    failures: asset.validation.failures + (evidence.outcome === "failure" ? 1 : 0),
    unknowns: asset.validation.unknowns + (evidence.outcome === "unknown" ? 1 : 0),
    transferRewardSum: asset.validation.transferRewardSum + evidence.transferReward,
    riskPenaltySum: asset.validation.riskPenaltySum + evidence.riskPenalty,
    lastUsedAt: at,
    lastValidatedAt: at
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim()))];
}
