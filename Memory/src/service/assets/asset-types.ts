import type { Repositories } from "../../storage/repositories.js";
import type {
  AssetApplicability,
  MemoryAssetType,
  MemoryAssetVisibility,
  MemoryFreshness,
  MemoryTemporalValidityEvent
} from "../../types.js";

export interface AssetCandidateInput {
  namespaceId: string;
  assetType: MemoryAssetType;
  stableKey: string;
  title: string;
  summary: string;
  contentRef: string;
  ownerId: string;
  visibility: MemoryAssetVisibility;
  allowedAgentIds: string[];
  sourceMemoryIds: string[];
  sourceEpisodeIds: string[];
  sourceTraceIds: string[];
  sourceTopicIds: string[];
  applicability: AssetApplicability;
  provenance: Record<string, unknown>;
}

export interface AssetServiceDependencies {
  repositories: Repositories;
  now: () => string;
  id: (prefix: string) => string;
  skillActivation?: SkillActivationThresholds;
}

export interface SkillActivationThresholds {
  minimumTrials: number;
  minimumEta: number;
}

export interface SkillLifecycleAuditInput {
  namespaceId: string;
  assetId: string;
  assetVersion: number;
  actorId: string;
  reason: string;
  evidenceIds: string[];
}

export interface SkillActivationInput extends SkillLifecycleAuditInput {
  approved: boolean;
  unresolvedHighRiskConflicts: string[];
}

export interface SkillScopeExpansionInput extends SkillLifecycleAuditInput {
  applicability: AssetApplicability;
  successfulReuseEvidence: Array<{ evidenceId: string; boundaryId: string }>;
}

export interface TemporalAuditInput {
  actor: Record<string, unknown>;
  reason: string;
  evidenceIds: string[];
  projectStateRef: Record<string, unknown>;
}

export interface TemporalInitializeInput extends TemporalAuditInput {
  namespaceId: string;
  memoryId: string;
  expectedVersion: 0;
  observedAt: string;
  effectiveFrom?: string;
  effectiveUntil?: string;
  reviewAfter?: string;
  invalidationKeys?: string[];
}

export interface TemporalMutationInput extends TemporalAuditInput {
  namespaceId: string;
  memoryId: string;
  expectedVersion: number;
  at: string;
}

export interface TemporalReviewInput extends TemporalMutationInput {
  reviewAfter?: string;
}

export interface TemporalInvalidateInput extends TemporalMutationInput {
  invalidationKeys: string[];
}

export interface TemporalSupersedeInput extends TemporalMutationInput {
  supersededByMemoryId: string;
}

export interface TemporalProjectionOptions {
  at: string;
  scopeActive: boolean;
  invalidationSignals?: string[];
}

export interface TemporalProjection {
  view: "current_truth" | "review_queue" | "historical_evidence";
  freshness: MemoryFreshness;
  eligible: boolean;
}

export type TemporalEventType = MemoryTemporalValidityEvent["type"];
