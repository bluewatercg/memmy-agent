import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
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
    insertMemory(db.db, "l1-second", "project-a", "L1");
    expect(() => repo.attachEvidence({ ...evidence, memoryId: "l1-second" })).toThrow();
  }));

  it("supersedes only a candidate from the same topic and keeps insertion atomic", () => withRepo((repo) => {
    repo.insertTopic(topic("local:project-a", "topic-a"));
    repo.insertTopic(topic("local:project-a", "topic-b"));
    repo.insertCandidate(candidate("topic-a", "c1"));
    repo.insertCandidate(candidate("topic-b", "c-other"));
    expect(() => repo.insertCandidate(candidate("topic-a", "invalid", { supersedesId: "c-other" }))).toThrow(/predecessor mismatch/);
    expect(repo.listCandidates("topic-a", "local:project-a").map((item) => item.id)).toEqual(["c1"]);
    repo.insertCandidate(candidate("topic-a", "collision"));
    expect(() => repo.insertCandidate(candidate("topic-a", "collision", { supersedesId: "c1" }))).toThrow();
    expect(repo.listCandidates("topic-a", "local:project-a").find((item) => item.id === "c1")?.status).toBe("pending");
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
    expect(() => repo.recordAnalysisRun({ ...run, namespaceId: "local:project-b", inputHash: "other" })).toThrow();
  }));

  it("converges genuinely competing writers on one canonical analysis run", async () => {
    const root = mkdtempSync(join(tmpdir(), "project-topic-analysis-race-"));
    const path = join(root, "memory.sqlite");
    const setupDb = new MemoryDb({ path });
    setupDb.close();
    const rounds = 32;
    const barrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 3);
    const barrierState = new Int32Array(barrier);
    const workerUrl = new URL("./project-topic-analysis-writer.mjs", import.meta.url);
    const runWriter = (writer: string): { ready: Promise<void>; results: Promise<Array<{ id: string; inputHash: string }>> } => {
      let markReady!: () => void;
      let resolveResults!: (value: Array<{ id: string; inputHash: string }>) => void;
      let rejectResults!: (reason: unknown) => void;
      // Promise executors are required here because this package targets ES2022, before Promise.withResolvers.
      const ready = new Promise<void>((resolve) => { markReady = resolve; });
      const results = new Promise<Array<{ id: string; inputHash: string }>>((resolve, reject) => { resolveResults = resolve; rejectResults = reject; });
      const worker = new Worker(workerUrl, { execArgv: ["--import", "tsx"], workerData: { barrier, now: NOW, path, rounds, writer } });
      worker.on("message", (message: { error?: string; ready?: boolean; results?: Array<{ id: string; inputHash: string }> }) => {
        if (message.ready) markReady();
        else if (message.error) rejectResults(new Error(message.error));
        else resolveResults(message.results ?? []);
      });
      worker.once("error", rejectResults);
      return { ready, results };
    };

    try {
      const firstWriter = runWriter("first");
      const secondWriter = runWriter("second");
      await Promise.all([firstWriter.ready, secondWriter.ready]);
      Atomics.store(barrierState, 2, 1);
      Atomics.notify(barrierState, 2, 2);
      const [firstResults, secondResults] = await Promise.all([firstWriter.results, secondWriter.results]);
      expect(firstResults).toHaveLength(rounds);
      expect(secondResults).toHaveLength(rounds);
      for (let round = 0; round < rounds; round += 1) {
        expect(secondResults[round]).toEqual(firstResults[round]);
      }
      const verificationDb = new MemoryDb({ path });
      try {
        expect(verificationDb.db.prepare(`SELECT COUNT(*) AS count FROM project_topic_analysis_runs WHERE namespace_id = ?`).get("local:project-a")).toEqual({ count: rounds });
      } finally {
        verificationDb.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
