import type {
  AgentLoadoutEntry,
  AssetRecallEventRecord,
  MemoryAssetRecord,
  MemoryFreshness,
  MemoryTemporalValidity
} from "../../types.js";
import type { Repositories } from "../../storage/repositories.js";
import { newId } from "../../utils/id.js";
import { AgentLoadoutService, type AgentLoadoutContext } from "./agent-loadout-service.js";
import { TemporalValidityService } from "./temporal-validity-service.js";

export type AssetRecallRisk = "low" | "high";

export interface AssetRecallRequest extends AgentLoadoutContext {
  eventKey: string;
  risk: AssetRecallRisk;
  episodeId?: string;
  taskId?: string;
  invalidationSignals?: string[];
  semanticScores?: Record<string, number>;
  evidenceIds?: string[];
}

export interface RecalledAsset {
  binding: AgentLoadoutEntry;
  asset: MemoryAssetRecord;
  temporalValidity: MemoryTemporalValidity;
  freshness: MemoryFreshness;
  scoreInputs: Record<string, number | string>;
  offeredEvent: AssetRecallEventRecord;
}

export interface RecordAssetRecallOutcomeInput {
  namespaceId: string;
  agentId: string;
  offeredEventId: string;
  eventKey: string;
  outcome: Exclude<AssetRecallEventRecord["outcome"], "offered">;
  failureReason?: string;
  evidenceIds?: string[];
}

export interface AssetRecallServiceDependencies {
  repositories: Repositories;
  now?: () => string;
  id?: (prefix: string) => string;
}

const defaultNow = (): string => new Date().toISOString();
const defaultId = newId;

export class AssetRecallService {
  private readonly loadouts: AgentLoadoutService;
  private readonly temporalValidity: TemporalValidityService;
  private readonly now: () => string;
  private readonly id: (prefix: string) => string;

  constructor(private readonly deps: AssetRecallServiceDependencies) {
    this.now = deps.now ?? defaultNow;
    this.id = deps.id ?? defaultId;
    this.loadouts = new AgentLoadoutService({ repositories: deps.repositories, now: this.now, id: this.id });
    this.temporalValidity = new TemporalValidityService({ repositories: deps.repositories, now: this.now, id: this.id });
  }

  recall(input: AssetRecallRequest): RecalledAsset[] {
    this.validateRecall(input);
    const at = input.at ?? this.now();
    const eligible = this.loadouts.listAvailable({ ...input, at }).flatMap(({ binding, asset }) => {
      const memoryId = assetMemoryId(asset, this.deps.repositories);
      if (!memoryId) return [];
      const temporalValidity = this.deps.repositories.temporalValidity.get(input.namespaceId, memoryId);
      if (!temporalValidity) return [];
      const projection = this.temporalValidity.project(input.namespaceId, memoryId, {
        at,
        scopeActive: true,
        invalidationSignals: input.invalidationSignals
      });
      if (!projection || !isEligibleForRecall(input, projection.freshness, projection.eligible)) return [];
      const semantic = finiteScore(input.semanticScores?.[asset.id]);
      const validation = validationConfidence(asset);
      return [{
        binding,
        asset,
        memoryId,
        temporalValidity,
        freshness: projection.freshness,
        scoreInputs: {
          semantic,
          validation,
          priority: binding.priority,
          freshness: projection.freshness
        }
      }];
    });

    eligible.sort((left, right) =>
      Number(right.scoreInputs.semantic) - Number(left.scoreInputs.semantic)
      || Number(right.scoreInputs.validation) - Number(left.scoreInputs.validation)
      || right.binding.priority - left.binding.priority
      || left.binding.id.localeCompare(right.binding.id)
    );

    return this.deps.repositories.transaction(() => eligible.map((candidate) => {
      const offeredEvent = this.deps.repositories.assetRecallEvents.append({
        id: this.id("asset-recall"),
        namespaceId: input.namespaceId,
        assetId: candidate.asset.id,
        assetVersion: candidate.asset.version,
        agentId: input.agentId,
        episodeId: input.episodeId,
        taskId: input.taskId,
        loadoutEntryId: candidate.binding.id,
        mode: input.mode,
        eventKey: input.eventKey,
        outcome: "offered",
        temporalValidityVersion: candidate.temporalValidity.version,
        freshnessAtRecall: candidate.freshness,
        eligibilityEvaluatedAt: at,
        scoreInputs: candidate.scoreInputs,
        evidenceIds: unique([
          candidate.memoryId,
          ...candidate.asset.sourceMemoryIds,
          ...candidate.asset.sourceEpisodeIds,
          ...candidate.asset.sourceTraceIds,
          ...candidate.asset.sourceTopicIds,
          ...(input.evidenceIds ?? [])
        ]),
        createdAt: at
      });
      return { ...candidate, offeredEvent };
    }));
  }

  recordOutcome(input: RecordAssetRecallOutcomeInput): AssetRecallEventRecord {
    if (!input.namespaceId.trim() || !input.agentId.trim() || !input.offeredEventId.trim() || !input.eventKey.trim()) {
      throw new Error("asset recall outcome requires namespaceId, agentId, offeredEventId, and eventKey");
    }
    if (input.outcome === "failed" && !input.failureReason?.trim()) {
      throw new Error("failed asset recall outcome requires failureReason");
    }
    const offered = this.deps.repositories.assetRecallEvents.get(input.namespaceId, input.offeredEventId);
    if (!offered || offered.outcome !== "offered") throw new Error("offered asset recall event not found");
    if (offered.agentId !== input.agentId) {
      throw new Error("asset recall outcome agent does not match offered event");
    }
    const at = this.now();
    return this.deps.repositories.assetRecallEvents.append({
      ...offered,
      id: this.id("asset-recall"),
      offeredEventId: offered.id,
      eventKey: input.eventKey,
      outcome: input.outcome,
      failureReason: input.failureReason,
      evidenceIds: unique([...offered.evidenceIds, ...(input.evidenceIds ?? [])]),
      createdAt: at
    });
  }

  private validateRecall(input: AssetRecallRequest): void {
    if (!input.namespaceId.trim() || !input.agentId.trim() || !input.eventKey.trim()) {
      throw new Error("asset recall requires namespaceId, agentId, and eventKey");
    }
    if (!input.risk) throw new Error("asset recall requires an explicit risk classification");
  }
}

function isEligibleForRecall(
  input: AssetRecallRequest,
  freshness: MemoryFreshness,
  projectionEligible: boolean
): boolean {
  if (projectionEligible && freshness === "current") return true;
  return freshness === "review_due" && input.mode !== "bootstrap" && input.risk === "low";
}

function assetMemoryId(asset: MemoryAssetRecord, repositories: Repositories): string | undefined {
  const provenanceId = asset.provenance.skillMemoryId;
  if (typeof provenanceId === "string" && provenanceId.trim()) return provenanceId;
  const match = /^memory:\/\/(.+)\/v\d+$/.exec(asset.contentRef);
  const contentId = match?.[1];
  return contentId && repositories.memories.get(contentId) ? contentId : undefined;
}

function finiteScore(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function validationConfidence(asset: MemoryAssetRecord): number {
  return asset.validation.attempts > 0 ? asset.validation.successes / asset.validation.attempts : 0;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim()))];
}
