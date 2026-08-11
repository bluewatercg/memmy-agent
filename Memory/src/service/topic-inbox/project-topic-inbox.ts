import type { LlmClient } from "../../model/types.js";
import { memoryVector } from "../../storage/memory-vector-state.js";
import type { EvolutionJobRecord, Repositories } from "../../storage/repositories.js";
import type { MemoryRow, ProjectTopicCandidateRecord, ProjectTopicRecord, RuntimeNamespace } from "../../types.js";
import { newId, stableHash } from "../../utils/id.js";
import { nowIso } from "../../utils/time.js";
import { namespaceForMemory, namespaceIdFromContext, normalizeNamespace } from "../namespace/namespace-scope.js";
import type { EnqueueJobInput } from "../worker/job-handlers.js";
import { evaluateTopicAutoApproval } from "./auto-approval-policy.js";
import { analyzeProjectTopic, topicAnalysisInputHash, topicCentroidInputHash } from "./topic-analysis.js";
import type { ProjectTopicInbox, TopicCandidateDecision, TopicDecisionResult, TopicEvidenceResult, TopicInboxQuery, TopicInboxView, TopicIngestResult, TopicMergeResult, TopicRefreshResult, TopicSplitResult } from "./topic-inbox-types.js";
import { matchProjectTopic, topicSignalsForMemory } from "./topic-matcher.js";

export interface ProjectTopicInboxDeps {
  repos: Repositories;
  llm: LlmClient;
  buildMemory(input: Record<string, unknown>): MemoryRow;
  upsertMemory(memory: MemoryRow): { memory: MemoryRow; created: boolean; previous?: MemoryRow };
  enqueueJob?(input: EnqueueJobInput): EvolutionJobRecord;
  now?: () => string;
  analysisLeaseMs?: number;
  refreshPageSize?: number;
  onRefreshMemory?: (memory: MemoryRow, pageIndex: number) => void;
}

export class ProjectTopicInboxService implements ProjectTopicInbox {
  constructor(private readonly deps: ProjectTopicInboxDeps) {}

  async ingest(memoryId: string): Promise<TopicIngestResult> {
    const memory = this.deps.repos.memories.get(memoryId);
    return memory ? this.ingestMemory(memory) : { assigned: false, unchanged: true, candidateIds: [] };
  }

  private async ingestMemory(memory: MemoryRow, capturedMemory?: (id: string) => MemoryRow | undefined): Promise<TopicIngestResult> {
    const live = this.deps.repos.memories.get(memory.id);
    if (!live || live.memoryLayer !== "L1" || live.status !== "activated" || namespaceIdFromContext(namespaceForMemory(live)) !== namespaceIdFromContext(namespaceForMemory(memory))) return { assigned: false, unchanged: true, candidateIds: [] };
    const namespace = namespaceForMemory(memory);
    const namespaceId = namespaceIdFromContext(namespace);
    const match = matchProjectTopic(memory, this.deps.repos.topics.listTopics(namespaceId, ["active"]));
    if (match.confidence === "ambiguous") return { assigned: false, unchanged: true, candidateIds: [] };
    const at = this.now();
    const topic = match.topic ?? this.newTopic(memory, namespaceId, at);
    const existingEvidence = this.deps.repos.topics.listEvidence(topic.id, namespaceId);
    const alreadyAttached = existingEvidence.some((item) => item.memoryId === memory.id);
    const primaryRole = match.roles[0] ?? "evidence";
    const evidence = [...existingEvidence.flatMap((item) => {
      const liveEvidence = this.deps.repos.memories.get(item.memoryId);
      if (!liveEvidence || liveEvidence.memoryLayer !== "L1" || liveEvidence.status !== "activated" || namespaceIdFromContext(namespaceForMemory(liveEvidence)) !== namespaceId) return [];
      const captured = capturedMemory ? capturedMemory(item.memoryId) : liveEvidence;
      return captured ? [{ memory: captured, role: rolesFromEvidence(item) }] : [];
    }), ...(!alreadyAttached ? [{ memory, role: match.roles }] : [])];
    const inputHash = topicAnalysisInputHash(match.topic, evidence);
    const claimOwner = newId("topic_analysis_owner");
    const leaseUntil = new Date(Date.parse(at) + (this.deps.analysisLeaseMs ?? 5 * 60_000)).toISOString();
    const centroidHash = topicCentroidInputHash(evidence);
    const completed = this.deps.repos.topics.findAnalysisRun(namespaceId, inputHash);
    if (completed?.status === "succeeded") {
      if (match.topic && match.topic.metadata.centroidInputHash !== centroidHash) {
        const embeddingCentroid = centroid(evidence.map((item) => traceVector(item.memory)).filter((vector): vector is number[] => Boolean(vector)));
        const centroidMetadata: Record<string, unknown> = { ...match.topic.metadata, centroidInputHash: centroidHash };
        if (embeddingCentroid.length) centroidMetadata.embeddingCentroid = embeddingCentroid;
        else delete centroidMetadata.embeddingCentroid;
        this.deps.repos.topics.updateTopicMetadata(match.topic.id, namespaceId, centroidMetadata, at);
      }
      return { assigned: true, unchanged: true, topicId: topic.id, candidateIds: [] };
    }
    if (!this.deps.repos.topics.claimAnalysisRun({ id: newId("topic_analysis"), namespaceId, inputHash, owner: claimOwner, at, leaseUntil })) return { assigned: true, unchanged: true, topicId: topic.id, candidateIds: [] };
    let analysis;
    try {
      analysis = await analyzeProjectTopic({ llm: this.deps.llm, topic: match.topic, evidence });
    } catch (error) {
      this.deps.repos.topics.completeAnalysisRun({ namespaceId, inputHash, owner: claimOwner, status: "failed", result: { error: error instanceof Error ? error.message : String(error) }, at: this.now() });
      throw error;
    }
    const createdCandidates: ProjectTopicCandidateRecord[] = [];
    try {
      this.deps.repos.transaction(() => {
        for (const item of evidence) {
          const currentEvidence = this.deps.repos.memories.get(item.memory.id);
          if (!currentEvidence || currentEvidence.memoryLayer !== "L1" || currentEvidence.status !== "activated" || namespaceIdFromContext(namespaceForMemory(currentEvidence)) !== namespaceId) throw new Error("project topic evidence no longer eligible");
        }
        if (!match.topic) this.deps.repos.topics.insertTopic(topic);
        if (!alreadyAttached) this.deps.repos.topics.attachEvidence({ id: newId("topic_evidence"), topicId: topic.id, namespaceId, memoryId: memory.id, role: primaryRole, summary: memory.memoryValue.slice(0, 500), metadata: { roles: match.roles, contentHash: memory.contentHash, episodeId: stringField(memory.properties.internal_info, "episode_id") }, createdAt: at });
        const sourceMemoryIds = evidence.map((item) => item.memory.id);
        const current = this.deps.repos.topics.getTopic(topic.id, namespaceId)!;
        const embeddingCentroid = centroid(evidence.map((item) => traceVector(item.memory)).filter((vector): vector is number[] => Boolean(vector)));
        const centroidChanged = !sameNumbers(numberArray(current.metadata.embeddingCentroid), embeddingCentroid);
        const materiallyChanged = current.title !== analysis.topic.title || current.summary !== analysis.topic.summary || !sameStrings(current.sourceMemoryIds, sourceMemoryIds);
        const metadata: Record<string, unknown> = { ...current.metadata, signals: unique([...stringArray(current.metadata.signals), ...topicSignalsForMemory(memory)]), centroidInputHash: centroidHash };
        if (embeddingCentroid.length) metadata.embeddingCentroid = embeddingCentroid;
        else delete metadata.embeddingCentroid;
        if (materiallyChanged) this.deps.repos.topics.updateTopic({ ...current, title: analysis.topic.title, summary: analysis.topic.summary, sourceMemoryIds, metadata, version: current.version + 1, updatedAt: at }, current.version);
        else if (centroidChanged || current.metadata.centroidInputHash !== centroidHash) this.deps.repos.topics.updateTopicMetadata(current.id, namespaceId, metadata, at);
        const pending = this.deps.repos.topics.listCandidates(topic.id, namespaceId).filter((candidate) => candidate.status === "pending");
        const pendingByIdentity = new Map(pending.map((candidate) => [candidateIdentityFromRecord(candidate), candidate]));
        const retained = new Set<string>();
        for (const candidate of analysis.candidates) {
          const identity = candidateIdentity(candidate);
          const predecessor = pendingByIdentity.get(identity);
          if (predecessor && predecessor.title === candidate.title && predecessor.conclusion === candidate.conclusion && predecessor.proposedLayer === candidate.proposedLayer) { retained.add(predecessor.id); continue; }
          const policy = evaluateTopicAutoApproval(candidate, evidence.map((item) => item.memory));
          const record: ProjectTopicCandidateRecord = { id: newId("topic_candidate"), topicId: topic.id, namespaceId, title: candidate.title, conclusion: candidate.conclusion, proposedLayer: candidate.proposedLayer, status: "pending", version: 1, supersedesId: predecessor?.id, sourceMemoryIds: candidate.sourceEvidenceIds, metadata: { ...candidate, candidateIdentity: identity, ...(candidate.stableKey ? { stableKey: candidate.stableKey } : {}), policyVersion: policy.policyVersion, autoApprovalRejectionReasons: policy.rejectionReasons, verifiedEvidenceIds: policy.verifiedEvidenceIds, model: this.deps.llm.config.model ?? this.deps.llm.config.provider }, createdAt: at, updatedAt: at };
          this.deps.repos.topics.insertCandidate(record);
          createdCandidates.push(record);
          retained.add(record.id);
          if (policy.approved && !this.hasDuplicateMemory(record, namespace)) this.approve(record, true);
        }
        for (const obsolete of pending.filter((item) => !retained.has(item.id) && item.status === "pending")) this.deps.repos.topics.updateCandidate({ ...obsolete, status: "superseded", version: obsolete.version + 1, updatedAt: at }, obsolete.version);
        if (!this.deps.repos.topics.completeAnalysisRun({ namespaceId, inputHash, owner: claimOwner, status: "succeeded", topicId: topic.id, result: { topic: analysis.topic, candidates: analysis.candidates }, at })) throw new Error("topic analysis claim lost");
      });
    } catch (error) {
      this.deps.repos.topics.completeAnalysisRun({ namespaceId, inputHash, owner: claimOwner, status: "failed", result: { error: error instanceof Error ? error.message : String(error) }, at: this.now() });
      throw error;
    }
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
    if (candidate.version !== decision.expectedVersion) throw new TopicVersionConflictError(candidate.id, candidate.version, candidate.status);
    if (candidate.status !== "pending" && candidate.status !== "deferred") throw new Error(`topic candidate is not decidable: ${candidateId}`);
    const edited = decision.action === "edit_and_approve"
      ? { ...candidate, title: decision.title, conclusion: decision.conclusion, proposedLayer: decision.proposedLayer }
      : candidate;
    if (decision.action === "approve" || decision.action === "edit_and_approve") return this.approve(edited, false, decision.actor);
    const at = nowIso();
    const updated = this.deps.repos.topics.updateCandidate({ ...candidate, status: decision.action === "reject" ? "rejected" : "deferred", version: candidate.version + 1, metadata: { ...candidate.metadata, decisionReason: decision.reason }, updatedAt: at }, candidate.version);
    const audit = this.deps.repos.runtime.insertAudit({ userId: namespace.userId ?? "local", actor: decision.actor ?? { type: "user" }, action: `topic_candidate_${decision.action}`, targetKind: "topic_candidate", targetId: candidate.id, before: candidate, after: updated, meta: { topicId: candidate.topicId, candidateId: candidate.id, reason: decision.reason }, createdAt: at });
    return { candidate: updated, auditId: audit.id };
  }

  merge(namespace: RuntimeNamespace, sourceTopicId: string, input: { targetTopicId: string; expectedVersion: number; targetExpectedVersion: number; actor?: Record<string, unknown> }): TopicMergeResult {
    const namespaceId = namespaceIdFromContext(namespace);
    return this.deps.repos.transaction(() => {
      const source = this.requireTopic(sourceTopicId, namespaceId);
      const target = this.requireTopic(input.targetTopicId, namespaceId);
      if (source.id === target.id) throw new Error("topic cannot be merged into itself");
      if (source.version !== input.expectedVersion) throw new TopicVersionConflictError(source.id, source.version, source.status);
      if (target.version !== input.targetExpectedVersion) throw new TopicVersionConflictError(target.id, target.version, target.status);
      const at = this.now();
      this.deps.repos.topics.moveEvidence(source.id, target.id, namespaceId);
      const updatedTarget = this.deps.repos.topics.updateTopic({ ...target, sourceMemoryIds: unique([...target.sourceMemoryIds, ...source.sourceMemoryIds]), version: target.version + 1, updatedAt: at }, target.version);
      this.deps.repos.topics.updateTopic({ ...source, sourceMemoryIds: [], status: "merged", version: source.version + 1, metadata: { ...source.metadata, mergedIntoTopicId: target.id }, updatedAt: at }, source.version);
      const audit = this.deps.repos.runtime.insertAudit({ userId: namespace.userId ?? "local", actor: input.actor ?? { type: "user" }, action: "project_topic_merged", targetKind: "project_topic", targetId: target.id, before: { source, target }, after: updatedTarget, meta: { sourceTopicId: source.id, targetTopicId: target.id }, createdAt: at });
      return { topic: updatedTarget, mergedTopicId: source.id, auditId: audit.id };
    });
  }

  split(namespace: RuntimeNamespace, sourceTopicId: string, input: { expectedVersion: number; title: string; summary: string; evidenceMemoryIds: string[]; actor?: Record<string, unknown> }): TopicSplitResult {
    const namespaceId = namespaceIdFromContext(namespace);
    return this.deps.repos.transaction(() => {
      const source = this.requireTopic(sourceTopicId, namespaceId);
      if (source.version !== input.expectedVersion) throw new TopicVersionConflictError(source.id, source.version, source.status);
      const evidence = this.deps.repos.topics.listEvidence(source.id, namespaceId);
      const selected = new Set(input.evidenceMemoryIds);
      if (!selected.size || [...selected].some((id) => !evidence.some((item) => item.memoryId === id))) throw new Error("topic split evidence must belong to source topic");
      const at = this.now();
      const topic: ProjectTopicRecord = { id: newId("topic"), namespaceId, projectId: source.projectId, title: input.title, summary: input.summary, status: "active", version: 1, sourceMemoryIds: [...selected], metadata: { splitFromTopicId: source.id }, createdAt: at, updatedAt: at };
      this.deps.repos.topics.insertTopic(topic);
      this.deps.repos.topics.moveEvidence(source.id, topic.id, namespaceId, [...selected]);
      const updatedSource = this.deps.repos.topics.updateTopic({ ...source, sourceMemoryIds: source.sourceMemoryIds.filter((id) => !selected.has(id)), version: source.version + 1, updatedAt: at }, source.version);
      const audit = this.deps.repos.runtime.insertAudit({ userId: namespace.userId ?? "local", actor: input.actor ?? { type: "user" }, action: "project_topic_split", targetKind: "project_topic", targetId: source.id, before: source, after: { source: updatedSource, topic }, meta: { sourceTopicId: source.id, newTopicId: topic.id, evidenceMemoryIds: [...selected] }, createdAt: at });
      return { topic, sourceTopic: updatedSource, auditId: audit.id };
    });
  }

  evidence(namespace: RuntimeNamespace, topicId: string, limit: number): TopicEvidenceResult {
    const namespaceId = namespaceIdFromContext(namespace);
    this.requireTopic(topicId, namespaceId);
    const all = this.deps.repos.topics.listEvidence(topicId, namespaceId);
    return { topicId, total: all.length, limit, items: all.slice(0, limit).map((item) => ({ ...item, rawText: this.deps.repos.memories.get(item.memoryId)?.memoryValue ?? "" })) };
  }

  async refresh(namespace: RuntimeNamespace): Promise<TopicRefreshResult> {
    if (!this.deps.enqueueJob) throw new Error("topic refresh requires a durable job queue");
    const normalized = normalizeNamespace(namespace);
    const namespaceId = namespaceIdFromContext(normalized);
    const snapshotId = this.deps.repos.memories.eligibleL1SnapshotBoundary(namespaceFilter(normalized));
    let cursor = stableHash([]);
    if (snapshotId) {
      try { cursor = this.deps.repos.memories.eligibleL1SnapshotCursor(snapshotId); }
      finally { this.deps.repos.memories.releaseEligibleL1Snapshot(snapshotId); }
    }
    const requestKey = `topic_refresh_request:${namespaceId}`;
    const prior = this.deps.repos.runtime.getKv(requestKey)?.value;
    if (isRefreshRequest(prior) && prior.cursor === cursor) {
      const job = this.deps.repos.runtime.getJob(prior.jobId);
      if (job && (job.status === "queued" || job.status === "leased" || job.status === "succeeded")) return { jobId: prior.jobId, unchanged: true };
    }
    const job = this.deps.enqueueJob({ jobType: "topic_refresh", userId: normalized.userId, payload: { namespace: normalized, namespaceId, evidenceCursor: cursor } });
    this.deps.repos.runtime.setKv(requestKey, { cursor, jobId: job.id });
    return { jobId: job.id, unchanged: false };
  }

  async processRefresh(namespace: RuntimeNamespace, expectedCursor?: string): Promise<void> {
    const normalized = normalizeNamespace(namespace);
    const namespaceId = namespaceIdFromContext(normalized);
    const filter = namespaceFilter(normalized);
    const snapshotId = this.deps.repos.memories.eligibleL1SnapshotBoundary(filter);
    const progressKey = `topic_refresh_progress:${namespaceId}`;
    if (!snapshotId) {
      this.deps.repos.runtime.setKv(`topic_refresh_cursor:${namespaceId}`, stableHash([]));
      this.deps.repos.runtime.setKv(progressKey, { cursor: stableHash([]), completed: true });
      return;
    }
    try {
      const cursor = this.deps.repos.memories.eligibleL1SnapshotCursor(snapshotId);
      if (expectedCursor && expectedCursor !== cursor) {
        throw new Error("topic refresh evidence cursor changed; retry refresh");
      }
      const pageSize = Math.max(1, this.deps.refreshPageSize ?? 1000);
      const capturedMemory = (id: string) => this.deps.repos.memories.getEligibleL1SnapshotMemory(snapshotId, id);
      const storedProgress = refreshProgress(this.deps.repos.runtime.getKv(progressKey)?.value);
      let afterId = storedProgress?.cursor === cursor && !storedProgress.completed ? storedProgress.afterId : undefined;
      for (;;) {
        const page = this.deps.repos.memories.listEligibleL1SnapshotPage(filter, snapshotId, afterId, pageSize);
        if (page.length === 0) break;
        for (const [pageIndex, memory] of page.entries()) {
          this.deps.onRefreshMemory?.(memory, pageIndex);
          await this.ingestMemory(memory, capturedMemory);
        }
        afterId = page[page.length - 1]!.id;
        this.deps.repos.runtime.setKv(progressKey, { cursor, afterId, completed: false });
        if (page.length < pageSize) break;
      }
      this.deps.repos.runtime.setKv(`topic_refresh_cursor:${namespaceId}`, cursor);
      this.deps.repos.runtime.setKv(progressKey, { cursor, afterId, completed: true });
    } finally {
      this.deps.repos.memories.releaseEligibleL1Snapshot(snapshotId);
    }
  }

  private newTopic(memory: MemoryRow, namespaceId: string, at: string): ProjectTopicRecord {
    return { id: newId("topic"), namespaceId, projectId: normalizeNamespace(namespaceForMemory(memory)).projectId, title: memory.tags[0] ?? "Project topic", summary: memory.memoryValue.slice(0, 500), status: "active", version: 1, sourceMemoryIds: [], metadata: { signals: topicSignalsForMemory(memory) }, createdAt: at, updatedAt: at };
  }

  private approve(candidate: ProjectTopicCandidateRecord, automatic: boolean, actor?: Record<string, unknown>): TopicDecisionResult {
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
      const audit = this.deps.repos.runtime.insertAudit({ userId: source.userId, sessionId: source.sessionId, actor: actor ?? { type: automatic ? "system" : "user" }, action: "topic_candidate_approved", targetKind: "memory", targetId: saved.id, after: saved, meta: { topicId: topic.id, candidateId: candidate.id, model: candidate.metadata.model, policyVersion, automatic }, createdAt: at });
      return { candidate: updated, memory: saved, auditId: audit.id };
    });
  }

  private findCandidate(namespaceId: string, candidateId: string): ProjectTopicCandidateRecord | undefined {
    const row = this.deps.repos.db.prepare("SELECT topic_id FROM project_topic_candidates WHERE id = ? AND namespace_id = ?").get(candidateId, namespaceId) as { topic_id: string } | undefined;
    return row ? this.deps.repos.topics.listCandidates(row.topic_id, namespaceId).find((candidate) => candidate.id === candidateId) : undefined;
  }

  private requireTopic(topicId: string, namespaceId: string): ProjectTopicRecord {
    const topic = this.deps.repos.topics.getTopic(topicId, namespaceId);
    if (!topic) throw new Error(`topic not found in namespace: ${topicId}`);
    return topic;
  }

  private hasDuplicateMemory(candidate: ProjectTopicCandidateRecord, namespace: RuntimeNamespace): boolean {
    const normalized = candidate.conclusion.trim().toLowerCase();
    return this.deps.repos.memories.list({ memoryLayer: "L2", ...namespaceFilter(namespace) }, 10_000).some((memory) => memory.status !== "archived" && memory.memoryValue.trim().toLowerCase() === normalized);
  }

  private now(): string { return this.deps.now?.() ?? nowIso(); }
}

export class TopicVersionConflictError extends Error {
  constructor(readonly entityId: string, readonly currentVersion: number, readonly currentStatus: string) {
    super(`topic version conflict: ${entityId}`);
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
function refreshProgress(value: unknown): { cursor: string; afterId?: string; completed: boolean } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const progress = value as Record<string, unknown>;
  if (typeof progress.cursor !== "string" || typeof progress.completed !== "boolean") return undefined;
  return { cursor: progress.cursor, completed: progress.completed, ...(typeof progress.afterId === "string" ? { afterId: progress.afterId } : {}) };
}
function candidateIdentity(candidate: { proposedLayer: string; title: string; stableKey?: string; sourceEvidenceIds?: string[]; sensitiveCategories: string[] }): string {
  if (candidate.stableKey) return stableHash({ layer: candidate.proposedLayer, stableKey: candidate.stableKey.normalize("NFKC").toLocaleLowerCase() }).slice(0, 32);
  return stableHash({
    layer: candidate.proposedLayer,
    title: candidate.title.normalize("NFKC").toLocaleLowerCase(),
    evidence: [...(candidate.sourceEvidenceIds ?? [])].sort(),
    sensitive: candidate.sensitiveCategories.map((item) => item.normalize("NFKC").toLocaleLowerCase()).sort()
  }).slice(0, 32);
}
function candidateIdentityFromRecord(candidate: ProjectTopicCandidateRecord): string {
  return stringField(candidate.metadata, "candidateIdentity") ?? candidateIdentity({ proposedLayer: candidate.proposedLayer, title: candidate.title, stableKey: stringField(candidate.metadata, "stableKey"), sourceEvidenceIds: candidate.sourceMemoryIds, sensitiveCategories: stringArray(candidate.metadata.sensitiveCategories) });
}
function traceVector(memory: MemoryRow): number[] | null {
  return memoryVector(memory, "vec_summary");
}
function centroid(vectors: number[][]): number[] {
  if (!vectors.length) return [];
  const dimensionCounts = new Map<number, number>();
  for (const vector of vectors) dimensionCounts.set(vector.length, (dimensionCounts.get(vector.length) ?? 0) + 1);
  const dimension = [...dimensionCounts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]![0];
  const compatible = vectors.filter((vector) => vector.length === dimension);
  return compatible[0]!.map((_, index) => compatible.reduce((sum, vector) => sum + vector[index]!, 0) / compatible.length);
}
function numberArray(value: unknown): number[] { return Array.isArray(value) && value.every((item) => typeof item === "number" && Number.isFinite(item)) ? value : []; }
function sameNumbers(left: number[], right: number[]): boolean { return left.length === right.length && left.every((value, index) => value === right[index]); }
