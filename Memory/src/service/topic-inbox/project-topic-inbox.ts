import type { LlmClient } from "../../model/types.js";
import type { EvolutionJobRecord, Repositories } from "../../storage/repositories.js";
import type { MemoryRow, ProjectTopicCandidateRecord, ProjectTopicRecord, RuntimeNamespace } from "../../types.js";
import { newId, stableHash } from "../../utils/id.js";
import { nowIso } from "../../utils/time.js";
import { namespaceForMemory, namespaceIdFromContext, normalizeNamespace } from "../namespace/namespace-scope.js";
import type { EnqueueJobInput } from "../worker/job-handlers.js";
import { evaluateTopicAutoApproval } from "./auto-approval-policy.js";
import { analyzeProjectTopic, topicAnalysisInputHash } from "./topic-analysis.js";
import type { ProjectTopicInbox, TopicCandidateDecision, TopicDecisionResult, TopicInboxQuery, TopicInboxView, TopicIngestResult, TopicRefreshResult } from "./topic-inbox-types.js";
import { matchProjectTopic, topicSignalsForMemory } from "./topic-matcher.js";

export interface ProjectTopicInboxDeps {
  repos: Repositories;
  llm: LlmClient;
  buildMemory(input: Record<string, unknown>): MemoryRow;
  upsertMemory(memory: MemoryRow): { memory: MemoryRow; created: boolean; previous?: MemoryRow };
  enqueueJob?(input: EnqueueJobInput): EvolutionJobRecord;
}

export class ProjectTopicInboxService implements ProjectTopicInbox {
  constructor(private readonly deps: ProjectTopicInboxDeps) {}

  async ingest(memoryId: string): Promise<TopicIngestResult> {
    const memory = this.deps.repos.memories.get(memoryId);
    if (!memory || memory.memoryLayer !== "L1" || memory.status !== "activated") return { assigned: false, unchanged: true, candidateIds: [] };
    const namespace = namespaceForMemory(memory);
    const namespaceId = namespaceIdFromContext(namespace);
    const match = matchProjectTopic(memory, this.deps.repos.topics.listTopics(namespaceId, ["active"]));
    if (match.confidence === "ambiguous") return { assigned: false, unchanged: true, candidateIds: [] };
    const at = nowIso();
    const topic = match.topic ?? this.newTopic(memory, namespaceId, at);
    const existingEvidence = this.deps.repos.topics.listEvidence(topic.id, namespaceId);
    const alreadyAttached = existingEvidence.some((item) => item.memoryId === memory.id);
    const evidence = [...existingEvidence.map((item) => ({ memory: this.deps.repos.memories.get(item.memoryId)!, role: item.role })), ...(!alreadyAttached ? [{ memory, role: match.role }] : [])]
      .filter((item) => Boolean(item.memory));
    const inputHash = topicAnalysisInputHash(match.topic, evidence);
    if (this.deps.repos.topics.findAnalysisRun(namespaceId, inputHash)) return { assigned: true, unchanged: true, topicId: topic.id, candidateIds: [] };
    const analysis = await analyzeProjectTopic({ llm: this.deps.llm, topic: match.topic, evidence });
    const createdCandidates: ProjectTopicCandidateRecord[] = [];
    this.deps.repos.transaction(() => {
      if (!match.topic) this.deps.repos.topics.insertTopic(topic);
      if (!alreadyAttached) this.deps.repos.topics.attachEvidence({ id: newId("topic_evidence"), topicId: topic.id, namespaceId, memoryId: memory.id, role: match.role, summary: memory.memoryValue.slice(0, 500), metadata: { contentHash: memory.contentHash, episodeId: stringField(memory.properties.internal_info, "episode_id") }, createdAt: at });
      const sourceMemoryIds = evidence.map((item) => item.memory.id);
      const current = this.deps.repos.topics.getTopic(topic.id, namespaceId)!;
      const materiallyChanged = current.title !== analysis.topic.title || current.summary !== analysis.topic.summary || !sameStrings(current.sourceMemoryIds, sourceMemoryIds);
      if (materiallyChanged) this.deps.repos.topics.updateTopic({ ...current, title: analysis.topic.title, summary: analysis.topic.summary, sourceMemoryIds, metadata: { ...current.metadata, signals: unique([...stringArray(current.metadata.signals), ...topicSignalsForMemory(memory)]) }, version: current.version + 1, updatedAt: at }, current.version);
      const previousPending = this.deps.repos.topics.listCandidates(topic.id, namespaceId).find((candidate) => candidate.status === "pending");
      for (const candidate of analysis.candidates) {
        if (previousPending && previousPending.conclusion === candidate.conclusion && previousPending.proposedLayer === candidate.proposedLayer) continue;
        const policy = evaluateTopicAutoApproval(candidate);
        const record: ProjectTopicCandidateRecord = { id: newId("topic_candidate"), topicId: topic.id, namespaceId, title: candidate.title, conclusion: candidate.conclusion, proposedLayer: candidate.proposedLayer, status: "pending", version: 1, supersedesId: previousPending?.id, sourceMemoryIds, metadata: { ...candidate, policyVersion: policy.policyVersion, autoApprovalRejectionReasons: policy.rejectionReasons, model: this.deps.llm.config.model ?? this.deps.llm.config.provider }, createdAt: at, updatedAt: at };
        this.deps.repos.topics.insertCandidate(record);
        createdCandidates.push(record);
        if (policy.approved && !this.hasDuplicateMemory(record, namespace)) this.approve(record, true);
      }
      this.deps.repos.topics.recordAnalysisRun({ id: newId("topic_analysis"), namespaceId, inputHash, topicId: topic.id, status: "succeeded", result: { topic: analysis.topic, candidates: analysis.candidates }, createdAt: at, updatedAt: at });
    });
    return { assigned: true, unchanged: false, topicId: topic.id, candidateIds: createdCandidates.map((item) => item.id) };
  }

  list(namespace: RuntimeNamespace, query: TopicInboxQuery = {}): TopicInboxView {
    const namespaceId = namespaceIdFromContext(namespace);
    return { topics: this.deps.repos.topics.listTopics(namespaceId).map((topic) => ({ topic, evidence: this.deps.repos.topics.listEvidence(topic.id, namespaceId), candidates: this.deps.repos.topics.listCandidates(topic.id, namespaceId).filter((candidate) => !query.statuses?.length || query.statuses.includes(candidate.status)) })) };
  }

  async decide(candidateId: string, decision: TopicCandidateDecision): Promise<TopicDecisionResult> {
    const candidate = this.findCandidate(candidateId);
    if (!candidate) throw new Error(`topic candidate not found: ${candidateId}`);
    if (candidate.status !== "pending" && candidate.status !== "deferred") throw new Error(`topic candidate is not decidable: ${candidateId}`);
    if (decision.decision === "approve") return this.approve(candidate, false);
    const at = nowIso();
    const updated = this.deps.repos.topics.updateCandidate({ ...candidate, status: decision.decision === "reject" ? "rejected" : "deferred", version: candidate.version + 1, metadata: { ...candidate.metadata, decisionReason: decision.reason }, updatedAt: at }, candidate.version);
    return { candidate: updated };
  }

  async refresh(namespace: RuntimeNamespace): Promise<TopicRefreshResult> {
    if (!this.deps.enqueueJob) throw new Error("topic refresh requires a durable job queue");
    const normalized = normalizeNamespace(namespace);
    const namespaceId = namespaceIdFromContext(normalized);
    const cursor = stableHash(this.deps.repos.topics.listTopics(namespaceId).map((topic) => ({ id: topic.id, version: topic.version, evidence: topic.sourceMemoryIds }))).slice(0, 24);
    const job = this.deps.enqueueJob({ jobType: "topic_refresh", userId: normalized.userId, payload: { namespace, namespaceId, evidenceCursor: cursor } });
    return { jobId: job.id, unchanged: job.status !== "queued" };
  }

  async processRefresh(namespace: RuntimeNamespace): Promise<void> {
    const namespaceId = namespaceIdFromContext(namespace);
    const memories = this.deps.repos.memories.list({ memoryLayer: "L1", status: "activated", ...namespaceFilter(namespace) }, 10_000);
    for (const memory of memories) await this.ingest(memory.id);
    this.deps.repos.runtime.setKv(`topic_refresh_cursor:${namespaceId}`, stableHash(memories.map((memory) => [memory.id, memory.version, memory.contentHash])));
  }

  private newTopic(memory: MemoryRow, namespaceId: string, at: string): ProjectTopicRecord {
    return { id: newId("topic"), namespaceId, projectId: normalizeNamespace(namespaceForMemory(memory)).projectId, title: memory.tags[0] ?? "Project topic", summary: memory.memoryValue.slice(0, 500), status: "active", version: 1, sourceMemoryIds: [], metadata: { signals: topicSignalsForMemory(memory) }, createdAt: at, updatedAt: at };
  }

  private approve(candidate: ProjectTopicCandidateRecord, automatic: boolean): TopicDecisionResult {
    const topic = this.deps.repos.topics.getTopic(candidate.topicId, candidate.namespaceId);
    if (!topic) throw new Error(`topic not found: ${candidate.topicId}`);
    const source = this.deps.repos.memories.get(candidate.sourceMemoryIds[0]!);
    if (!source) throw new Error("topic candidate source memory missing");
    const policyVersion = stringField(candidate.metadata, "policyVersion") ?? "manual";
    const memory = this.deps.buildMemory({ userId: source.userId, sessionId: source.sessionId, agentId: source.agentId, appId: source.appId, tenantId: source.info.tenant_id, projectId: topic.projectId, layer: "L2", kind: "policy", lifecycleStatus: "active", memoryType: "LongTermMemory", key: `topic:${topic.id}:candidate:${stableHash(candidate.conclusion).slice(0, 20)}`, value: candidate.conclusion, tags: ["project-topic", "topic-approved"], provenance: { sourceMemoryIds: candidate.sourceMemoryIds }, info: { title: candidate.title, source_memory_ids: candidate.sourceMemoryIds }, internal: { source_memory_ids: candidate.sourceMemoryIds, source_l1_memory_ids: candidate.sourceMemoryIds, topic_approval: { topicId: topic.id, candidateId: candidate.id, model: candidate.metadata.model, policyVersion, automatic } } });
    const saved = this.deps.upsertMemory(memory).memory;
    const at = nowIso();
    const updated = this.deps.repos.topics.updateCandidate({ ...candidate, status: "approved", version: candidate.version + 1, metadata: { ...candidate.metadata, approvedMemoryId: saved.id, automatic }, updatedAt: at }, candidate.version);
    this.deps.repos.runtime.insertAudit({ userId: source.userId, sessionId: source.sessionId, actor: { type: automatic ? "system" : "user" }, action: "topic_candidate_approved", targetKind: "memory", targetId: saved.id, after: saved, meta: { topicId: topic.id, candidateId: candidate.id, model: candidate.metadata.model, policyVersion, automatic }, createdAt: at });
    return { candidate: updated, memory: saved };
  }

  private findCandidate(candidateId: string): ProjectTopicCandidateRecord | undefined {
    for (const topic of this.deps.repos.topics.listTopics("local:unscoped")) {
      const found = this.deps.repos.topics.listCandidates(topic.id, topic.namespaceId).find((candidate) => candidate.id === candidateId);
      if (found) return found;
    }
    const row = this.deps.repos.db.prepare("SELECT namespace_id, topic_id FROM project_topic_candidates WHERE id = ?").get(candidateId) as { namespace_id: string; topic_id: string } | undefined;
    return row ? this.deps.repos.topics.listCandidates(row.topic_id, row.namespace_id).find((candidate) => candidate.id === candidateId) : undefined;
  }

  private hasDuplicateMemory(candidate: ProjectTopicCandidateRecord, namespace: RuntimeNamespace): boolean {
    const normalized = candidate.conclusion.trim().toLowerCase();
    return this.deps.repos.memories.list({ memoryLayer: "L2", ...namespaceFilter(namespace) }, 10_000).some((memory) => memory.status !== "archived" && memory.memoryValue.trim().toLowerCase() === normalized);
  }
}

function namespaceFilter(namespace: RuntimeNamespace): { tenantId: string; projectId: string } {
  const normalized = normalizeNamespace(namespace);
  return { tenantId: normalized.tenantId ?? "local", projectId: normalized.projectId ?? "unscoped" };
}
function stringField(value: Record<string, unknown>, key: string): string | undefined { const item = value[key]; return typeof item === "string" && item.trim() ? item.trim() : undefined; }
function stringArray(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
function unique(values: string[]): string[] { return [...new Set(values)]; }
function sameStrings(left: string[], right: string[]): boolean { return left.length === right.length && left.every((value, index) => value === right[index]); }
