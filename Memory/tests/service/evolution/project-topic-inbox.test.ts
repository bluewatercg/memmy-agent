import { afterEach, describe, expect, it } from "vitest";
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
});
