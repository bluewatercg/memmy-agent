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
}

export class MemoryRestClient {
  private readonly endpoint: string;
  private readonly token?: string;
  private readonly headers: Record<string, string>;

  constructor(options: MemoryRestClientOptions) {
    this.endpoint = options.endpoint.replace(/\/+$/, "");
    this.token = options.token;
    this.headers = options.headers ?? {};
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

  startTopicDecision(topicId: string, input: { namespace: RuntimeNamespace; agents?: TopicAgentSpec[]; requestId?: string }): Promise<{ session: unknown; snapshot: unknown; reused: boolean }> {
    return this.request("POST", `/api/v1/topic-inbox/topics/${encodeURIComponent(topicId)}/decisions`, input) as Promise<{ session: unknown; snapshot: unknown; reused: boolean }>;
  }

  readTopicDecision(sessionId: string): Promise<{ session: unknown; snapshots: unknown[] }> {
    return this.request("GET", `/api/v1/topic-inbox/decisions/${encodeURIComponent(sessionId)}`) as Promise<{ session: unknown; snapshots: unknown[] }>;
  }

  patchTopicDecisionAgents(sessionId: string, input: { namespace: RuntimeNamespace; agents: TopicAgentSpec[]; requestId?: string }): Promise<{ session: unknown; snapshots: unknown[] }> {
    return this.request("PATCH", `/api/v1/topic-inbox/decisions/${encodeURIComponent(sessionId)}/agents`, input) as Promise<{ session: unknown; snapshots: unknown[] }>;
  }

  runTopicDecisionPositions(sessionId: string, input: { namespace: RuntimeNamespace; requestId?: string }): Promise<{ accepted: boolean }> {
    return this.request("POST", `/api/v1/topic-inbox/decisions/${encodeURIComponent(sessionId)}/positions`, input) as Promise<{ accepted: boolean }>;
  }

  runTopicDecisionDebate(sessionId: string, input: { namespace: RuntimeNamespace; requestId?: string }): Promise<{ session: unknown; snapshots: unknown[] }> {
    return this.request("POST", `/api/v1/topic-inbox/decisions/${encodeURIComponent(sessionId)}/debate`, input) as Promise<{ session: unknown; snapshots: unknown[] }>;
  }

  runTopicDecisionProposals(sessionId: string, input: { namespace: RuntimeNamespace; requestId?: string }): Promise<{ session: unknown; snapshots: unknown[] }> {
    return this.request("POST", `/api/v1/topic-inbox/decisions/${encodeURIComponent(sessionId)}/proposals`, input) as Promise<{ session: unknown; snapshots: unknown[] }>;
  }

  submitTopicDecisionAnswers(sessionId: string, input: { namespace: RuntimeNamespace; expectedVersion: number; answers: Array<{ questionKey: string; answer: string; source: "user_preference" | "user_supplied_unverified" }>; requestId?: string }): Promise<{ session: unknown; snapshots: unknown[] }> {
    return this.request("POST", `/api/v1/topic-inbox/decisions/${encodeURIComponent(sessionId)}/answers`, input) as Promise<{ session: unknown; snapshots: unknown[] }>;
  }

  approveTopicDecisionProposal(sessionId: string, proposalId: string, input: { namespace: RuntimeNamespace; expectedProposalVersion: number; requestId?: string }): Promise<unknown> {
    return this.request("POST", `/api/v1/topic-inbox/decisions/${encodeURIComponent(sessionId)}/proposals/${encodeURIComponent(proposalId)}/approve`, input);
  }

  resumeTopicDecisionExecution(sessionId: string, runId: string, input: { namespace: RuntimeNamespace; requestId?: string }): Promise<unknown> {
    return this.request("POST", `/api/v1/topic-inbox/decisions/${encodeURIComponent(sessionId)}/executions/${encodeURIComponent(runId)}/resume`, input);
  }

  confirmTopicDecisionAction(sessionId: string, runId: string, actionId: string, input: { namespace: RuntimeNamespace; expectedRunVersion: number; approved: boolean; idempotencyKey: string; requestId?: string }): Promise<unknown> {
    return this.request("POST", `/api/v1/topic-inbox/decisions/${encodeURIComponent(sessionId)}/executions/${encodeURIComponent(runId)}/actions/${encodeURIComponent(actionId)}/confirm`, input);
  }

  cancelTopicDecision(sessionId: string, input: { namespace: RuntimeNamespace; requestId?: string }): Promise<{ accepted: boolean }> {
    return this.request("POST", `/api/v1/topic-inbox/decisions/${encodeURIComponent(sessionId)}/cancel`, input) as Promise<{ accepted: boolean }>;
  }

  private async request(method: "GET" | "POST" | "DELETE" | "PATCH", path: string, body?: unknown): Promise<unknown> {
    const response = await fetch(`${this.endpoint}${path}`, {
      method,
      headers: {
        ...this.headers,
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
