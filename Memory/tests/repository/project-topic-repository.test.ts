import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryDb } from "../../src/storage/db.js";
import { ProjectTopicRepository, Repositories } from "../../src/storage/repositories.js";
import type { ProjectTopicCandidateRecord, ProjectTopicEvidenceRecord, ProjectTopicRecord } from "../../src/types.js";

const NOW = "2026-08-11T00:00:00.000Z";
function topic(namespaceId: string, id: string): ProjectTopicRecord { return { id, namespaceId, title: id, summary: "summary", status: "active", version: 1, sourceMemoryIds: [], metadata: {}, createdAt: NOW, updatedAt: NOW }; }
function withRepo<T>(run: (repo: ProjectTopicRepository, db: MemoryDb) => T): T {
  const root = mkdtempSync(join(tmpdir(), "project-topic-repository-"));
  const db = new MemoryDb({ path: join(root, "memory.sqlite") });
  try { return run(new Repositories(db.db).topics, db); } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
}
describe("project topic repository", () => {
  it("persists topics with namespace filtering and optimistic updates", () => withRepo((repo) => {
    const first = topic("ns-a", "topic-a"); const other = topic("ns-b", "topic-b");
    expect(repo.insertTopic(first)).toEqual(first); repo.insertTopic(other);
    expect(repo.getTopic("topic-a", "ns-b")).toBeUndefined(); expect(repo.listTopics("ns-a")).toEqual([first]);
    const updated = { ...first, title: "updated", version: 2, updatedAt: "2026-08-11T01:00:00.000Z" };
    expect(repo.updateTopic(updated, 1)).toEqual(updated); expect(() => repo.updateTopic({ ...updated, version: 3 }, 1)).toThrow(/version conflict/);
  }));
  it("deduplicates evidence and supersedes candidates", () => withRepo((repo) => {
    repo.insertTopic(topic("ns-a", "topic-a"));
    const evidence: ProjectTopicEvidenceRecord = { id: "e1", topicId: "topic-a", namespaceId: "ns-a", memoryId: "m1", role: "source", summary: "evidence", metadata: {}, createdAt: NOW };
    expect(repo.attachEvidence(evidence)).toEqual(evidence); expect(repo.attachEvidence({ ...evidence, id: "e2", summary: "duplicate" })).toEqual(evidence);
    expect(repo.listEvidence("topic-a", "ns-b")).toEqual([]);
    const candidate: ProjectTopicCandidateRecord = { id: "c1", topicId: "topic-a", namespaceId: "ns-a", title: "candidate", conclusion: "conclusion", proposedLayer: "L2", status: "pending", version: 1, sourceMemoryIds: [], metadata: {}, createdAt: NOW, updatedAt: NOW };
    repo.insertCandidate(candidate);
    const replacement = { ...candidate, id: "c2", supersedesId: "c1", title: "replacement" };
    repo.insertCandidate(replacement); expect(repo.listCandidates("topic-a", "ns-a").find((c) => c.id === "c1")?.status).toBe("superseded");
  }));
  it("is idempotent per namespace and input hash", () => withRepo((repo) => {
    const run = { id: "run-1", namespaceId: "ns-a", inputHash: "hash", status: "completed", result: { ok: true }, createdAt: NOW, updatedAt: NOW };
    expect(repo.recordAnalysisRun(run)).toEqual(run); expect(repo.recordAnalysisRun({ ...run, id: "run-2", result: { ok: false } })).toEqual(run);
    expect(repo.findAnalysisRun("ns-b", "hash")).toBeUndefined();
  }));
});
