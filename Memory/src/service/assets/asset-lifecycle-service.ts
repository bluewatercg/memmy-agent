import type { MemoryAssetRecord, MemoryAssetStatus } from "../../types.js";
import { stableHash } from "../../utils/id.js";
import type {
  AssetCandidateInput,
  AssetServiceDependencies,
  SkillActivationInput,
  SkillLifecycleAuditInput,
  SkillScopeExpansionInput
} from "./asset-types.js";
import {
  validateScopeExpansion,
  validateSkillActivation,
  validateSkillAssetStructure
} from "./skill-asset-validator.js";

const EMPTY_VALIDATION: MemoryAssetRecord["validation"] = {
  attempts: 0,
  successes: 0,
  failures: 0,
  unknowns: 0,
  transferRewardSum: 0,
  riskPenaltySum: 0
};

const DEFAULT_SKILL_ACTIVATION = { minimumTrials: 1, minimumEta: 0.1 };

export class AssetLifecycleService {
  constructor(private readonly deps: AssetServiceDependencies) {}

  createCandidate(input: AssetCandidateInput): MemoryAssetRecord {
    return this.upsertCandidateVersion(input, 1);
  }

  upsertCandidateVersion(input: AssetCandidateInput, version: number): MemoryAssetRecord {
    if (!Number.isInteger(version) || version < 1) {
      throw new Error("asset candidate version must be a positive integer");
    }
    const existing = this.deps.repositories.assets.getByStableKey(input.namespaceId, input.stableKey, version);
    if (existing) {
      const storedCandidate = {
        namespaceId: existing.namespaceId,
        assetType: existing.assetType,
        stableKey: existing.stableKey,
        title: existing.title,
        summary: existing.summary,
        contentRef: existing.contentRef,
        ownerId: existing.ownerId,
        visibility: existing.visibility,
        allowedAgentIds: existing.allowedAgentIds,
        sourceMemoryIds: existing.sourceMemoryIds,
        sourceEpisodeIds: existing.sourceEpisodeIds,
        sourceTraceIds: existing.sourceTraceIds,
        sourceTopicIds: existing.sourceTopicIds,
        applicability: existing.applicability
      };
      const requestedCandidate = {
        namespaceId: input.namespaceId,
        assetType: input.assetType,
        stableKey: input.stableKey,
        title: input.title,
        summary: input.summary,
        contentRef: input.contentRef,
        ownerId: input.ownerId,
        visibility: input.visibility,
        allowedAgentIds: input.allowedAgentIds,
        sourceMemoryIds: input.sourceMemoryIds,
        sourceEpisodeIds: input.sourceEpisodeIds,
        sourceTraceIds: input.sourceTraceIds,
        sourceTopicIds: input.sourceTopicIds,
        applicability: input.applicability
      };
      if (stableHash(storedCandidate) === stableHash(requestedCandidate)) return existing;
      throw new Error(`asset candidate conflict for ${input.namespaceId}/${input.stableKey}/v${version}`);
    }

    const latest = this.deps.repositories.assets.getByStableKey(input.namespaceId, input.stableKey);
    const expectedVersion = latest ? latest.version + 1 : 1;
    if (version !== expectedVersion) {
      throw new Error(`asset candidate version must follow latest version ${latest?.version ?? 0}`);
    }
    const at = this.deps.now();
    return this.deps.repositories.assets.create({
      id: latest?.id ?? this.deps.id("asset"),
      ...input,
      status: "candidate",
      version,
      validation: { ...EMPTY_VALIDATION },
      createdAt: at,
      updatedAt: at
    });
  }
  recordResolvedSkillTrial(input: {
    namespaceId: string;
    stableKey: string;
    trialId: string;
    episodeId?: string;
    traceId?: string;
    reward: number;
    outcome: "success" | "failure" | "unknown";
    eta: number;
    actorId: string;
    reason: string;
  }): MemoryAssetRecord | undefined {
    const asset = this.deps.repositories.assets.getByStableKey(input.namespaceId, input.stableKey);
    if (!asset || asset.assetType !== "skill" || asset.status === "rejected" || asset.status === "deprecated") return asset;
    const content = validateSkillAssetStructure(asset);
    if (content.trialProvenance.some((trial) => trial.trialId === input.trialId)) return asset;
    const trialProvenance = [...content.trialProvenance, {
      trialId: input.trialId,
      episodeId: input.episodeId,
      traceId: input.traceId,
      policyId: content.sourcePolicyIds[0],
      reward: input.reward,
      outcome: input.outcome
    }];
    const at = this.deps.now();
    const updated = this.deps.repositories.assets.updateEvidence(
      asset.namespaceId,
      asset.id,
      asset.version,
      {
        ...asset.validation,
        attempts: asset.validation.attempts + 1,
        successes: asset.validation.successes + (input.outcome === "success" ? 1 : 0),
        failures: asset.validation.failures + (input.outcome === "failure" ? 1 : 0),
        unknowns: asset.validation.unknowns + (input.outcome === "unknown" ? 1 : 0),
        transferRewardSum: asset.validation.transferRewardSum + input.reward,
        lastUsedAt: at,
        lastValidatedAt: at
      },
      { ...asset.provenance, eta: input.eta, trialProvenance },
      at
    );
    if (updated.status !== "candidate") return updated;
    return this.submitForReview({
      namespaceId: updated.namespaceId,
      assetId: updated.id,
      assetVersion: updated.version,
      actorId: input.actorId,
      reason: input.reason,
      evidenceIds: [input.trialId, input.episodeId, input.traceId].filter((id): id is string => Boolean(id))
    });
  }


  getVersion(namespaceId: string, id: string, version?: number): MemoryAssetRecord | undefined {
    return this.deps.repositories.assets.get(namespaceId, id, version);
  }

  submitForReview(input: SkillLifecycleAuditInput): MemoryAssetRecord {
    const asset = this.requireVersion(input);
    if (asset.status === "rejected") throw new Error("rejected Skill is terminal and cannot enter review");
    if (asset.status !== "candidate") throw this.invalidTransition(asset.status, "reviewing");
    validateSkillAssetStructure(asset);
    return this.transition(asset, "candidate", "reviewing", "asset.skill.reviewing", input);
  }

  activateSkill(input: SkillActivationInput): MemoryAssetRecord {
    const asset = this.requireVersion(input);
    if (asset.status !== "reviewing") throw this.invalidTransition(asset.status, "active");
    return this.activate(asset, "reviewing", input, "asset.skill.activated");
  }

  rejectSkill(input: SkillLifecycleAuditInput): MemoryAssetRecord {
    const asset = this.requireVersion(input);
    if (asset.status !== "candidate" && asset.status !== "reviewing") {
      throw this.invalidTransition(asset.status, "rejected");
    }
    return this.transition(asset, asset.status, "rejected", "asset.skill.rejected", input);
  }

  deprecateSkill(input: SkillLifecycleAuditInput): MemoryAssetRecord {
    const asset = this.requireVersion(input);
    if (asset.status !== "active") throw this.invalidTransition(asset.status, "deprecated");
    return this.transition(asset, "active", "deprecated", "asset.skill.deprecated", input);
  }

  restoreSkill(input: SkillActivationInput): MemoryAssetRecord {
    const asset = this.requireVersion(input);
    if (asset.status !== "deprecated") throw this.invalidTransition(asset.status, "active");
    return this.activate(asset, "deprecated", input, "asset.skill.restored");
  }

  createScopeExpandedVersion(input: SkillScopeExpansionInput): MemoryAssetRecord {
    const source = this.requireVersion(input);
    validateSkillAssetStructure(source);
    validateScopeExpansion(source.applicability, input.applicability, input.successfulReuseEvidence);
    this.validateAudit(input);
    const latest = this.deps.repositories.assets.getByStableKey(source.namespaceId, source.stableKey);
    if (!latest || latest.version !== source.version) {
      throw new Error(`scope expansion must start from latest asset version ${latest?.version ?? "missing"}`);
    }
    const at = this.deps.now();
    const next: MemoryAssetRecord = {
      ...source,
      version: source.version + 1,
      status: "candidate",
      applicability: input.applicability,
      provenance: {
        ...source.provenance,
        scopeExpansion: {
          fromVersion: source.version,
          evidence: input.successfulReuseEvidence,
          approvedBy: input.actorId,
          reason: input.reason
        }
      },
      createdAt: at,
      updatedAt: at
    };
    return this.deps.repositories.transaction(() => {
      const created = this.deps.repositories.assets.create(next);
      this.appendAudit(source, created, "asset.skill.scope_expanded", input);
      return created;
    });
  }

  private activate(
    asset: MemoryAssetRecord,
    expectedStatus: "reviewing" | "deprecated",
    input: SkillActivationInput,
    changeType: string
  ): MemoryAssetRecord {
    this.validateAudit(input);
    if (!input.approved) throw new Error("Skill activation requires explicit approval");
    if (input.unresolvedHighRiskConflicts.length > 0) {
      throw new Error("Skill activation blocked by unresolved high-risk conflict");
    }
    validateSkillActivation(asset, this.deps.skillActivation ?? DEFAULT_SKILL_ACTIVATION);
    const at = this.deps.now();
    return this.deps.repositories.transaction(() => {
      const result = this.deps.repositories.assets.activateVersion(
        asset.namespaceId,
        asset.id,
        asset.version,
        expectedStatus,
        at
      );
      for (const deprecated of result.deprecated) {
        this.appendAudit(
          { ...deprecated, status: "active", updatedAt: asset.updatedAt },
          deprecated,
          "asset.skill.deprecated",
          { ...input, reason: `Superseded by ${asset.id}/v${asset.version}` }
        );
      }
      this.appendAudit(asset, result.active, changeType, input);
      return result.active;
    });
  }

  private transition(
    asset: MemoryAssetRecord,
    expectedStatus: MemoryAssetStatus,
    status: MemoryAssetStatus,
    changeType: string,
    input: SkillLifecycleAuditInput
  ): MemoryAssetRecord {
    this.validateAudit(input);
    const at = this.deps.now();
    return this.deps.repositories.transaction(() => {
      const updated = this.deps.repositories.assets.updateStatus(
        asset.namespaceId,
        asset.id,
        asset.version,
        expectedStatus,
        status,
        at
      );
      this.appendAudit(asset, updated, changeType, input);
      return updated;
    });
  }

  private requireVersion(input: Pick<SkillLifecycleAuditInput, "namespaceId" | "assetId" | "assetVersion">): MemoryAssetRecord {
    const asset = this.deps.repositories.assets.get(input.namespaceId, input.assetId, input.assetVersion);
    if (!asset) throw new Error(`asset not found: ${input.namespaceId}/${input.assetId}/v${input.assetVersion}`);
    if (asset.assetType !== "skill") throw new Error("governed lifecycle requires a Skill asset");
    return asset;
  }

  private validateAudit(input: SkillLifecycleAuditInput): void {
    if (!input.actorId.trim()) throw new Error("lifecycle audit requires actorId");
    if (!input.reason.trim()) throw new Error("lifecycle audit requires reason");
    if (input.evidenceIds.length === 0 || input.evidenceIds.some((id) => !id.trim())) {
      throw new Error("lifecycle audit requires evidenceIds");
    }
  }

  private appendAudit(
    before: MemoryAssetRecord,
    after: MemoryAssetRecord,
    changeType: string,
    input: SkillLifecycleAuditInput
  ): void {
    this.deps.repositories.runtime.appendChange({
      memoryId: after.id,
      namespaceId: after.namespaceId,
      kind: "memory_asset",
      op: "lifecycle",
      entityId: `${after.id}:v${after.version}`,
      userId: input.actorId,
      changeType,
      version: after.version,
      before,
      after: { ...after, lifecycleEvidenceIds: input.evidenceIds, lifecycleReason: input.reason },
      source: "asset.skill.lifecycle.v1",
      createdAt: this.deps.now()
    });
  }

  private invalidTransition(from: MemoryAssetStatus, to: MemoryAssetStatus): Error {
    return new Error(`invalid Skill lifecycle transition: ${from} -> ${to}`);
  }
}
