import type { ProjectContextStableResult } from "./service/project-context/project-context-types.js";

export type IsoTime = string;
export const DEFAULT_NAMESPACE_SOURCE = "unknown";
export type Cursor = string;
export type MemoryLayer = "L1" | "L2" | "L3" | "Skill";
export type MemoryKind = "trace" | "span" | "policy" | "world_model" | "skill";
export type MemoryStatus = "activated" | "resolving" | "archived" | "deleted";
export type MemoryRelation = "supersedes";

export interface MemoryProvenance {
  sourceAgent: string;
  tenantId?: string;
  profileId?: string;
  projectId?: string;
  workspaceId?: string;
  workspacePath?: string;
  sessionId?: string;
  turnId?: string;
  adapterId?: string;
  requestId?: string;
  sourceMemoryIds: string[];
  repository?: string;
  branch?: string;
  commit?: string;
  capturedAt: IsoTime;
}
export type RetrievalMode =
  | "search"
  | "turn_start"
  | "tool_driven"
  | "skill_invoke"
  | "sub_agent"
  | "decision_repair"
  | "world_model";
export type JobStatus = "queued" | "leased" | "succeeded" | "failed" | "dead_letter";
export type MemoryProcessingState =
  | "summary_pending"
  | "summarizing"
  | "embedding_pending"
  | "embedding"
  | "ready"
  | "ready_text_only"
  | "failed";
export type MemoryProcessingStage = "summary" | "embedding";
export type MemoryProcessingRetryAction = "retry" | "open_settings" | "none";

export interface MemoryProcessingRecord {
  memoryId: string;
  state: MemoryProcessingState;
  stage?: MemoryProcessingStage | null;
  activeJobId?: string | null;
  attemptCount: number;
  manualRetryCount: number;
  retryAction: MemoryProcessingRetryAction;
  errorCode?: string | null;
  errorMessage?: string | null;
  failedAt?: IsoTime | null;
  updatedAt: IsoTime;
}
export type JobType =
  | "episode_idle_close"
  | "trace_summary"
  | "import_summary"
  | "reflection"
  | "embedding"
  | "reward"
  | "span_big_turn"
  | "negative_experience"
  | "l2_association"
  | "l2_induction"
  | "l3_abstraction"
  | "skill_crystallization"
  | "skill_trial_resolve"
  | "topic_ingest"
  | "topic_refresh";

export interface RuntimeNamespace {
  source: string;
  profileId: string;
  profileLabel?: string;
  projectId?: string;
  workspaceId?: string;
  workspacePath?: string;
  sessionKey?: string;
  userId?: string;
  tenantId?: string;
}

export interface RequestEnvelope {
  requestId?: string;
  adapterId?: string;
  source?: string;
  namespace?: RuntimeNamespace;
}

export type MemoryAssetType = "chat_memory" | "skill" | "wiki" | "code_graph";
export type MemoryAssetStatus = "candidate" | "reviewing" | "active" | "deprecated" | "rejected";
export type MemoryAssetVisibility = "private" | "team" | "restricted" | "agent";

export interface AssetApplicability {
  scope: "work_item" | "plan" | "project" | "namespace" | "global";
  taskTypes: string[];
  projectIds: string[];
  planIds: string[];
  workItemIds: string[];
  requiredSignals: string[];
  excludedSignals: string[];
  invocationHints: string[];
  validFrom?: IsoTime;
  validUntil?: IsoTime;
  retireWhen: "work_item_completed" | "plan_completed" | "project_completed" | "explicit" | "never";
}

export interface AssetValidationStats {
  attempts: number;
  successes: number;
  failures: number;
  unknowns: number;
  transferRewardSum: number;
  riskPenaltySum: number;
  lastUsedAt?: IsoTime;
  lastValidatedAt?: IsoTime;
}

export interface MemoryAssetRecord {
  id: string;
  namespaceId: string;
  assetType: MemoryAssetType;
  stableKey: string;
  version: number;
  status: MemoryAssetStatus;
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
  validation: AssetValidationStats;
  provenance: Record<string, unknown>;
  createdAt: IsoTime;
  updatedAt: IsoTime;
}

export type AgentLoadoutMode = "bootstrap" | "recall" | "tool";

export interface AgentLoadoutEntry {
  id: string;
  namespaceId: string;
  agentId: string;
  assetId: string;
  assetVersion: number;
  mode: AgentLoadoutMode;
  priority: number;
  enabled: boolean;
  projectId?: string;
  planId?: string;
  workItemId?: string;
  taskTypes: string[];
  retireWhen: AssetApplicability["retireWhen"];
  createdAt: IsoTime;
  updatedAt: IsoTime;
}

export interface AssetRecallEventRecord {
  id: string;
  namespaceId: string;
  assetId: string;
  assetVersion: number;
  agentId: string;
  episodeId?: string;
  taskId?: string;
  loadoutEntryId?: string;
  offeredEventId?: string;
  mode: AgentLoadoutMode;
  eventKey: string;
  outcome: "offered" | "used" | "ignored" | "failed";
  temporalValidityVersion: number;
  freshnessAtRecall: MemoryFreshness;
  eligibilityEvaluatedAt: IsoTime;
  scoreInputs: Record<string, unknown>;
  failureReason?: string;
  evidenceIds: string[];
  createdAt: IsoTime;
}

export interface ExperienceSequenceRecord {
  id: string;
  namespaceId: string;
  title: string;
  metadata: Record<string, unknown>;
  createdAt: IsoTime;
}

export interface ExperienceSequenceMemberRecord {
  id: string;
  namespaceId: string;
  sequenceId: string;
  episodeId: string;
  position: number;
  role: "solve" | "curate" | "verify";
  taskId?: string;
  planId?: string;
  workItemId?: string;
  topicId?: string;
  provenance: Record<string, unknown>;
  createdAt: IsoTime;
}

export interface AssetRewardEvidenceRecord {
  id: string;
  namespaceId: string;
  eventKey: string;
  sequenceId: string;
  sourceEpisodeId: string;
  targetEpisodeId: string;
  assetId: string;
  assetVersion: number;
  recallEventId: string;
  relation: "explicit_sequence" | "asset_usage" | "plan_work_item" | "none";
  targetTaskReward: number;
  usageFactor: number;
  relationConfidence: number;
  applicabilityFactor: number;
  transferReward: number;
  riskPenalty: number;
  outcome: "success" | "failure" | "unknown";
  reason: string;
  evidenceIds: string[];
  createdAt: IsoTime;
}

export type MemoryFreshness = "current" | "review_due" | "stale" | "superseded" | "historical";

export interface MemoryTemporalValidity {
  namespaceId: string;
  memoryId: string;
  observedAt: IsoTime;
  effectiveFrom?: IsoTime;
  effectiveUntil?: IsoTime;
  reviewAfter?: IsoTime;
  freshness: MemoryFreshness;
  invalidationKeys: string[];
  invalidatedAt?: IsoTime;
  invalidationReason?: string;
  supersededByMemoryId?: string;
  lastReviewedAt?: IsoTime;
  version: number;
}

export interface MemoryTemporalValidityEvent {
  id: string;
  namespaceId: string;
  memoryId: string;
  validityVersion: number;
  type: "initialized" | "review_due" | "reviewed" | "invalidated" | "superseded" | "historical";
  actor: Record<string, unknown>;
  reason: string;
  evidenceIds: string[];
  projectStateRef: Record<string, unknown>;
  createdAt: IsoTime;
}

export type {
  ProjectContextProposeGoalRequest,
  ProjectContextReadState,
  ProjectContextRequest,
  ProjectContextStableResult,
  ProjectFactRecord,
  ProjectGoalRecord,
  ProjectWorkItemRecord
} from "./service/project-context/project-context-types.js";

export type ProjectTopicStatus = "active" | "archived" | "merged";
export type ProjectTopicCandidateStatus = "pending" | "approved" | "rejected" | "deferred" | "superseded";
export interface ProjectTopicRecord {
  id: string; namespaceId: string; projectId?: string; title: string; summary: string;
  status: ProjectTopicStatus; version: number; sourceMemoryIds: string[];
  metadata: Record<string, unknown>; createdAt: IsoTime; updatedAt: IsoTime;
}
export interface ProjectTopicEvidenceRecord {
  id: string; topicId: string; namespaceId: string; memoryId: string; role: string;
  summary: string; metadata: Record<string, unknown>; createdAt: IsoTime;
}
export interface ProjectTopicCandidateRecord {
  id: string; topicId: string; namespaceId: string; title: string; conclusion: string;
  proposedLayer: "L2" | "L3" | "Skill"; status: ProjectTopicCandidateStatus; version: number;
  supersedesId?: string; sourceMemoryIds: string[]; metadata: Record<string, unknown>;
  createdAt: IsoTime; updatedAt: IsoTime;
}
export interface ProjectTopicAnalysisRunRecord {
  id: string; namespaceId: string; inputHash: string; topicId?: string; status: string;
  result: Record<string, unknown>; createdAt: IsoTime; updatedAt: IsoTime;
}

export type TopicDecisionState =
  | "draft" | "gathering_evidence" | "debating" | "ready_for_decision"
  | "awaiting_user_input" | "blocked_by_evidence" | "executing"
  | "completed" | "stale" | "failed" | "cancelled";

export type TopicEvidenceVerification =
  | "repository_verified" | "tool_verified" | "user_authoritative"
  | "user_supplied_unverified" | "contradicted";

export type TopicActionEffect =
  | "read" | "analyze" | "draft" | "create_candidate_task"
  | "authoritative_write" | "external_write" | "delete"
  | "topic_mutation" | "memory_promotion";

export interface TopicDecisionSessionRecord {
  id: string;
  namespaceId: string;
  topicId: string;
  inputHash: string;
  state: TopicDecisionState;
  version: number;
  metadata: Record<string, unknown>;
  createdAt: IsoTime;
  updatedAt: IsoTime;
}

export interface TopicAgentSpec {
  id: string;
  role: string;
  model: string;
  reason: string;
}

export interface TopicDecisionSnapshotPayload {
  topicVersion: number;
  topicTitle?: string;
  topicSummary?: string;
  sourceMemoryIds?: string[];
  evidenceIds: string[];
  evidenceHashes: Record<string, string>;
  evidenceContent: Record<string, string>;
  projectConstraints: Array<Record<string, unknown>>;
  roster: TopicAgentSpec[];
  inputHash: string;
  [key: string]: unknown;
}

export interface TopicDecisionSnapshotRecord {
  id: string;
  namespaceId: string;
  sessionId: string;
  round: number;
  payload: TopicDecisionSnapshotPayload;
  createdAt: IsoTime;
}

export interface TopicAgentPositionRecord {
  id: string;
  namespaceId: string;
  sessionId: string;
  snapshotId: string;
  round: number;
  agentId: string;
  stance: string;
  rationale: string;
  evidenceIds: string[];
  confidence?: number;
  missingInformation?: string[];
  risks?: Array<{ severity: "low" | "medium" | "high"; description: string }>;
  assumptions?: string[];
  createdAt: IsoTime;
}

export interface TopicDebateRoundRecord {
  id: string;
  namespaceId: string;
  sessionId: string;
  round: number;
  status: string;
  summary: string;
  metadata: Record<string, unknown>;
  version: number;
  createdAt: IsoTime;
  updatedAt: IsoTime;
}

export interface TopicEvidenceRequestRecord {
  id: string;
  namespaceId: string;
  sessionId: string;
  round: number;
  question: string;
  answer?: string;
  verification: TopicEvidenceVerification;
  status: string;
  metadata: Record<string, unknown>;
  version: number;
  createdAt: IsoTime;
  updatedAt: IsoTime;
}

export interface TopicActionProposalRecord {
  id: string;
  namespaceId: string;
  sessionId: string;
  round: number;
  rank: number;
  effect: TopicActionEffect;
  title: string;
  payload: Record<string, unknown>;
  status: string;
  version: number;
  metadata: Record<string, unknown>;
  createdAt: IsoTime;
  updatedAt: IsoTime;
}

export interface TopicExecutionRunRecord {
  id: string;
  namespaceId: string;
  sessionId: string;
  proposalId: string;
  status: string;
  result: Record<string, unknown>;
  version: number;
  createdAt: IsoTime;
  updatedAt: IsoTime;
}


export interface ApiErrorBody {
  error: {
    code:
      | "invalid_argument"
      | "unauthorized"
      | "forbidden"
      | "not_found"
      | "conflict"
      | "rate_limited"
      | "internal";
    message: string;
    requestId?: string;
  };
}

export interface JobRef {
  jobId: string;
  jobType: JobType;
  status: JobStatus;
  targetMemoryId?: string;
}

export interface MemoryRow {
  id: string;
  timeline: IsoTime;
  userId: string;
  conversationId?: string;
  sessionId?: string;
  agentId?: string;
  appId?: string;
  memoryType: "LongTermMemory" | "SkillMemory" | string;
  status: MemoryStatus;
  visibility: "private" | "public" | "session" | string;
  memoryKey?: string;
  memoryValue: string;
  tags: string[];
  info: Record<string, unknown>;
  properties: {
    memory_type?: string;
    status?: MemoryStatus;
    tags?: string[];
    info?: Record<string, unknown>;
    internal_info: Record<string, unknown> & {
      memory_layer: MemoryLayer;
      memory_kind?: MemoryKind;
      schema_version?: number;
    };
    [key: string]: unknown;
  };
  memoryLayer: MemoryLayer;
  contentHash?: string | null;
  version: number;
  createdAt: IsoTime;
  updatedAt: IsoTime;
  deletedAt?: IsoTime | null;
}

export interface MemoryFilter {
  tenantId?: string;
  userId?: string;
  projectId?: string;
  workspaceId?: string;
  sessionId?: string;
  conversationId?: string;
  agentId?: string;
  excludedAgentIds?: string[];
  appId?: string;
  memoryLayer?: MemoryLayer | MemoryLayer[];
  status?: MemoryStatus | MemoryStatus[];
  tags?: string[];
  ids?: string[];
}

export interface RecallHit {
  id: string;
  kind: MemoryKind;
  memoryLayer: MemoryLayer;
  status: MemoryStatus;
  title?: string;
  snippet: string;
  score: number;
  tags: string[];
  updatedAt?: IsoTime;
  source: "search" | "episode" | "rule" | "skill";
}

export interface InjectedContext {
  markdown: string;
  sections: Array<{
    id: string;
    title: string;
    kind: MemoryKind;
    memoryLayer: MemoryLayer;
    memoryIds: string[];
    content: string;
    tokenEstimate?: number;
  }>;
  tokenEstimate?: number;
}

export interface MemoryListItem {
  id: string;
  kind: MemoryKind;
  memoryLayer: MemoryLayer;
  status: MemoryStatus;
  title: string;
  summary: string;
  tags: string[];
  metrics?: {
    value?: number;
    alpha?: number;
    reflectionDone: boolean;
  };
  metadata?: Record<string, unknown>;
  createdAt: IsoTime;
  updatedAt: IsoTime;
  version: number;
  processing?: MemoryProcessingRecord;
}

export interface MemoryDetailItem extends MemoryListItem {
  body: string;
  createdAt: IsoTime;
  sourceMemoryIds: string[];
  metadata: Record<string, unknown>;
  provenance?: MemoryProvenance;
  relations?: Array<{
    id: string;
    projectId?: string;
    sourceMemoryId: string;
    targetMemoryId: string;
    relation: MemoryRelation;
    reason?: string;
    actor: Record<string, unknown>;
    createdAt: IsoTime;
  }>;
  supersession?: {
    supersedesMemoryIds: string[];
    supersededByMemoryId?: string;
    reason?: string;
  };
}

export interface RawTurnSummary {
  rawTurnId: string;
  episodeId: string;
  turnId: string;
  userText?: string;
  assistantText?: string;
  reasoningSummary?: string;
  toolCalls?: unknown[];
  toolResults?: unknown[];
  createdAt: IsoTime;
}

export interface ToolCallPayload {
  id?: string;
  name: string;
  input?: unknown;
  output?: unknown;
  error?: string;
  errorCode?: string;
  success?: boolean;
  startedAt?: IsoTime;
  endedAt?: IsoTime;
  thinkingBefore?: string;
  assistantTextBefore?: string;
}

export interface SessionCompactRequest extends RequestEnvelope {
  episodeId?: string;
  summary?: string;
  sourceTurnIds?: string[];
  sourceMemoryIds?: string[];
  tokenEstimate?: number;
  createL1?: boolean;
  checkpoint?: SessionCheckpointPayload;
}

export interface SessionCheckpointPayload {
  task: string;
  changes: string[];
  validated: string[];
  unverified: string[];
  nextSteps: string[];
}

export interface SessionCheckpointRequest extends RequestEnvelope {
  episodeId?: string;
  task: string;
  changes?: string[];
  validated?: string[];
  unverified?: string[];
  nextSteps?: string[];
  sourceTurnIds?: string[];
  sourceMemoryIds?: string[];
  tokenEstimate?: number;
  createL1?: boolean;
}

export interface SessionOpenRequest extends RequestEnvelope {
  source?: string;
  profileId?: string;
  projectId?: string;
  workspaceId?: string;
  workspacePath?: string;
  sessionId?: string;
  meta?: Record<string, unknown>;
  protocolVersion?: string;
  provenance?: Partial<MemoryProvenance>;
}

export interface TurnStartResponse {
  contextPacketId: string;
  turnId: string;
  sessionId: string;
  episodeId: string;
  closedEpisodeIds: string[];
  searchEventId: string;
  hits: RecallHit[];
  injectedContext: InjectedContext;
  projectContext: ProjectContextStableResult;
  sourceMemoryIds: string[];
  droppedDueToBudget: Array<{ id: string; kind: MemoryKind; memoryLayer: MemoryLayer; reason: "token_budget"; tokenEstimate?: number }>;
  status: string[];
  serverTime: string;
}

export interface TurnStartRequest extends RequestEnvelope {
  sessionId: string;
  query: string;
  turnId?: string;
  contextHints?: Record<string, unknown>;
  contextBudget?: number;
  protocolVersion?: string;
  provenance?: Partial<MemoryProvenance>;
}

export interface TurnCompleteRequest extends RequestEnvelope {
  sessionId: string;
  episodeId?: string;
  query: string;
  answer: string;
  reasoningSummary?: string;
  tags?: string[];
  toolCalls?: unknown[];
  toolResults?: unknown[];
  artifacts?: unknown[];
  sourceMemoryIds?: string[];
  protocolVersion?: string;
  provenance?: Partial<MemoryProvenance>;
  usage?: Record<string, unknown>;
  status?: "succeeded" | "failed" | "cancelled";
}

export interface ToolObserveRequest extends RequestEnvelope {
  sessionId: string;
  episodeId?: string;
  turnId?: string;
  toolName: string;
  toolCallId?: string;
  args?: unknown;
  result?: unknown;
  error?: unknown;
  metadata?: Record<string, unknown>;
}

export interface RepairSuggestionRequest extends RequestEnvelope {
  sessionId: string;
  toolName?: string;
  issue: string;
  error?: unknown;
  context?: string;
  metadata?: Record<string, unknown>;
}

export interface SubagentStartRequest extends RequestEnvelope {
  sessionId: string;
  episodeId?: string;
  subagentId?: string;
  task: string;
  metadata?: Record<string, unknown>;
}

export interface SubagentCompleteRequest extends RequestEnvelope {
  sessionId: string;
  episodeId?: string;
  subagentId?: string;
  result?: string;
  summary?: string;
  status?: "succeeded" | "failed" | "cancelled";
  metadata?: Record<string, unknown>;
}

export interface MemorySearchRequest extends RequestEnvelope {
  query: string;
  sessionId?: string;
  episodeId?: string;
  turnId?: string;
  layers?: MemoryLayer[];
  tags?: string[];
  limit?: number;
  contextBudget?: number;
  includeInjectedContext?: boolean;
  verbose?: boolean;
}

export interface MemoryAddRequest extends RequestEnvelope {
  content: string;
  layer?: MemoryLayer;
  title?: string;
  tags?: string[];
  source?: string;
  sessionId?: string;
  turnId?: string;
  createdAt?: string;
  deferProcessing?: boolean;
  sourceMemoryIds?: string[];
  provenance?: Partial<MemoryProvenance>;
  supersedesMemoryId?: string;
  supersessionReason?: string;
}

export interface FeedbackTarget {
  kind: "memory" | "raw_turn" | "recall";
  id: string;
}

export interface FeedbackRequest extends RequestEnvelope {
  sessionId?: string;
  episodeId?: string;
  target?: FeedbackTarget;
  channel: "explicit" | "implicit";
  polarity: "positive" | "negative" | "neutral";
  magnitude?: number;
  rationale?: string;

  // Internal attribution fields. HTTP and CLI expose `target` instead.
  l1MemoryId?: string;
  rawTurnId?: string;
  recallEventId?: string;
  rawPayload?: unknown;
}

export interface SkillUseRequest extends RequestEnvelope {
  sessionId: string;
  episodeId: string;
  l1MemoryId?: string;
  rawTurnId?: string;
  turnId?: string;
  toolCallId?: string;
}

export interface MemoryExportRequest extends RequestEnvelope {
  includeRawText?: boolean;
  includeAudit?: boolean;
}

export interface MemoryImportRequest extends RequestEnvelope {
  bundle: {
    schemaVersion?: number;
    exportedAt?: IsoTime;
    tables: Record<string, unknown>;
    manifest?: Record<string, unknown>;
  };
  conflictStrategy?: "skip" | "replace" | "error";
}

export interface MemoryGovernanceRequest extends RequestEnvelope {
  reason?: string;
  version?: number;
}

export interface MemoryMarkdownExportRequest extends RequestEnvelope {
  includeArchived?: boolean;
}

export interface MemoryMarkdownImportRequest extends RequestEnvelope {
  markdown: string;
  apply?: boolean;
}

export interface RawTurnRedactRequest extends RequestEnvelope {
  reason?: string;
  mode?: "redact" | "delete";
}

export interface HealthResponse {
  ok: boolean;
  version: string;
  uptimeMs: number;
  mode: "local" | "cloud" | "dev";
  activeProfile: "account" | "byok";
  storage: {
    backend: "sqlite" | "openmem-cloud-rest";
    backendId?: "sqlite-local" | "openmem-cloud-rest";
    schemaVersion: string;
    ready: boolean;
    lastMigrationId?: string;
    fullText?: "fts5" | "tsvector" | "remote" | "none";
    vector?: "sidecar" | "native" | "remote" | "none";
    changeLog?: boolean;
    idempotency?: boolean;
    jobs?: boolean;
    importExport?: boolean;
  };
  models: {
    summary: {
      provider: string;
      model?: string;
      configured: boolean;
      remote: boolean;
      lastOkAt?: string;
      lastError?: string;
    };
    evolution: {
      provider: string;
      model?: string;
      configured: boolean;
      remote: boolean;
      lastOkAt?: string;
      lastError?: string;
    };
    embedding: {
      provider: string;
      model?: string;
      configured: boolean;
      remote: boolean;
      lastOkAt?: string;
      lastError?: string;
    };
  };
  capabilities: {
    routes: string[];
    tools: string[];
    memoryLayers: MemoryLayer[];
    supportsCli: boolean;
    topicDecisions?: {
      enabled: true;
      models: string[];
    };
  };
  serverTime: IsoTime;
}

export interface MemoryReloadConfigRequest extends RequestEnvelope {
  reason?: string;
  restartFailedProcessing?: boolean;
}

export interface MemoryReloadConfigResponse {
  activeProfile: "account" | "byok";
  changed: boolean;
  requiresRestart: boolean;
  models: HealthResponse["models"];
  reloadedAt: IsoTime;
}
