import { afterEach, describe, expect, it } from "vitest";
import type { EnqueueJobInput } from "../../../src/service/worker/job-handlers.js";
import type { LlmClient, LlmCompletionOptions, LlmMessage } from "../../../src/model/types.js";
import { DEFAULT_MEMMY_CONFIG, MemoryService, Repositories } from "../../../src/index.js";
import { ProjectTopicInboxService } from "../../../src/service/topic-inbox/project-topic-inbox.js";
import { attachMemoryVector } from "../../../src/storage/memory-vector-state.js";
import { createMemoryServiceFixture } from "../../fixtures/memory-service-fixture.js";

const fixture = createMemoryServiceFixture();
afterEach(fixture.cleanup);

function topicLlm(responses: Array<Record<string, unknown>>): LlmClient {
  let index = 0;
  return {
    config: { ...DEFAULT_MEMMY_CONFIG.evolution, provider: "host", endpoint: "http://test", model: "topic-test" },
    isConfigured: () => true,
    complete: async () => "{}",
    completeJson: async <T extends Record<string, unknown>>() => responses[Math.min(index++, responses.length - 1)] as T,
    status: () => ({ provider: "host", model: "topic-test", configured: true, remote: false })
  };
}

function insertTrace(service: MemoryService, text: string, requestId: string): string {
  return service.addMemory({
    namespace: { source: "codex", profileId: "p", userId: "u", projectId: "project" },
    adapterId: "test", requestId, layer: "L1", source: "codex", title: text,
    content: `## user\n\n${text}\n\n## assistant\n\nfixed and verified with focused test`,
    tags: ["sqlite", "migration"], turnId: requestId
  }).id;
}

describe("ProjectTopicInbox", () => {
  it("joins related evidence, remains idempotent, and supersedes changed conclusions", async () => {
    const { db, service } = fixture.createTestService();
    const repos = new Repositories(db.db);
    const firstId = insertTrace(service, "sqlite migration error", "topic-1");
    const secondId = insertTrace(service, "sqlite migration fix verified", "topic-2");
    const inbox = new ProjectTopicInboxService({
      repos,
      llm: topicLlm([
        { topic: { title: "SQLite migration", summary: "An error, fix, and verification chain." }, candidates: [{ title: "Verify migrations", conclusion: "Run the focused migration test after the fix.", proposedLayer: "L2", risk: "medium", confidence: "high", verificationStatus: "verified", verificationEvidence: "focused migration test passed", sourceEvidenceIds: [firstId], conflicts: [], sensitiveCategories: [] }] },
        { topic: { title: "SQLite migration", summary: "An error, fix, and verification chain." }, candidates: [{ title: "Verify migrations", conclusion: "Run the focused migration test after every schema change.", proposedLayer: "L2", risk: "medium", confidence: "high", verificationStatus: "verified", verificationEvidence: "focused migration test passed", sourceEvidenceIds: [firstId, secondId], conflicts: [], sensitiveCategories: [] }] }
      ]),
      buildMemory: () => { throw new Error("automatic approval is tested separately"); },
      upsertMemory: (memory) => repos.memories.upsertByKey(memory)
    });

    await inbox.ingest(firstId);
    await inbox.ingest(secondId);
    const namespace = { source: "codex", profileId: "p", userId: "u", projectId: "project" };
    const view = inbox.list(namespace);
    expect(view.topics).toHaveLength(1);
    expect(view.topics[0]?.evidence.map((item) => item.memoryId)).toEqual([firstId, secondId]);
    const version = view.topics[0]!.topic.version;
    await inbox.ingest(secondId);
    expect(inbox.list(namespace).topics[0]!.topic.version).toBe(version);
    const candidates = inbox.list(namespace).topics[0]!.candidates;
    expect(candidates.some((candidate) => candidate.status === "superseded")).toBe(true);
    expect(candidates.some((candidate) => candidate.status === "pending")).toBe(true);
  });

  it("fails closed when deciding a candidate from another namespace", async () => {
    const { db, service } = fixture.createTestService();
    const repos = new Repositories(db.db);
    const memoryId = insertTrace(service, "formatter workflow", "namespace-decision");
    const inbox = new ProjectTopicInboxService({ repos, llm: topicLlm([{ topic: { title: "Formatter", summary: "Formatting workflow" }, candidates: [{ title: "Run formatter", conclusion: "Run formatter check.", proposedLayer: "L2", risk: "medium", confidence: "high", verificationStatus: "verified", verificationEvidence: "passed", sourceEvidenceIds: [memoryId], conflicts: [], sensitiveCategories: [] }] }]), buildMemory: () => { throw new Error("unused"); }, upsertMemory: (item) => repos.memories.upsertByKey(item) });
    await inbox.ingest(memoryId);
    const candidate = inbox.list({ source: "codex", profileId: "p", projectId: "project" }).topics[0]!.candidates[0]!;
    await expect(inbox.decide({ source: "codex", profileId: "p", projectId: "other" }, candidate.id, { decision: "reject" })).rejects.toThrow("not found in namespace");
  });

  it("preserves the prior topic version when model output is invalid", async () => {
    const { db, service } = fixture.createTestService();
    const repos = new Repositories(db.db);
    const memoryId = insertTrace(service, "sqlite migration error", "topic-failure");
    const inbox = new ProjectTopicInboxService({ repos, llm: topicLlm([{ topic: { title: "SQLite", summary: "Valid summary" }, candidates: [] }, { broken: true }]), buildMemory: () => { throw new Error("unused"); }, upsertMemory: (item) => repos.memories.upsertByKey(item) });
    await inbox.ingest(memoryId);
    const namespace = { source: "codex", profileId: "p", userId: "u", projectId: "project" };
    const before = inbox.list(namespace).topics[0]!.topic;
    const changed = repos.memories.get(memoryId)!;
    repos.memories.update({ ...changed, version: changed.version + 1, memoryValue: `${changed.memoryValue}\nchanged`, updatedAt: new Date().toISOString() });
    await expect(inbox.ingest(memoryId)).rejects.toThrow("invalid topic analysis result");
    expect(inbox.list(namespace).topics[0]!.topic.version).toBe(before.version);
  });

  it("paginates the full refresh corpus and requeues a failed same-cursor job", async () => {
    const { db, service } = fixture.createTestService();
    const repos = new Repositories(db.db);
    for (let index = 0; index < 7; index += 1) insertTrace(service, `independent refresh trace ${index}`, `refresh-${index}`);
    const enqueueJob = (input: EnqueueJobInput) => repos.runtime.enqueueJob({
      id: `refresh-job-${Date.now()}-${Math.random()}`, jobType: input.jobType, status: "queued", dedupeKey: input.dedupeKey ?? `topic_refresh:${String(input.payload?.namespaceId)}:${String(input.payload?.evidenceCursor)}`,
      userId: input.userId, payload: input.payload ?? {}, attempts: 0, maxAttempts: 3, createdAt: input.createdAt ?? new Date().toISOString(), updatedAt: input.createdAt ?? new Date().toISOString()
    });
    const inbox = new ProjectTopicInboxService({ repos, llm: topicLlm([{ topic: { title: "Refresh", summary: "Refresh corpus" }, candidates: [] }]), buildMemory: () => { throw new Error("unused"); }, upsertMemory: (item) => repos.memories.upsertByKey(item), enqueueJob, refreshPageSize: 3 });
    const namespace = { source: "codex", profileId: "p", userId: "u", projectId: "project" };
    const first = await inbox.refresh(namespace);
    expect((repos.runtime.getJob(first.jobId)?.payload as { evidenceCursor?: string }).evidenceCursor).toBeTruthy();
    repos.runtime.failJob(first.jobId, "transient");
    const retried = await inbox.refresh(namespace);
    expect(retried).toEqual({ jobId: first.jobId, unchanged: false });
    expect(repos.runtime.getJob(first.jobId)?.status).toBe("queued");
    await inbox.processRefresh(namespace);
    expect(inbox.list(namespace).topics.reduce((count, item) => count + item.evidence.length, 0)).toBe(7);
  });
  it("uses captured rows when a separate connection mutates namespace, layer, eligibility, and content between pages", async () => {
    const { db, service } = fixture.createTestService();
    const repos = new Repositories(db.db);
    const capturedIds = Array.from({ length: 7 }, (_, index) => insertTrace(service, `captured refresh trace ${index}`, `snapshot-${index}`));
    const capturedValues = new Map(capturedIds.map((id) => [id, repos.memories.get(id)!.memoryValue]));
    const pageMethod = repos.memories.listEligibleL1SnapshotPage.bind(repos.memories);
    let pages = 0;
    repos.memories.listEligibleL1SnapshotPage = (filter, snapshotId, afterId, limit) => {
      const page = pageMethod(filter, snapshotId, afterId, limit);
      pages += 1;
      if (pages === 1) {
        const concurrentDb = new Repositories(db.db);
        insertTrace(service, "concurrent refresh insert", "snapshot-concurrent");
        const namespaceChanged = concurrentDb.memories.get(capturedIds[3]!)!;
        concurrentDb.memories.update({ ...namespaceChanged, appId: "other-project", info: { ...namespaceChanged.info, project_id: "other-project" }, updatedAt: new Date().toISOString() });
        const layerChanged = concurrentDb.memories.get(capturedIds[4]!)!;
        concurrentDb.memories.update({ ...layerChanged, memoryLayer: "L2", properties: { ...layerChanged.properties, internal_info: { ...layerChanged.properties.internal_info, memory_layer: "L2" } }, updatedAt: new Date().toISOString() });
        const archived = concurrentDb.memories.get(capturedIds[5]!)!;
        concurrentDb.memories.update({ ...archived, status: "archived", updatedAt: new Date().toISOString() });
        const contentChanged = concurrentDb.memories.get(capturedIds[6]!)!;
        concurrentDb.memories.update({ ...contentChanged, memoryValue: "mutated after snapshot", updatedAt: new Date().toISOString() });
      }
      return page;
    };
    const seenValues = new Map<string, string>();
    const inbox = new ProjectTopicInboxService({ repos, llm: {
      ...topicLlm([]),
      completeJson: async <T extends Record<string, unknown>>(_messages: LlmMessage[], _options: LlmCompletionOptions) => {
        const payload = JSON.parse(_messages[1]!.content) as { evidence: Array<{ id: string; value: string }> };
        for (const evidence of payload.evidence) seenValues.set(evidence.id, evidence.value);
        return { topic: { title: "Snapshot", summary: "Captured corpus" }, candidates: [] } as unknown as T;
      }
    }, buildMemory: () => { throw new Error("unused"); }, upsertMemory: (item) => repos.memories.upsertByKey(item), refreshPageSize: 3 });
    await inbox.processRefresh({ source: "codex", profileId: "p", userId: "u", projectId: "project" });

    const evidenceIds = inbox.list({ source: "codex", profileId: "p", userId: "u", projectId: "project" }).topics.flatMap((item) => item.evidence.map((evidence) => evidence.memoryId));
    expect(evidenceIds.sort()).toEqual(capturedIds.sort());
    expect(new Set(evidenceIds).size).toBe(capturedIds.length);
    expect(seenValues.get(capturedIds[6]!)).toBe(capturedValues.get(capturedIds[6]!));
    expect(pages).toBeGreaterThan(1);
  });


  it("keeps Unicode same-title candidates distinct while preserving stable-key lineage", async () => {
    const { db, service } = fixture.createTestService();
    const repos = new Repositories(db.db);
    const memoryId = insertTrace(service, "中文发布流程", "unicode-candidates");
    const base = { title: "发布检查", proposedLayer: "L2", risk: "medium", confidence: "high", verificationStatus: "verified", verificationEvidence: "passed", sourceEvidenceIds: [memoryId], conflicts: [], sensitiveCategories: [] };
    const inbox = new ProjectTopicInboxService({ repos, llm: topicLlm([
      { topic: { title: "发布", summary: "中文流程" }, candidates: [{ ...base, stableKey: "frontend", conclusion: "检查前端。" }, { ...base, stableKey: "backend", conclusion: "检查后端。" }] },
      { topic: { title: "发布", summary: "中文流程更新" }, candidates: [{ ...base, stableKey: "backend", conclusion: "检查后端。" }, { ...base, stableKey: "frontend", conclusion: "检查前端和资源。" }] }
    ]), buildMemory: () => { throw new Error("unused"); }, upsertMemory: (item) => repos.memories.upsertByKey(item) });
    await inbox.ingest(memoryId);
    const changed = repos.memories.get(memoryId)!;
    repos.memories.update({ ...changed, version: changed.version + 1, memoryValue: `${changed.memoryValue}\nupdated`, updatedAt: new Date().toISOString() });
    await inbox.ingest(memoryId);
    const candidates = inbox.list({ source: "codex", profileId: "p", userId: "u", projectId: "project" }).topics[0]!.candidates;
    expect(candidates.filter((item) => item.status === "pending").map((item) => item.metadata.stableKey).sort()).toEqual(["backend", "frontend"]);
    expect(candidates.find((item) => item.metadata.stableKey === "frontend" && item.status === "pending")?.supersedesId).toBeTruthy();
  });
  it("uses stableKey as the title-independent Unicode slot while title-only edits supersede lineage", async () => {
    const { db, service } = fixture.createTestService();
    const repos = new Repositories(db.db);
    const memoryId = insertTrace(service, "中文候选槽位", "unicode-stable-key");
    const base = { stableKey: "发布/前端", proposedLayer: "L2", risk: "medium", confidence: "high", verificationStatus: "verified", verificationEvidence: "passed", sourceEvidenceIds: [memoryId], conflicts: [], sensitiveCategories: [] };
    const inbox = new ProjectTopicInboxService({ repos, llm: topicLlm([
      { topic: { title: "发布", summary: "中文流程" }, candidates: [{ ...base, title: "检查前端", conclusion: "检查资源。" }] },
      { topic: { title: "发布", summary: "中文流程" }, candidates: [{ ...base, title: "验证前端发布", conclusion: "检查资源。" }] }
    ]), buildMemory: () => { throw new Error("unused"); }, upsertMemory: (item) => repos.memories.upsertByKey(item) });
    await inbox.ingest(memoryId);
    const changed = repos.memories.get(memoryId)!;
    repos.memories.update({ ...changed, memoryValue: `${changed.memoryValue}\nchanged`, updatedAt: new Date().toISOString() });
    await inbox.ingest(memoryId);

    const candidates = inbox.list({ source: "codex", profileId: "p", userId: "u", projectId: "project" }).topics[0]!.candidates;
    const current = candidates.find((item) => item.status === "pending")!;
    expect(current.title).toBe("验证前端发布");
    expect(current.conclusion).toBe("检查资源。");
    expect(current.supersedesId).toBe(candidates.find((item) => item.title === "检查前端")?.id);
    expect(current.metadata.stableKey).toBe("发布/前端");
  });

  it("keeps Chinese fallback slots deterministic without stableKey", async () => {
    const { db, service } = fixture.createTestService();
    const repos = new Repositories(db.db);
    const memoryId = insertTrace(service, "中文回退槽位", "unicode-fallback");
    const base = { title: "发布检查", proposedLayer: "L2", risk: "medium", confidence: "high", verificationStatus: "verified", verificationEvidence: "passed", sourceEvidenceIds: [memoryId], conflicts: [], sensitiveCategories: ["配置"] };
    const inbox = new ProjectTopicInboxService({ repos, llm: topicLlm([
      { topic: { title: "发布", summary: "中文回退" }, candidates: [{ ...base, conclusion: "检查资源。" }] },
      { topic: { title: "发布", summary: "中文回退" }, candidates: [{ ...base, conclusion: "检查资源和产物。" }] }
    ]), buildMemory: () => { throw new Error("unused"); }, upsertMemory: (item) => repos.memories.upsertByKey(item) });
    await inbox.ingest(memoryId);
    const changed = repos.memories.get(memoryId)!;
    repos.memories.update({ ...changed, memoryValue: `${changed.memoryValue}\nchanged`, updatedAt: new Date().toISOString() });
    await inbox.ingest(memoryId);
    const candidates = inbox.list({ source: "codex", profileId: "p", userId: "u", projectId: "project" }).topics[0]!.candidates;
    expect(candidates.find((item) => item.status === "pending")?.supersedesId).toBe(candidates.find((item) => item.status === "superseded")?.id);
  });

  it("rejects duplicate candidate slots before topic, evidence, or candidate writes", async () => {
    const { db, service } = fixture.createTestService();
    const repos = new Repositories(db.db);
    const memoryId = insertTrace(service, "duplicate slots", "duplicate-slots");
    const base = { stableKey: "same-slot", proposedLayer: "L2", risk: "medium", confidence: "high", verificationStatus: "verified", verificationEvidence: "passed", sourceEvidenceIds: [memoryId], conflicts: [], sensitiveCategories: [] };
    const inbox = new ProjectTopicInboxService({ repos, llm: topicLlm([{ topic: { title: "Duplicates", summary: "Invalid duplicate result" }, candidates: [{ ...base, title: "First", conclusion: "First result." }, { ...base, title: "Second", conclusion: "Second result." }] }]), buildMemory: () => { throw new Error("unused"); }, upsertMemory: (item) => repos.memories.upsertByKey(item) });

    await expect(inbox.ingest(memoryId)).rejects.toThrow("duplicate topic candidate slot");
    expect(inbox.list({ source: "codex", profileId: "p", userId: "u", projectId: "project" }).topics).toEqual([]);
    expect(db.db.prepare(`SELECT COUNT(*) AS count FROM project_topic_evidence`).get()).toEqual({ count: 0 });
    expect(db.db.prepare(`SELECT COUNT(*) AS count FROM project_topic_candidates`).get()).toEqual({ count: 0 });
  });

  it("recomputes centroid for vector-only changes without invoking semantic analysis or lifecycle changes", async () => {
    const { db, service } = fixture.createTestService();
    const repos = new Repositories(db.db);
    const memoryId = insertTrace(service, "vector centroid", "vector-centroid");
    repos.memories.updateMaintenance(attachMemoryVector(repos.memories.get(memoryId)!, { vectorField: "vec_summary", vector: [1, 0] }));
    let llmCalls = 0;
    const firstResponse = { topic: { title: "Vectors", summary: "Vector centroid" }, candidates: [{ stableKey: "vector-policy", title: "Vector policy", conclusion: "Keep vectors current.", proposedLayer: "L2", risk: "medium", confidence: "high", verificationStatus: "verified", verificationEvidence: "passed", sourceEvidenceIds: [memoryId], conflicts: [], sensitiveCategories: [] }] };
    const deliberatelyDifferent = { topic: { title: "Wrong second analysis", summary: "Must not be used" }, candidates: [{ stableKey: "different", title: "Different", conclusion: "Different lifecycle.", proposedLayer: "L3", risk: "high", confidence: "low", verificationStatus: "unverified", verificationEvidence: "", sourceEvidenceIds: [memoryId], conflicts: [], sensitiveCategories: [] }] };
    const llm = topicLlm([firstResponse, deliberatelyDifferent]);
    const completeJson = llm.completeJson.bind(llm);
    llm.completeJson = async <T extends Record<string, unknown>>(messages: LlmMessage[], options: LlmCompletionOptions) => { llmCalls += 1; return completeJson<T>(messages, options); };
    const inbox = new ProjectTopicInboxService({ repos, llm, buildMemory: () => { throw new Error("unused"); }, upsertMemory: (item) => repos.memories.upsertByKey(item) });
    await inbox.ingest(memoryId);
    const namespace = { source: "codex", profileId: "p", userId: "u", projectId: "project" };
    const before = inbox.list(namespace).topics[0]!;
    repos.memories.updateMaintenance(attachMemoryVector(repos.memories.get(memoryId)!, { vectorField: "vec_summary", vector: [0, 1] }));
    await inbox.ingest(memoryId);
    const after = inbox.list(namespace).topics[0]!;

    expect(llmCalls).toBe(1);
    expect(after.topic.metadata.embeddingCentroid).toEqual([0, 1]);
    expect(after.topic.version).toBe(before.topic.version);
    expect(after.topic.title).toBe("Vectors");
    expect(after.candidates).toEqual(before.candidates);
  });


  it("rolls back approval memory and candidate writes when persistence fails", async () => {
    const { db, service } = fixture.createTestService();
    const repos = new Repositories(db.db);
    const memoryId = insertTrace(service, "transactional approval", "approval-rollback");
    const namespace = { source: "codex", profileId: "p", userId: "u", projectId: "project" };
    const source = repos.memories.get(memoryId)!;
    const inbox = new ProjectTopicInboxService({
      repos,
      llm: topicLlm([{ topic: { title: "Approval", summary: "Transactional approval" }, candidates: [{ title: "Approve atomically", conclusion: "Persist approval atomically.", proposedLayer: "L2", risk: "medium", confidence: "high", verificationStatus: "verified", verificationEvidence: "passed", sourceEvidenceIds: [memoryId], conflicts: [], sensitiveCategories: [] }] }]),
      buildMemory: () => ({ ...source, id: "rollback-l2", memoryLayer: "L2", memoryKey: "rollback-l2", memoryValue: "Persist approval atomically.", properties: { ...source.properties, internal_info: { ...source.properties.internal_info, memory_layer: "L2", memory_kind: "policy" } } }),
      upsertMemory: (memory) => {
        repos.memories.upsertByKey(memory);
        throw new Error("injected approval persistence failure");
      }
    });
    await inbox.ingest(memoryId);
    const candidate = inbox.list(namespace).topics[0]!.candidates[0]!;
    await expect(inbox.decide(namespace, candidate.id, { decision: "approve" })).rejects.toThrow("injected approval persistence failure");
    expect(repos.memories.get("rollback-l2")).toBeUndefined();
    expect(inbox.list(namespace).topics[0]!.candidates.find((item) => item.id === candidate.id)?.status).toBe("pending");
  });

  it("rolls back approval supersession, relation, candidate, and audit after new-memory upsert", async () => {
    const { db, service } = fixture.createTestService();
    const repos = new Repositories(db.db);
    const memoryId = insertTrace(service, "approval predecessor rollback", "approval-predecessor-rollback");
    const source = repos.memories.get(memoryId)!;
    const namespace = { source: "codex", profileId: "p", userId: "u", projectId: "project" };
    let built = 0;
    const inbox = new ProjectTopicInboxService({
      repos,
      llm: topicLlm([
        { topic: { title: "Approval rollback", summary: "First conclusion" }, candidates: [{ stableKey: "approval-slot", title: "Approve first", conclusion: "First approved conclusion.", proposedLayer: "L2", risk: "medium", confidence: "high", verificationStatus: "verified", verificationEvidence: "passed", sourceEvidenceIds: [memoryId], conflicts: [], sensitiveCategories: [] }] },
        { topic: { title: "Approval rollback", summary: "Second conclusion" }, candidates: [{ stableKey: "approval-slot", title: "Approve replacement", conclusion: "Replacement approved conclusion.", proposedLayer: "L2", risk: "medium", confidence: "high", verificationStatus: "verified", verificationEvidence: "passed", sourceEvidenceIds: [memoryId], conflicts: [], sensitiveCategories: [] }] }
      ]),
      buildMemory: (input) => {
        built += 1;
        return { ...source, id: `rollback-approved-${built}`, memoryLayer: "L2", memoryKey: String(input.key), memoryValue: String(input.value), properties: { ...source.properties, internal_info: { ...source.properties.internal_info, memory_layer: "L2", memory_kind: "policy" } } };
      },
      upsertMemory: (memory) => repos.memories.upsertByKey(memory)
    });
    await inbox.ingest(memoryId);
    const firstCandidate = inbox.list(namespace).topics[0]!.candidates.find((item) => item.status === "pending")!;
    const firstDecision = await inbox.decide(namespace, firstCandidate.id, { decision: "approve" });
    const firstMemory = firstDecision.memory!;
    const changed = repos.memories.get(memoryId)!;
    repos.memories.update({ ...changed, memoryValue: `${changed.memoryValue}\nreplacement`, updatedAt: new Date().toISOString() });
    await inbox.ingest(memoryId);
    const replacement = inbox.list(namespace).topics[0]!.candidates.find((item) => item.status === "pending")!;
    const auditBefore = repos.runtime.listAudit({ limit: 100 }).length;
    const originalInsertAudit = repos.runtime.insertAudit.bind(repos.runtime);
    repos.runtime.insertAudit = () => { throw new Error("injected post-upsert approval failure"); };

    await expect(inbox.decide(namespace, replacement.id, { decision: "approve" })).rejects.toThrow("injected post-upsert approval failure");

    repos.runtime.insertAudit = originalInsertAudit;
    expect(repos.memories.get(firstMemory.id)?.status).toBe("activated");
    expect(repos.memories.get("rollback-approved-2")).toBeUndefined();
    expect(repos.memories.relationsFor(firstMemory.id)).toEqual([]);
    expect(inbox.list(namespace).topics[0]!.candidates.find((item) => item.id === replacement.id)?.status).toBe("pending");
    expect(repos.runtime.listAudit({ limit: 100 })).toHaveLength(auditBefore);
  });
});
