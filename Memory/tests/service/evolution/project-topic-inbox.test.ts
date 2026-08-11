import { afterEach, describe, expect, it } from "vitest";
import type { EnqueueJobInput } from "../../../src/service/worker/job-handlers.js";
import { DEFAULT_MEMMY_CONFIG, MemoryService, Repositories, type LlmClient } from "../../../src/index.js";
import { ProjectTopicInboxService } from "../../../src/service/topic-inbox/project-topic-inbox.js";
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
});
