import type {
  HealthResponse, MemoryAddRequest, MemoryGovernanceRequest, MemoryMarkdownImportRequest, MemoryReloadConfigRequest,
  MemoryReloadConfigResponse, MemorySearchRequest, RequestEnvelope, RuntimeNamespace, SessionCheckpointRequest, SessionOpenRequest,
  TopicAgentSpec, TurnCompleteRequest, TurnStartRequest
} from "../types.js";
import type {
  TopicCandidateDecisionInput, TopicCandidateDecisionOutput, TopicInboxEvidenceInput, TopicInboxEvidenceOutput,
  TopicInboxListInput, TopicInboxListOutput, TopicInboxMergeInput, TopicInboxMergeOutput, TopicInboxRefreshInput,
  TopicInboxRefreshOutput, TopicInboxSplitInput, TopicInboxSplitOutput
} from "@memmy/local-api-contracts";
import {
  L3WorldModelBoundaryResponseSchema,
  L3WorldModelTraceHeadResponseSchema,
  SessionL3WorldModelContextResponseSchema,
  l3WorldModelGetTransport,
  type L3WorldModelBoundaryRequest,
  type L3WorldModelBoundaryResponse,
  type L3WorldModelRequestEnvelope,
  type L3WorldModelTraceHeadResponse,
  type SessionL3WorldModelContextResponse
} from "../contracts/index.js";
import { resolveTimeZone } from "../utils/time.js";

export type MemoryRestQueryValue =
  | string
  | number
  | boolean
  | readonly string[]
  | readonly number[]
  | undefined;
export type MemoryRestQuery = Record<string, MemoryRestQueryValue>;

export interface MemoryRestClientOptions {
  endpoint: string;
  token?: string;
  headers?: Record<string, string>;
  timeZone?: string;
}
export interface AssetRecallRequestBody {
  mode: "bootstrap" | "recall" | "tool";
  eventKey: string;
  risk: "low" | "high";
  projectId?: string;
  planId?: string;
  workItemId?: string;
  taskType?: string;
  signals: string[];
  at?: string;
  episodeId?: string;
  taskId?: string;
  invalidationSignals?: string[];
  semanticScores?: Record<string, number>;
  evidenceIds?: string[];
}

export interface AssetRecallOutcomeBody {
  eventKey: string;
  outcome: "used" | "ignored" | "failed";
  failureReason?: string;
  evidenceIds?: string[];
}

export type TemporalValidityMutationBody = {
  action: "initialize";
  expectedVersion: 0;
  observedAt: string;
  effectiveFrom?: string;
  effectiveUntil?: string;
  reviewAfter?: string;
  invalidationKeys?: string[];
  reason: string;
  evidenceIds: string[];
  projectStateRef: Record<string, unknown>;
} | {
  action: "review";
  expectedVersion: number;
  at: string;
  reviewAfter?: string;
  reason: string;
  evidenceIds: string[];
  projectStateRef: Record<string, unknown>;
} | {
  action: "invalidate";
  expectedVersion: number;
  at: string;
  invalidationKeys: string[];
  reason: string;
  evidenceIds: string[];
  projectStateRef: Record<string, unknown>;
} | {
  action: "supersede";
  expectedVersion: number;
  at: string;
  supersededByMemoryId: string;
  reason: string;
  evidenceIds: string[];
  projectStateRef: Record<string, unknown>;
};

export interface TemporalValidityQuery {
  at?: string;
  scopeActive?: boolean;
  invalidationSignals?: string[];
}

export class MemoryRestClient {
  private readonly endpoint: string;
  private readonly token?: string;
  private readonly headers: Record<string, string>;
  private readonly timeZone: string;

  constructor(options: MemoryRestClientOptions) {
    this.endpoint = options.endpoint.replace(/\/+$/, "");
    this.token = options.token;
    this.headers = options.headers ?? {};
    this.timeZone = resolveTimeZone(options.timeZone);
  }

  health(): Promise<HealthResponse> {
    return this.request("GET", "/api/v1/health") as Promise<HealthResponse>;
  }

  reloadConfig(request: MemoryReloadConfigRequest = {}): Promise<MemoryReloadConfigResponse> {
    return this.request("POST", "/api/v1/admin/reload-config", request) as Promise<MemoryReloadConfigResponse>;
  }

  openSession(request: SessionOpenRequest): Promise<unknown> {
    return this.request("POST", "/api/v1/sessions/open", request);
  }

  closeSession(sessionId: string, request: RequestEnvelope = {}): Promise<unknown> {
    return this.request("POST", `/api/v1/sessions/${encodeURIComponent(sessionId)}/close`, request);
  }

  checkpointSession(sessionId: string, request: SessionCheckpointRequest): Promise<unknown> {
    return this.request("POST", `/api/v1/sessions/${encodeURIComponent(sessionId)}/checkpoint`, request);
  }

  async l3WorldModelTraceHead(
    sessionId: string,
    envelope: L3WorldModelRequestEnvelope
  ): Promise<L3WorldModelTraceHeadResponse> {
    const transport = l3WorldModelGetTransport(envelope);
    const payload = await this.request(
      "GET",
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/l3-world-model-trace-head${queryString(transport.query)}`,
      undefined,
      transport.headers
    );
    return L3WorldModelTraceHeadResponseSchema.parse(payload);
  }

  async l3WorldModelBoundary(
    sessionId: string,
    request: L3WorldModelBoundaryRequest
  ): Promise<L3WorldModelBoundaryResponse> {
    const payload = await this.request(
      "POST",
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/l3-world-model-boundary`,
      request
    );
    return L3WorldModelBoundaryResponseSchema.parse(payload);
  }

  async l3WorldModelContext(
    sessionId: string,
    envelope: L3WorldModelRequestEnvelope
  ): Promise<SessionL3WorldModelContextResponse> {
    const transport = l3WorldModelGetTransport(envelope);
    const payload = await this.request(
      "GET",
      `/api/v1/l3-world-model/sessions/${encodeURIComponent(sessionId)}/context${queryString(transport.query)}`,
      undefined,
      transport.headers
    );
    return SessionL3WorldModelContextResponseSchema.parse(payload);
  }

  startTurn(request: TurnStartRequest): Promise<unknown> {
    return this.request("POST", "/api/v1/turns/start", request);
  }

  completeTurn(turnId: string, request: TurnCompleteRequest & Record<string, unknown>): Promise<unknown> {
    return this.request("POST", `/api/v1/turns/${encodeURIComponent(turnId)}/complete`, request);
  }

  search(request: MemorySearchRequest): Promise<unknown> {
    return this.request("POST", "/api/v1/memory/search", request);
  }

  addMemory(request: MemoryAddRequest): Promise<unknown> {
    return this.request("POST", "/api/v1/memory/add", request);
  }

  exportMarkdown(includeArchived = false): Promise<unknown> {
    return this.request("GET", `/api/v1/memory/audit/markdown${queryString({ includeArchived })}`);
  }

  importMarkdown(request: MemoryMarkdownImportRequest): Promise<unknown> {
    return this.request("POST", "/api/v1/memory/audit/markdown/import", request);
  }

  getMemory(id: string): Promise<unknown> {
    return this.request("GET", `/api/v1/memory/${encodeURIComponent(id)}`);
  }

  deleteMemory(id: string, request?: MemoryGovernanceRequest): Promise<unknown> {
    return this.request("DELETE", `/api/v1/memory/${encodeURIComponent(id)}`, request);
  }

  panelOverview(query: MemoryRestQuery = {}): Promise<unknown> {
    return this.request("GET", `/api/v1/panel/overview${queryString(query)}`);
  }

  panelAnalysis(query: MemoryRestQuery = {}): Promise<unknown> {
    return this.request("GET", `/api/v1/panel/analysis${queryString(query)}`);
  }

  panelItems(query: MemoryRestQuery = {}): Promise<unknown> {
    return this.request("GET", `/api/v1/panel/items${queryString(query)}`);
  }

  listTopicInbox(input: TopicInboxListInput): Promise<TopicInboxListOutput> {
    return this.request("GET", `/api/v1/topic-inbox${queryString({ namespace: JSON.stringify(input.namespace), statuses: input.statuses })}`) as Promise<TopicInboxListOutput>;
  }

  refreshTopicInbox(input: TopicInboxRefreshInput): Promise<TopicInboxRefreshOutput> {
    return this.request("POST", "/api/v1/topic-inbox/refresh", input) as Promise<TopicInboxRefreshOutput>;
  }

  decideTopicCandidate(candidateId: string, input: TopicCandidateDecisionInput): Promise<TopicCandidateDecisionOutput> {
    return this.request("POST", `/api/v1/topic-inbox/candidates/${encodeURIComponent(candidateId)}/decision`, input) as Promise<TopicCandidateDecisionOutput>;
  }

  mergeTopics(topicId: string, input: TopicInboxMergeInput): Promise<TopicInboxMergeOutput> {
    return this.request("POST", `/api/v1/topic-inbox/topics/${encodeURIComponent(topicId)}/merge`, input) as Promise<TopicInboxMergeOutput>;
  }

  splitTopic(topicId: string, input: TopicInboxSplitInput): Promise<TopicInboxSplitOutput> {
    return this.request("POST", `/api/v1/topic-inbox/topics/${encodeURIComponent(topicId)}/split`, input) as Promise<TopicInboxSplitOutput>;
  }

  topicEvidence(topicId: string, input: TopicInboxEvidenceInput): Promise<TopicInboxEvidenceOutput> {
    return this.request("GET", `/api/v1/topic-inbox/topics/${encodeURIComponent(topicId)}/evidence${queryString({ namespace: JSON.stringify(input.namespace), limit: input.limit })}`) as Promise<TopicInboxEvidenceOutput>;
  }

  startTopicDecision(topicId: string, input: { namespace: RuntimeNamespace; agents?: TopicAgentSpec[]; adapterId: string; requestId: string }): Promise<{ session: unknown; snapshot: unknown; reused: boolean }> {
    return this.request("POST", `/api/v1/topic-inbox/topics/${encodeURIComponent(topicId)}/decisions`, input) as Promise<{ session: unknown; snapshot: unknown; reused: boolean }>;
  }

  readTopicDecision(sessionId: string, namespace?: RuntimeNamespace): Promise<{ session: unknown; snapshots: unknown[]; positions?: unknown[]; debateRounds?: unknown[]; evidenceRequests?: unknown[]; proposals?: unknown[]; executionRuns?: unknown[] }> {
    const query = namespace ? queryString({ namespace: JSON.stringify(namespace) }) : "";
    return this.request("GET", `/api/v1/topic-inbox/decisions/${encodeURIComponent(sessionId)}${query}`) as Promise<{ session: unknown; snapshots: unknown[]; positions?: unknown[]; debateRounds?: unknown[]; evidenceRequests?: unknown[]; proposals?: unknown[]; executionRuns?: unknown[] }>;
  }

  patchTopicDecisionAgents(sessionId: string, input: { namespace: RuntimeNamespace; agents: TopicAgentSpec[]; expectedVersion: number; adapterId: string; requestId: string }): Promise<{ session: unknown; snapshots: unknown[] }> {
    return this.request("PATCH", `/api/v1/topic-inbox/decisions/${encodeURIComponent(sessionId)}/agents`, input) as Promise<{ session: unknown; snapshots: unknown[] }>;
  }
  runTopicDecision(sessionId: string, input: { namespace: RuntimeNamespace; expectedVersion: number; adapterId: string; requestId: string }): Promise<{ accepted: boolean }> {
    return this.request("POST", `/api/v1/topic-inbox/decisions/${encodeURIComponent(sessionId)}/run`, input) as Promise<{ accepted: boolean }>;
  }

  runTopicDecisionPositions(sessionId: string, input: { namespace: RuntimeNamespace; expectedVersion: number; adapterId: string; requestId: string }): Promise<{ accepted: boolean }> {
    return this.request("POST", `/api/v1/topic-inbox/decisions/${encodeURIComponent(sessionId)}/positions`, input) as Promise<{ accepted: boolean }>;
  }

  runTopicDecisionDebate(sessionId: string, input: { namespace: RuntimeNamespace; expectedVersion: number; adapterId: string; requestId: string }): Promise<{ session: unknown; snapshots: unknown[] }> {
    return this.request("POST", `/api/v1/topic-inbox/decisions/${encodeURIComponent(sessionId)}/debate`, input) as Promise<{ session: unknown; snapshots: unknown[] }>;
  }

  runTopicDecisionProposals(sessionId: string, input: { namespace: RuntimeNamespace; expectedVersion: number; adapterId: string; requestId: string }): Promise<{ session: unknown; snapshots: unknown[] }> {
    return this.request("POST", `/api/v1/topic-inbox/decisions/${encodeURIComponent(sessionId)}/proposals`, input) as Promise<{ session: unknown; snapshots: unknown[] }>;
  }

  submitTopicDecisionAnswers(sessionId: string, input: { namespace: RuntimeNamespace; expectedVersion: number; answers: Array<{ questionKey: string; answer: string; source: "user_preference" | "user_supplied_unverified" }>; adapterId: string; requestId: string }): Promise<{ session: unknown; snapshots: unknown[] }> {
    return this.request("POST", `/api/v1/topic-inbox/decisions/${encodeURIComponent(sessionId)}/answers`, input) as Promise<{ session: unknown; snapshots: unknown[] }>;
  }

  approveTopicDecisionProposal(sessionId: string, proposalId: string, input: { namespace: RuntimeNamespace; expectedProposalVersion: number; adapterId: string; requestId: string }): Promise<unknown> {
    return this.request("POST", `/api/v1/topic-inbox/decisions/${encodeURIComponent(sessionId)}/proposals/${encodeURIComponent(proposalId)}/approve`, input);
  }

  resumeTopicDecisionExecution(sessionId: string, runId: string, input: { namespace: RuntimeNamespace; expectedVersion: number; adapterId: string; requestId: string }): Promise<unknown> {
    return this.request("POST", `/api/v1/topic-inbox/decisions/${encodeURIComponent(sessionId)}/executions/${encodeURIComponent(runId)}/resume`, input);
  }

  confirmTopicDecisionAction(sessionId: string, runId: string, actionId: string, input: { namespace: RuntimeNamespace; expectedRunVersion: number; approved: boolean; idempotencyKey: string; adapterId: string; requestId: string }): Promise<unknown> {
    return this.request("POST", `/api/v1/topic-inbox/decisions/${encodeURIComponent(sessionId)}/executions/${encodeURIComponent(runId)}/actions/${encodeURIComponent(actionId)}/confirm`, input);
  }

  cancelTopicDecision(sessionId: string, input: { namespace: RuntimeNamespace; expectedVersion: number; adapterId: string; requestId: string }): Promise<{ session: unknown; snapshots: unknown[] }> {
    return this.request("POST", `/api/v1/topic-inbox/decisions/${encodeURIComponent(sessionId)}/cancel`, input) as Promise<{ session: unknown; snapshots: unknown[] }>;
  }
  recallAssets(request: AssetRecallRequestBody): Promise<{ items: unknown[] }> {
    return this.request("POST", "/api/v1/asset-recalls", request) as Promise<{ items: unknown[] }>;
  }

  recordAssetRecallOutcome(offeredEventId: string, request: AssetRecallOutcomeBody): Promise<unknown> {
    return this.request("POST", `/api/v1/asset-recalls/${encodeURIComponent(offeredEventId)}/outcome`, request);
  }

  mutateMemoryTemporalValidity(memoryId: string, request: TemporalValidityMutationBody): Promise<unknown> {
    return this.request("POST", `/api/v1/memory/${encodeURIComponent(memoryId)}/temporal-validity`, request);
  }

  getMemoryTemporalValidity(memoryId: string, query: TemporalValidityQuery = {}): Promise<unknown> {
    return this.request("GET", `/api/v1/memory/${encodeURIComponent(memoryId)}/temporal-validity${queryString({ ...query })}`);
  }


  private async request(method: "GET" | "POST" | "DELETE" | "PATCH", path: string, body?: unknown, requestHeaders: Record<string, string> = {}): Promise<unknown> {
    const response = await fetch(`${this.endpoint}${path}`, {
      method,
      headers: {
        ...this.headers,
        ...requestHeaders,
        "x-memmy-time-zone": this.timeZone,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {})
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    const payload = text ? JSON.parse(text) as unknown : undefined;
    if (!response.ok) {
      throw new MemoryRestClientError(response.status, payload, text);
    }
    return payload;
  }

}

export class MemoryRestClientError extends Error {
  constructor(
    readonly status: number,
    readonly payload: unknown,
    readonly rawBody: string
  ) {
    super(`memory service HTTP ${status}: ${rawBody}`);
  }
}

function queryString(query: MemoryRestQuery): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) {
      params.set(key, Array.isArray(value) ? value.join(",") : String(value));
    }
  }
  const rendered = params.toString();
  return rendered ? `?${rendered}` : "";
}
