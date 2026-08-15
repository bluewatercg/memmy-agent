import {
  policyMetaFromMemory,
  skillMetaFromMemory,
  traceMetaFromMemory
} from "../../algorithm/plugin-algorithms.js";
import type { MemmyConfig } from "../../config/index.js";
import type { LlmClient } from "../../model/types.js";
import type {
  EpisodeRecord,
  EvolutionJobRecord,
  Repositories,
  SkillTrialRecord
} from "../../storage/repositories.js";
import type { AssetRewardEvidenceRecord, MemoryAssetRecord, MemoryRow, ToolCallPayload } from "../../types.js";
import { newId } from "../../utils/id.js";
import { nowIso } from "../../utils/time.js";
import type { ScheduleEmbeddingAfterTextUpdateInput } from "../embedding/embedding-job-processor.js";
import { AssetLifecycleService } from "../assets/asset-lifecycle-service.js";
import type { AssetCandidateInput, SkillActivationInput, SkillLifecycleAuditInput } from "../assets/asset-types.js";
import type {
  DecisionRepairTraceSource,
  SynthesizeDecisionRepairDraft
} from "../feedback/feedback-experience.js";
import {
  profileIdFromMemory,
  projectIdFromMemory
} from "../namespace/namespace-scope.js";
import type { EnqueueJobInput } from "../worker/job-handlers.js";
import { NegativeExperiencePipeline } from "./negative-experience-pipeline.js";
import { AssetRewardService } from "./asset-reward-service.js";
import { BigTurnSpanPipeline } from "./big-turn-span-pipeline.js";
import { PolicyInductionEngine } from "./policy-induction.js";
import {
  RewardPipeline,
  type DecisionRepairSummary
} from "./reward-pipeline.js";
import { SkillPipeline } from "./skill-pipeline.js";
import { SpanPipeline } from "./span-pipeline.js";
import { WorldModelPipeline } from "./world-model-pipeline.js";

type TraceMeta = NonNullable<ReturnType<typeof traceMetaFromMemory>>;
type PolicyMeta = NonNullable<ReturnType<typeof policyMetaFromMemory>>;

export interface EvolutionJobProcessorDeps {
  repos: Repositories;
  config: MemmyConfig;
  llm: LlmClient;
  skillLlm: LlmClient;
  traceMeta(memory: MemoryRow | undefined | null): TraceMeta | null;
  namespaceIdFromMemory(memory: MemoryRow): string;
  buildMemory(input: Record<string, unknown>): MemoryRow;
  enqueueJob(input: EnqueueJobInput): EvolutionJobRecord;
  enqueueEpisodeRewardAfterReflection(
    episode: EpisodeRecord,
    at: string,
    trigger: string
  ): EvolutionJobRecord[];
  finalizeClosedEpisode(
    episode: EpisodeRecord,
    at: string,
    trigger: "episode_rewarded"
  ): EvolutionJobRecord[];
  resolvePendingSkillTrialsForReward(input: {
    userId: string;
    episodeId: string;
    rHuman: number;
    feedbackId?: string;
    at: string;
  }): void;
  decisionRepairTraceSources(memories: MemoryRow[]): DecisionRepairTraceSource[];
  synthesizeDecisionRepairDraft: SynthesizeDecisionRepairDraft;
  scheduleEmbeddingAfterTextUpdate(input: ScheduleEmbeddingAfterTextUpdateInput): void;
  repairEvidenceValueDiff(highValue: MemoryRow[], lowValue: MemoryRow[]): number;
}

export class EvolutionJobProcessor {
  private readonly policy: PolicyInductionEngine;
  private readonly negativeExperience: NegativeExperiencePipeline;
  private readonly reward: RewardPipeline;
  private readonly skill: SkillPipeline;
  private readonly span: SpanPipeline;
  private readonly bigTurnSpan: BigTurnSpanPipeline;
  private readonly worldModel: WorldModelPipeline;
  private readonly assets: AssetLifecycleService;
  private readonly assetRewards: AssetRewardService;

  constructor(private readonly deps: EvolutionJobProcessorDeps) {
    const owner = this;
    this.assets = new AssetLifecycleService({
      repositories: deps.repos,
      now: nowIso,
      id: newId,
      skillActivation: {
        minimumTrials: deps.config.algorithm.skill.candidateTrials,
        minimumEta: deps.config.algorithm.skill.minEtaForRetrieval
      }
    });
    this.assetRewards = new AssetRewardService({
      repositories: deps.repos,
      now: nowIso,
      id: newId
    });
    this.skill = new SkillPipeline({
      repos: deps.repos,
      get config() { return owner.deps.config; },
      get skillLlm() { return owner.deps.skillLlm; },
      traceMeta: deps.traceMeta,
      buildMemory: deps.buildMemory,
      upsertEvolutionMemory: this.upsertEvolutionMemory.bind(this),
      upsertSkillAssetCandidate: (input, version) => {
        this.assets.upsertCandidateVersion(input, version);
      },
      isArchivedEvolutionMemory: this.isArchivedEvolutionMemory.bind(this),
      enqueueJob: deps.enqueueJob,
      namespaceIdFromMemory: deps.namespaceIdFromMemory
    });
    this.policy = new PolicyInductionEngine({
      get config() { return owner.deps.config; },
      repos: deps.repos,
      nowIso,
      get skillLlm() { return owner.deps.skillLlm; },
      traceMeta: deps.traceMeta,
      projectIdFromMemory,
      profileIdFromMemory,
      buildMemory: deps.buildMemory,
      upsertEvolutionMemory: this.upsertEvolutionMemory.bind(this),
      enqueueJob: deps.enqueueJob,
      enqueueChange: deps.repos.runtime.appendChange.bind(deps.repos.runtime),
      namespaceIdFromMemory: deps.namespaceIdFromMemory,
      onSkillRewardDrift: this.skill.applySkillRewardDriftForPolicy.bind(this.skill)
    });
    this.worldModel = new WorldModelPipeline({
      repos: deps.repos,
      get config() { return owner.deps.config; },
      get skillLlm() { return owner.deps.skillLlm; },
      traceMeta: deps.traceMeta,
      buildMemory: deps.buildMemory,
      upsertEvolutionMemory: this.upsertEvolutionMemory.bind(this),
      isArchivedEvolutionMemory: this.isArchivedEvolutionMemory.bind(this),
      enqueueJob: deps.enqueueJob,
      namespaceIdFromMemory: deps.namespaceIdFromMemory
    });
    this.span = new SpanPipeline({
      repos: deps.repos,
      get config() { return owner.deps.config; },
      get llm() { return owner.deps.llm; },
      get skillLlm() { return owner.deps.skillLlm; },
      traceMeta: deps.traceMeta,
      namespaceIdFromMemory: deps.namespaceIdFromMemory,
      enqueueJob: deps.enqueueJob,
      enqueueEpisodeRewardAfterReflection: deps.enqueueEpisodeRewardAfterReflection,
      scheduleEmbeddingAfterTextUpdate: deps.scheduleEmbeddingAfterTextUpdate
    });
    this.bigTurnSpan = new BigTurnSpanPipeline({
      repos: deps.repos,
      get llm() { return owner.deps.llm; },
      buildMemory: deps.buildMemory,
      enqueueJob: deps.enqueueJob,
      namespaceIdFromMemory: deps.namespaceIdFromMemory,
      embedAfterCapture: () => owner.deps.config.algorithm.capture.embedAfterCapture
    });
    this.reward = new RewardPipeline({
      get config() { return owner.deps.config; },
      repos: deps.repos,
      get llm() { return owner.deps.llm; },
      nowIso,
      newId,
      traceMeta: deps.traceMeta,
      namespaceIdFromMemory: deps.namespaceIdFromMemory,
      enqueueJob: deps.enqueueJob,
      finalizeClosedEpisode: deps.finalizeClosedEpisode,
      recordAssetRewardForEpisode: (episode, source) => {
        this.assetRewards.recordForEpisode({
          namespaceId: deps.namespaceIdFromMemory(source),
          targetEpisodeId: episode.id,
          targetTaskReward: episode.rTask ?? 0
        });
      },
      resolvePendingSkillTrialsForReward: deps.resolvePendingSkillTrialsForReward,
      decisionRepairTraceSources: deps.decisionRepairTraceSources,
      synthesizeDecisionRepairDraft: deps.synthesizeDecisionRepairDraft,
      isTraceEligibleForL2: this.policy.isTraceEligibleForL2.bind(this.policy),
      recordCandidatePoolTrace: this.policy.recordCandidatePoolTrace.bind(this.policy),
      repairEvidenceValueDiff: deps.repairEvidenceValueDiff
    });
    this.negativeExperience = new NegativeExperiencePipeline({
      repos: deps.repos,
      get config() { return owner.deps.config; },
      buildMemory: deps.buildMemory,
      upsertEvolutionMemory: this.upsertEvolutionMemory.bind(this),
      enqueueJob: deps.enqueueJob,
      namespaceIdFromMemory: deps.namespaceIdFromMemory
    });
  }

  induceL2(job: EvolutionJobRecord): Promise<void> {
    return this.policy.induceL2(job);
  }

  associateL2(job: EvolutionJobRecord): void {
    return this.policy.associateL2(job);
  }

  abstractL3(job: EvolutionJobRecord): Promise<void> {
    return this.worldModel.abstractL3(job);
  }

  crystallizeSkill(job: EvolutionJobRecord): Promise<void> {
    return this.skill.crystallizeSkill(job);
  }
  recordResolvedSkillTrial(input: {
    trial: SkillTrialRecord;
    skillMemory: MemoryRow;
    eta: number;
    at: string;
  }): void {
    const asset = this.assets.recordResolvedSkillTrial({
      namespaceId: this.deps.namespaceIdFromMemory(input.skillMemory),
      stableKey: input.skillMemory.memoryKey ?? input.skillMemory.id,
      trialId: input.trial.id,
      episodeId: input.trial.episodeId,
      traceId: input.trial.l1MemoryId,
      reward: input.trial.outcome === "success" ? 1 : 0,
      outcome: input.trial.outcome === "cancelled" ? "unknown" : input.trial.outcome,
      eta: input.eta,
      actorId: "worker.skill-trial-resolver",
      reason: `Resolved Skill trial ${input.trial.id}`
    });
    if (asset?.status !== "reviewing" || skillMetaFromMemory(input.skillMemory)?.status !== "active") return;
    this.assets.activateSkill({
      namespaceId: asset.namespaceId,
      assetId: asset.id,
      assetVersion: asset.version,
      actorId: "worker.skill-trial-resolver",
      reason: `Skill ${input.skillMemory.id} passed configured automatic activation thresholds`,
      evidenceIds: [input.trial.id, input.trial.episodeId, input.trial.l1MemoryId]
        .filter((id): id is string => Boolean(id)),
      approved: true,
      unresolvedHighRiskConflicts: []
    });
  }

  createAssetCandidate(input: AssetCandidateInput): MemoryAssetRecord {
    return this.assets.createCandidate(input);
  }

  reviewSkill(input: SkillLifecycleAuditInput): MemoryAssetRecord {
    return this.assets.submitForReview(input);
  }

  activateSkill(input: SkillActivationInput): MemoryAssetRecord {
    return this.assets.activateSkill(input);
  }

  deprecateSkill(input: SkillLifecycleAuditInput): MemoryAssetRecord {
    return this.assets.deprecateSkill(input);
  }

  recordAssetReward(input: {
    namespaceId: string;
    targetEpisodeId: string;
    targetTaskReward: number;
  }): AssetRewardEvidenceRecord[] {
    return this.assetRewards.recordForEpisode(input);
  }


  reflectTrace(job: EvolutionJobRecord): Promise<void> {
    return this.span.reflectTrace(job);
  }

  applyReward(job: EvolutionJobRecord): Promise<void> {
    return this.reward.applyReward(job);
  }

  splitBigTurn(job: EvolutionJobRecord): Promise<void> {
    return this.bigTurnSpan.splitAndStore(job);
  }

  materializeNegativeExperience(job: EvolutionJobRecord): void {
    this.negativeExperience.materialize(job);
  }

  summarizeTraceForCapture(input: {
    trace: TraceMeta;
    userText: string;
    agentText: string;
    toolCalls: ToolCallPayload[];
    reflectionText: string;
  }, options: { strict?: boolean } = {}): Promise<string> {
    return this.span.summarizeTraceForCapture(input, options);
  }

  findExistingSkillForPolicy(policy: PolicyMeta) {
    return this.skill.findExistingSkillForPolicy(policy);
  }

  upsertEvolutionMemory(memory: MemoryRow): {
    memory: MemoryRow;
    created: boolean;
    previous?: MemoryRow;
  } {
    const previous = memory.memoryKey
      ? this.deps.repos.memories.getByKey(memory.memoryLayer, memory.memoryKey)
      : undefined;
    if (previous && this.isArchivedEvolutionMemory(previous)) {
      return {
        memory: this.deps.repos.memories.insert(memory),
        created: true
      };
    }
    return this.deps.repos.memories.upsertByKey(memory);
  }

  private isArchivedEvolutionMemory(memory: MemoryRow): boolean {
    if (memory.status === "archived") return true;
    if (memory.memoryLayer === "L2") {
      return policyMetaFromMemory(memory)?.status === "archived";
    }
    if (memory.memoryLayer === "Skill") {
      return skillMetaFromMemory(memory)?.status === "archived";
    }
    return false;
  }
}

export type { DecisionRepairSummary };
