import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryDb } from "../../src/storage/db.js";
import { ProjectTopicRepository, Repositories } from "../../src/storage/repositories.js";
import type { ProjectTopicCandidateRecord, ProjectTopicEvidenceRecord, ProjectTopicRecord } from "../../src/types.js";

const NOW = "2026-08-11T00:00:00.000Z";

function topic(namespaceId: string, id: string): ProjectTopicRecord {
  return { id, namespaceId, title: id, summary: "summary", status: "active", version: 1, sourceMemoryIds: [], metadata: {}, createdAt: NOW, updatedAt: NOW };
}

function candidate(topicId: string, id: string, overrides: Partial<ProjectTopicCandidateRecord> = {}): ProjectTopicCandidateRecord {
  return { id, topicId, namespaceId: "local:project-a", title: id, conclusion: "conclusion", proposedLayer: "L2", status: "pending", version: 1, sourceMemoryIds: [], metadata: {}, createdAt: NOW, updatedAt: NOW, ...overrides };
}

function insertMemory(db: MemoryDb["db"], id: string, projectId: string, layer: "L1" | "L2"): void {
  db.prepare(`INSERT INTO memories (id, timeline, user_id, agent_id, app_id, memory_value, info_json, properties_json, memory_layer, created_at, updated_at) VALUES (?, ?, 'user', 'codex', ?, 'value', ?, '{}', ?, ?, ?)`)
    .run(id, NOW, projectId, JSON.stringify({ project_id: projectId }), layer, NOW, NOW);
}

function withRepo<T>(run: (repo: ProjectTopicRepository, db: MemoryDb) => T): T {
  const root = mkdtempSync(join(tmpdir(), "project-topic-repository-"));
  const db = new MemoryDb({ path: join(root, "memory.sqlite") });
  try {
    return run(new Repositories(db.db).topics, db);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}

describe("project topic repository", () => {
  it("persists topics with namespace filtering and monotonic optimistic updates", () => withRepo((repo) => {
    const first = topic("local:project-a", "topic-a");
    repo.insertTopic(first);
    repo.insertTopic(topic("local:project-b", "topic-b"));
    expect(repo.getTopic("topic-a", "local:project-b")).toBeUndefined();
    expect(repo.listTopics("local:project-a")).toEqual([first]);
    const updated = { ...first, title: "updated", version: 2, updatedAt: "2026-08-11T01:00:00.000Z" };
    expect(repo.updateTopic(updated, 1)).toEqual(updated);
    expect(() => repo.updateTopic({ ...updated, version: 4 }, 2)).toThrow(/advance by one/);
    expect(() => repo.updateTopic({ ...updated, version: 2 }, 1)).toThrow(/version conflict/);
  }));

  it("accepts only same-namespace L1 evidence and deduplicates atomically", () => withRepo((repo, db) => {
    repo.insertTopic(topic("local:project-a", "topic-a"));
    insertMemory(db.db, "l1-a", "project-a", "L1");
    insertMemory(db.db, "l1-b", "project-b", "L1");
    insertMemory(db.db, "l2-a", "project-a", "L2");
    const evidence: ProjectTopicEvidenceRecord = { id: "e1", topicId: "topic-a", namespaceId: "local:project-a", memoryId: "l1-a", role: "source", summary: "evidence", metadata: {}, createdAt: NOW };
    expect(repo.attachEvidence(evidence)).toEqual(evidence);
    expect(repo.attachEvidence({ ...evidence, id: "e2", summary: "duplicate" })).toEqual(evidence);
    expect(() => repo.attachEvidence({ ...evidence, id: "missing", memoryId: "missing" })).toThrow(/L1 memory/);
    expect(() => repo.attachEvidence({ ...evidence, id: "wrong-ns", memoryId: "l1-b" })).toThrow(/namespace mismatch/);
    expect(() => repo.attachEvidence({ ...evidence, id: "not-l1", memoryId: "l2-a" })).toThrow(/L1 memory/);
  }));

  it("supersedes only a candidate from the same topic and keeps insertion atomic", () => withRepo((repo) => {
    repo.insertTopic(topic("local:project-a", "topic-a"));
    repo.insertTopic(topic("local:project-a", "topic-b"));
    repo.insertCandidate(candidate("topic-a", "c1"));
    repo.insertCandidate(candidate("topic-b", "c-other"));
    expect(() => repo.insertCandidate(candidate("topic-a", "invalid", { supersedesId: "c-other" }))).toThrow(/predecessor mismatch/);
    expect(repo.listCandidates("topic-a", "local:project-a").map((item) => item.id)).toEqual(["c1"]);
    repo.insertCandidate(candidate("topic-a", "c2", { supersedesId: "c1" }));
    expect(repo.listCandidates("topic-a", "local:project-a").find((item) => item.id === "c1")?.status).toBe("superseded");
  }));

  it("requires monotonic candidate versions", () => withRepo((repo) => {
    repo.insertTopic(topic("local:project-a", "topic-a"));
    const first = repo.insertCandidate(candidate("topic-a", "c1"));
    expect(() => repo.updateCandidate({ ...first, version: 3 }, 1)).toThrow(/advance by one/);
    expect(repo.updateCandidate({ ...first, version: 2, title: "updated" }, 1).version).toBe(2);
    expect(() => repo.updateCandidate({ ...first, version: 2 }, 1)).toThrow(/version conflict/);
  }));

  it("records analysis runs with atomic namespace and input-hash idempotency", () => withRepo((repo) => {
    const run = { id: "run-1", namespaceId: "local:project-a", inputHash: "hash", status: "completed", result: { ok: true }, createdAt: NOW, updatedAt: NOW };
    expect(repo.recordAnalysisRun(run)).toEqual(run);
    expect(repo.recordAnalysisRun({ ...run, id: "run-2", result: { ok: false } })).toEqual(run);
    expect(repo.findAnalysisRun("local:project-b", "hash")).toBeUndefined();
  }));
});
