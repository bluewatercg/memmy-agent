import type { AssetApplicability, MemoryAssetRecord } from "../../types.js";
import { isRecord } from "../../utils/json.js";

export interface SkillTrialProvenance {
  trialId: string;
  episodeId?: string;
  traceId?: string;
  policyId?: string;
  reward: number;
  outcome: "success" | "failure" | "unknown";
}

export interface SkillAssetContent {
  invocationGuide: string;
  procedureJson: Record<string, unknown>;
  acceptanceRules: string[];
  rollbackRules: string[];
  sourcePolicyIds: string[];
  evidenceAnchorIds: string[];
  support: number;
  gain: number;
  eta: number;
  trialProvenance: SkillTrialProvenance[];
}

const SCOPE_ORDER: AssetApplicability["scope"][] = [
  "work_item",
  "plan",
  "project",
  "namespace",
  "global"
];

export function validateSkillAssetStructure(asset: MemoryAssetRecord): SkillAssetContent {
  if (asset.assetType !== "skill") throw new Error("governed lifecycle requires a Skill asset");
  const provenance = asset.provenance;
  const invocationGuide = requiredString(provenance.invocationGuide, "invocationGuide");
  const procedureJson = requiredRecord(provenance.procedureJson, "procedureJson");
  const steps = procedureJson.steps;
  if (!Array.isArray(steps) || steps.length === 0 || steps.some((step) => !isRecord(step))) {
    throw new Error("procedureJson.steps must contain normalized step records");
  }
  const acceptanceRules = requiredStringArray(provenance.acceptanceRules, "acceptanceRules");
  const rollbackRules = requiredStringArray(provenance.rollbackRules, "rollbackRules");
  const sourcePolicyIds = requiredStringArray(provenance.sourcePolicyIds, "sourcePolicyIds");
  const evidenceAnchorIds = requiredStringArray(provenance.evidenceAnchorIds, "evidenceAnchorIds");
  const support = requiredFiniteNumber(provenance.support, "support");
  const gain = requiredFiniteNumber(provenance.gain, "gain");
  const eta = requiredFiniteNumber(provenance.eta, "eta");
  if (support < 0 || gain < 0 || eta < 0 || eta > 1) {
    throw new Error("support, gain, and eta must be non-negative; eta must not exceed 1");
  }
  const trialProvenance = parseTrials(provenance.trialProvenance);
  validateApplicability(asset.applicability);
  if (asset.sourceEpisodeIds.length === 0 || asset.sourceTraceIds.length === 0 || sourcePolicyIds.length === 0) {
    throw new Error("Skill requires source Episode, Trace, and Policy provenance");
  }
  if (!sourcePolicyIds.every((id) => asset.sourceMemoryIds.includes(id))) {
    throw new Error("sourcePolicyIds must reference sourceMemoryIds");
  }
  return {
    invocationGuide,
    procedureJson,
    acceptanceRules,
    rollbackRules,
    sourcePolicyIds,
    evidenceAnchorIds,
    support,
    gain,
    eta,
    trialProvenance
  };
}

export function validateSkillActivation(
  asset: MemoryAssetRecord,
  thresholds: { minimumTrials: number; minimumEta: number }
): SkillAssetContent {
  const content = validateSkillAssetStructure(asset);
  const successful = content.trialProvenance.filter((trial) => trial.outcome === "success" && trial.reward >= thresholds.minimumEta);
  if (content.trialProvenance.length < Math.max(1, thresholds.minimumTrials)) {
    throw new Error(`Skill requires at least ${Math.max(1, thresholds.minimumTrials)} validation trials`);
  }
  if (successful.length === 0) throw new Error("Skill requires successful Episode/Trace/Policy trial provenance");
  if (content.eta < thresholds.minimumEta) {
    throw new Error(`Skill eta ${content.eta} is below configured threshold ${thresholds.minimumEta}`);
  }
  const hasTraceableSuccess = successful.some((trial) => trial.episodeId && trial.traceId && trial.policyId);
  if (!hasTraceableSuccess) throw new Error("successful trial must reference Episode, Trace, and Policy provenance");
  return content;
}

export function validateScopeExpansion(
  current: AssetApplicability,
  proposed: AssetApplicability,
  successfulReuseEvidence: Array<{ evidenceId: string; boundaryId: string }>
): void {
  const currentIndex = SCOPE_ORDER.indexOf(current.scope);
  const proposedIndex = SCOPE_ORDER.indexOf(proposed.scope);
  if (proposedIndex !== currentIndex + 1) throw new Error("scope expansion must advance exactly one scope level");
  validateApplicability(proposed);
  const evidenceIds = new Set(successfulReuseEvidence.map((item) => item.evidenceId.trim()).filter(Boolean));
  const boundaries = new Set(successfulReuseEvidence.map((item) => item.boundaryId.trim()).filter(Boolean));
  if (evidenceIds.size < 2 || boundaries.size < 2) {
    throw new Error("scope expansion requires successful reuse evidence from at least two distinct boundaries");
  }
}

function validateApplicability(applicability: AssetApplicability): void {
  if (applicability.taskTypes.length === 0) throw new Error("applicability.taskTypes must not be empty");
  if (applicability.requiredSignals.length === 0) throw new Error("applicability.requiredSignals must not be empty");
  if (applicability.excludedSignals.length === 0) throw new Error("applicability.excludedSignals must not be empty");
  if (applicability.invocationHints.length === 0) throw new Error("applicability.invocationHints must not be empty");
  if (applicability.scope === "work_item" && applicability.workItemIds.length === 0) {
    throw new Error("work_item applicability requires workItemIds");
  }
  if (applicability.scope === "plan" && applicability.planIds.length === 0) {
    throw new Error("plan applicability requires planIds");
  }
  if (applicability.scope === "project" && applicability.projectIds.length === 0) {
    throw new Error("project applicability requires projectIds");
  }
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

function requiredStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be a non-empty string array`);
  const strings = value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim());
  if (strings.length !== value.length || strings.length === 0) throw new Error(`${field} must be a non-empty string array`);
  return strings;
}

function requiredRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).length === 0) throw new Error(`${field} must be a non-empty record`);
  return value;
}

function requiredFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${field} must be a finite number`);
  return value;
}

function parseTrials(value: unknown): SkillTrialProvenance[] {
  if (!Array.isArray(value)) throw new Error("trialProvenance must be an array");
  return value.map((item, index) => {
    if (!isRecord(item)) throw new Error(`trialProvenance[${index}] must be a record`);
    const outcome = item.outcome;
    if (outcome !== "success" && outcome !== "failure" && outcome !== "unknown") {
      throw new Error(`trialProvenance[${index}].outcome is invalid`);
    }
    return {
      trialId: requiredString(item.trialId, `trialProvenance[${index}].trialId`),
      episodeId: optionalString(item.episodeId),
      traceId: optionalString(item.traceId),
      policyId: optionalString(item.policyId),
      reward: requiredFiniteNumber(item.reward, `trialProvenance[${index}].reward`),
      outcome
    };
  });
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
