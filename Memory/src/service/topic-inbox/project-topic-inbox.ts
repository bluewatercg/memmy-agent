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
    const primaryRole = match.roles[0] ?? "evidence";
    const evidence = [...existingEvidence.map((item) => ({ memory: this.deps.repos.memories.get(item.memoryId)!, role: rolesFromEvidence(item) })), ...(!alreadyAttached ? [{ memory, role: match.roles }] : [])].filter((item) => Boolean(item.memory));
    const inputHash = topicAnalysisInputHash(match.topic, evidence);
    const claimOwner = newId("topic_analysis_owner");
    if (!this.deps.repos.topics.claimAnalysisRun({ id: newId("topic_analysis"), namespaceId, inputHash, owner: claimOwner, at })) return { assigned: true, unchanged: true, topicId: topic.id, candidateIds: [] };
    let analysis;
    try {
      analysis = await analyzeProjectTopic({ llm: this.deps.llm, topic: match.topic, evidence });
    } catch (error) {
      this.deps.repos.topics.completeAnalysisRun({ namespaceId, inputHash, owner: claimOwner, status: "failed", result: { error: error instanceof Error ? error.message : String(error) }, at: nowIso() });
      throw error;
    }
    const createdCandidates: ProjectTopicCandidateRecord[] = [];
    this.deps.repos.transaction(() => {
      if (!match.topic) this.deps.repos.topics.insertTopic(topic);
      if (!alreadyAttached) this.deps.repos.topics.attachEvidence({ id: newId("topic_evidence"), topicId: topic.id, namespaceId, memoryId: memory.id, role: primaryRole, summary: memory.memoryValue.slice(0, 500), metadata: { roles: match.roles, contentHash: memory.contentHash, episodeId: stringField(memory.properties.internal_info, "episode_id") }, createdAt: at });
      const sourceMemoryIds = evidence.map((item) => item.memory.id);
      const current = this.deps.repos.topics.getTopic(topic.id, namespaceId)!;
      const materiallyChanged = current.title !== analysis.topic.title || current.summary !== analysis.topic.summary || !sameStrings(current.sourceMemoryIds, sourceMemoryIds);
      const embeddingCentroid = centroid(evidence.map((item) => traceVector(item.memory)).filter((vector): vector is number[] => Boolean(vector)));
      if (materiallyChanged) this.deps.repos.topics.updateTopic({ ...current, title: analysis.topic.title, summary: analysis.topic.summary, sourceMemoryIds, metadata: { ...current.metadata, signals: unique([...stringArray(current.metadata.signals), ...topicSignalsForMemory(memory)]), ...(embeddingCentroid.length ? { embeddingCentroid } : {}) }, version: current.version + 1, updatedAt: at }, current.version);
      const pending = this.deps.repos.topics.listCandidates(topic.id, namespaceId).filter((candidate) => candidate.status === "pending");
      const pendingByIdentity = new Map(pending.map((candidate) => [candidateIdentityFromRecord(candidate), candidate]));
      const retained = new Set<string>();
      for (const candidate of analysis.candidates) {
        const identity = candidateIdentity(candidate);
        const predecessor = pendingByIdentity.get(identity);
        if (predecessor && predecessor.conclusion === candidate.conclusion && predecessor.proposedLayer === candidate.proposedLayer) { retained.add(predecessor.id); continue; }
        const policy = evaluateTopicAutoApproval(candidate, evidence.map((item) => item.memory));
        const record: ProjectTopicCandidateRecord = { id: newId("topic_candidate"), topicId: topic.id, namespaceId, title: candidate.title, conclusion: candidate.conclusion, proposedLayer: candidate.proposedLayer, status: "pending", version: 1, supersedesId: predecessor?.id, sourceMemoryIds: candidate.sourceEvidenceIds, metadata: { ...candidate, candidateIdentity: identity, policyVersion: policy.policyVersion, autoApprovalRejectionReasons: policy.rejectionReasons, verifiedEvidenceIds: policy.verifiedEvidenceIds, model: this.deps.llm.config.model ?? this.deps.llm.config.provider }, createdAt: at, updatedAt: at };
        this.deps.repos.topics.insertCandidate(record);
        createdCandidates.push(record);
        retained.add(record.id);
        if (policy.approved && !this.hasDuplicateMemory(record, namespace)) this.approve(record, true);
      }
      for (const obsolete of pending.filter((item) => !retained.has(item.id) && item.status === "pending")) this.deps.repos.topics.updateCandidate({ ...obsolete, status: "superseded", version: obsolete.version + 1, updatedAt: at }, obsolete.version);
      if (!this.deps.repos.topics.completeAnalysisRun({ namespaceId, inputHash, owner: claimOwner, status: "succeeded", topicId: topic.id, result: { topic: analysis.topic, candidates: analysis.candidates }, at })) throw new Error("topic analysis claim lost");
    });
    return { assigned: true, unchanged: false, topicId: topic.id, candidateIds: createdCandidates.map((item) => item.id) };
  }

  list(namespace: RuntimeNamespace, query: TopicInboxQuery = {}): TopicInboxView {
    const namespaceId = namespaceIdFromContext(namespace);
    return { topics: this.deps.repos.topics.listTopics(namespaceId).map((topic) => ({ topic, evidence: this.deps.repos.topics.listEvidence(topic.id, namespaceId), candidates: this.deps.repos.topics.listCandidates(topic.id, namespaceId).filter((candidate) => !query.statuses?.length || query.statuses.includes(candidate.status)) })) };
  }

  async decide(namespace: RuntimeNamespace, candidateId: string, decision: TopicCandidateDecision): Promise<TopicDecisionResult> {
    const namespaceId = namespaceIdFromContext(namespace);
    const candidate = this.findCandidate(namespaceId, candidateId);
    if (!candidate) throw new Error(`topic candidate not found in namespace: ${candidateId}`);
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
    const corpus = this.eligibleCorpus(normalized);
    const cursor = corpusCursor(corpus);
    const requestKey = `topic_refresh_request:${namespaceId}`;
    const prior = this.deps.repos.runtime.getKv(requestKey)?.value;
    if (isRefreshRequest(prior) && prior.cursor === cursor) return { jobId: prior.jobId, unchanged: true };
    const job = this.deps.enqueueJob({ jobType: "topic_refresh", userId: normalized.userId, payload: { namespace: normalized, namespaceId, evidenceCursor: cursor } });
    this.deps.repos.runtime.setKv(requestKey, { cursor, jobId: job.id });
    return { jobId: job.id, unchanged: false };
  }

  async processRefresh(namespace: RuntimeNamespace): Promise<void> {
    const normalized = normalizeNamespace(namespace);
    const namespaceId = namespaceIdFromContext(normalized);
    const memories = this.eligibleCorpus(normalized);
    const cursor = corpusCursor(memories);
    if (this.deps.repos.runtime.getKv(`topic_refresh_cursor:${namespaceId}`)?.value === cursor) return;
    for (const memory of memories) await this.ingest(memory.id);
    this.deps.repos.runtime.setKv(`topic_refresh_cursor:${namespaceId}`, cursor);
  }

  private eligibleCorpus(namespace: RuntimeNamespace): MemoryRow[] {
    return this.deps.repos.memories.list({ memoryLayer: "L1", status: "activated", ...namespaceFilter(namespace) }, 10_000).sort((a, b) => a.id.localeCompare(b.id));
  }

  private newTopic(memory: MemoryRow, namespaceId: string, at: string): ProjectTopicRecord {
    return { id: newId("topic"), namespaceId, projectId: normalizeNamespace(namespaceForMemory(memory)).projectId, title: memory.tags[0] ?? "Project topic", summary: memory.memoryValue.slice(0, 500), status: "active", version: 1, sourceMemoryIds: [], metadata: { signals: topicSignalsForMemory(memory) }, createdAt: at, updatedAt: at };
  }

  private approve(candidate: ProjectTopicCandidateRecord, automatic: boolean): TopicDecisionResult {
    return this.deps.repos.transaction(() => {
      const topic = this.deps.repos.topics.getTopic(candidate.topicId, candidate.namespaceId);
      if (!topic) throw new Error(`topic not found: ${candidate.topicId}`);
      const source = this.deps.repos.memories.get(candidate.sourceMemoryIds[0]!);
      if (!source || namespaceIdFromContext(namespaceForMemory(source)) !== candidate.namespaceId) throw new Error("topic candidate source memory missing or cross-namespace");
      const layer = candidate.proposedLayer;
      const kind = layer === "L2" ? "policy" : layer === "L3" ? "world_model" : "skill";
      const policyVersion = stringField(candidate.metadata, "policyVersion") ?? "manual";
      const memory = this.deps.buildMemory({ userId: source.userId, sessionId: source.sessionId, agentId: source.agentId, appId: source.appId, tenantId: source.info.tenant_id, projectId: topic.projectId, layer, kind, lifecycleStatus: "active", memoryType: layer === "Skill" ? "SkillMemory" : "LongTermMemory", key: `topic:${topic.id}:${layer}:${candidateIdentityFromRecord(candidate)}`, value: candidate.conclusion, tags: ["project-topic", "topic-approved"], provenance: { sourceMemoryIds: candidate.sourceMemoryIds }, info: { title: candidate.title, source_memory_ids: candidate.sourceMemoryIds }, internal: { source_memory_ids: candidate.sourceMemoryIds, source_l1_memory_ids: candidate.sourceMemoryIds, topic_approval: { topicId: topic.id, candidateId: candidate.id, model: candidate.metadata.model, policyVersion, automatic } } });
      let saved = this.deps.upsertMemory(memory).memory;
      const priorApproved = this.deps.repos.topics.listCandidates(candidate.topicId, candidate.namespaceId).filter((item) => item.status === "approved" && item.id !== candidate.id && item.proposedLayer === candidate.proposedLayer).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
      const priorMemoryId = priorApproved ? stringField(priorApproved.metadata, "approvedMemoryId") : undefined;
      const priorMemory = priorMemoryId ? this.deps.repos.memories.get(priorMemoryId) : undefined;
      if (priorMemory && priorMemory.id !== saved.id && priorMemory.status === "activated") saved = this.deps.repos.memories.supersede({ oldMemory: priorMemory, newMemory: saved, projectId: topic.projectId, reason: `topic candidate ${candidate.id} supersedes ${priorApproved!.id}`, actor: { type: automatic ? "system" : "user" } }).newMemory;
      const at = nowIso();
      const updated = this.deps.repos.topics.updateCandidate({ ...candidate, status: "approved", version: candidate.version + 1, metadata: { ...candidate.metadata, approvedMemoryId: saved.id, automatic }, updatedAt: at }, candidate.version);
      this.deps.repos.runtime.insertAudit({ userId: source.userId, sessionId: source.sessionId, actor: { type: automatic ? "system" : "user" }, action: "topic_candidate_approved", targetKind: "memory", targetId: saved.id, after: saved, meta: { topicId: topic.id, candidateId: candidate.id, model: candidate.metadata.model, policyVersion, automatic }, createdAt: at });
      return { candidate: updated, memory: saved };
    });
  }

  private findCandidate(namespaceId: string, candidateId: string): ProjectTopicCandidateRecord | undefined {
    const row = this.deps.repos.db.prepare("SELECT topic_id FROM project_topic_candidates WHERE id = ? AND namespace_id = ?").get(candidateId, namespaceId) as { topic_id: string } | undefined;
    return row ? this.deps.repos.topics.listCandidates(row.topic_id, namespaceId).find((candidate) => candidate.id === candidateId) : undefined;
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
function rolesFromEvidence(evidence: { role: string; metadata: Record<string, unknown> }): string[] {
  const roles = stringArray(evidence.metadata.roles);
  return roles.length ? roles : [evidence.role];
}
function sameStrings(left: string[], right: string[]): boolean { return left.length === right.length && left.every((value, index) => value === right[index]); }
function corpusCursor(memories: MemoryRow[]): string {
  return stableHash(memories.map((memory) => ({ id: memory.id, contentHash: memory.contentHash, version: memory.version, quality: memory.info.quality_rating, verificationStatus: memory.info.verification_status, verificationPassed: memory.info.verification_passed })));
}
function isRefreshRequest(value: unknown): value is { cursor: string; jobId: string } {
  return Boolean(value && typeof value === "object" && "cursor" in value && typeof value.cursor === "string" && "jobId" in value && typeof value.jobId === "string");
}
function candidateIdentity(candidate: { proposedLayer: string; title: string; conclusion: string; sensitiveCategories: string[] }): string {
  const normalizedTitle = candidate.title.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return stableHash({ layer: candidate.proposedLayer, title: normalizedTitle, category: [...candidate.sensitiveCategories].map((item) => item.normalize("NFKC").toLocaleLowerCase()).sort() }).slice(0, 32);
}
function candidateIdentityFromRecord(candidate: ProjectTopicCandidateRecord): string {
  return stringField(candidate.metadata, "candidateIdentity") ?? candidateIdentity({ proposedLayer: candidate.proposedLayer, title: candidate.title, conclusion: candidate.conclusion, sensitiveCategories: stringArray(candidate.metadata.sensitiveCategories) });
}
function traceVector(memory: MemoryRow): number[] | null {
  const trace = memory.properties.internal_info.trace;
  if (!trace || typeof trace !== "object" || Array.isArray(trace) || !("vec_summary" in trace)) return null;
  const value = trace.vec_summary;
  return Array.isArray(value) && value.every((item) => typeof item === "number" && Number.isFinite(item)) ? value : null;
}
function centroid(vectors: number[][]): number[] {
  if (!vectors.length || vectors.some((vector) => vector.length !== vectors[0]!.length)) return [];
  return vectors[0]!.map((_, index) => vectors.reduce((sum, vector) => sum + vector[index]!, 0) / vectors.length);
}
