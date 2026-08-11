import { afterEach, describe, expect, it } from "vitest";
import { createMemoryServiceFixture } from "../../fixtures/memory-service-fixture.js";

const {
  cleanup,
  createTestService
} = createMemoryServiceFixture();

afterEach(cleanup);

describe("MemoryService / bundle", () => {
  it("exports only the requested namespace and its dependency rows", async () => {
    const { db, service } = createTestService();
    const namespaceA = {
      source: "codex",
      profileId: "default",
      userId: "shared-export-user",
      workspaceId: "workspace-export-a"
    };
    const namespaceB = {
      source: "codex",
      profileId: "default",
      userId: "shared-export-user",
      workspaceId: "workspace-export-b"
    };
    const sessionA = service.openSession({ namespace: namespaceA });
    const sessionB = service.openSession({ namespace: namespaceB });
    const completeA = service.completeTurn("turn-export-a", {
      sessionId: sessionA.sessionId,
      query: "scoped export memory alpha",
      answer: "stored only in export namespace alpha",
      artifacts: [{
        kind: "file",
        uri: "file:///tmp/export-alpha.txt"
      }]
    });
    const completeB = service.completeTurn("turn-export-b", {
      sessionId: sessionB.sessionId,
      query: "scoped export memory beta",
      answer: "stored only in export namespace beta"
    });
    await service.runWorkerOnce(20);
    const recallA = await service.search({
      namespace: namespaceA,
      query: "scoped export memory alpha",
      layers: ["L1"],
      limit: 5
    });
    const recallB = await service.search({
      namespace: namespaceB,
      query: "scoped export memory beta",
      layers: ["L1"],
      limit: 5
    });

    const bundleA = service.exportBundle({ namespace: namespaceA });
    const memoryIds = (bundleA.tables.memories as Array<Record<string, unknown>>).map((row) => row.id);
    expect(memoryIds).toContain(completeA.l1MemoryId);
    expect(memoryIds).not.toContain(completeB.l1MemoryId);
    const sessionIds = (bundleA.tables.sessions as Array<Record<string, unknown>>).map((row) => row.id);
    expect(sessionIds).toEqual([sessionA.sessionId]);
    const rawTurnIds = (bundleA.tables.raw_turns as Array<Record<string, unknown>>).map((row) => row.id);
    expect(rawTurnIds).toContain(completeA.rawTurnId);
    expect(rawTurnIds).not.toContain(completeB.rawTurnId);
    const recallIds = (bundleA.tables.recall_events as Array<Record<string, unknown>>).map((row) => row.id);
    expect(recallIds).toContain(recallA.searchEventId);
    expect(recallIds).not.toContain(recallB.searchEventId);
    const artifactRawTurnIds = (bundleA.tables.artifacts as Array<Record<string, unknown>>)
      .map((row) => row.raw_turn_id);
    expect(artifactRawTurnIds).toEqual([completeA.rawTurnId]);
    const jobSessionIds = new Set((bundleA.tables.evolution_jobs as Array<Record<string, unknown>>)
      .map((row) => row.session_id));
    expect(jobSessionIds).toEqual(new Set([sessionA.sessionId]));
    const changeNamespaces = new Set((bundleA.tables.memory_change_log as Array<Record<string, unknown>>)
      .map((row) => row.namespace_id));
    expect([...changeNamespaces].some((namespace) => String(namespace).includes("workspace-export-a"))).toBe(true);
    expect([...changeNamespaces].some((namespace) => String(namespace).includes("workspace-export-b"))).toBe(false);


    const namespaceIdA = `local:${namespaceA.workspaceId}`;
    const namespaceIdB = `local:${namespaceB.workspaceId}`;
    db.db.prepare(`INSERT INTO project_topics (id, namespace_id, title, summary, status, version, created_at, updated_at) VALUES (?, ?, 'A', '', 'active', 1, ?, ?), (?, ?, 'B', '', 'active', 1, ?, ?)`)
      .run("topic-export-a", namespaceIdA, "2026-08-11T00:00:00.000Z", "2026-08-11T00:00:00.000Z", "topic-export-b", namespaceIdB, "2026-08-11T00:00:00.000Z", "2026-08-11T00:00:00.000Z");
    db.db.prepare(`INSERT INTO project_topic_evidence (id, topic_id, namespace_id, memory_id, role, summary, created_at) VALUES (?, ?, ?, ?, 'source', '', ?), (?, ?, ?, ?, 'source', '', ?)`)
      .run("evidence-export-a", "topic-export-a", namespaceIdA, completeA.l1MemoryId, "2026-08-11T00:00:00.000Z", "evidence-inconsistent", "topic-export-a", namespaceIdA, completeB.l1MemoryId, "2026-08-11T00:00:00.000Z");
    const topicBundle = service.exportBundle({ namespace: namespaceA });
    expect((topicBundle.tables.project_topics ?? []).map((row) => row.id)).toEqual(["topic-export-a"]);
    expect((topicBundle.tables.project_topic_evidence ?? []).map((row) => row.id)).toEqual(["evidence-export-a"]);

    const inconsistentBundle = structuredClone(topicBundle);
    inconsistentBundle.tables.project_topic_evidence = inconsistentBundle.tables.project_topic_evidence ?? [];
    inconsistentBundle.tables.project_topic_evidence.push({
      id: "evidence-import-invalid",
      topic_id: "topic-export-a",
      namespace_id: namespaceIdA,
      memory_id: completeB.l1MemoryId,
      role: "source",
      summary: "",
      metadata_json: "{}",
      created_at: "2026-08-11T00:00:00.000Z"
    });
    expect(() => service.importBundle({ namespace: namespaceA, bundle: inconsistentBundle })).toThrow(/outside the requested namespace/);
    db.close();
  });
});
