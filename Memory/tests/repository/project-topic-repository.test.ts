import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { MemoryDb } from "../../src/storage/db.js";
import { ProjectTopicRepository, Repositories } from "../../src/storage/repositories.js";
import type { ProjectTopicCandidateRecord, ProjectTopicEvidenceRecord, ProjectTopicRecord } from "../../src/types.js";

const NOW = "2026-08-11T00:00:00.000Z";
const WORKER_TIMEOUT_MS = 15_000;

function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    // Worker deadlocks block real threads, so fake timers cannot bound these integration waits.
    const timeout = setTimeout(() => reject(new Error(`${label} timed out after ${WORKER_TIMEOUT_MS}ms`)), WORKER_TIMEOUT_MS);
    promise.then(
      (value) => { clearTimeout(timeout); resolve(value); },
      (error) => { clearTimeout(timeout); reject(error); }
    );
  });
}

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

  it("reclaims expired analysis claims and rejects stale owner completion", () => withRepo((repo) => {
    expect(repo.claimAnalysisRun({ id: "run-lease", namespaceId: "local:project-a", inputHash: "lease-hash", owner: "owner-a", at: NOW, leaseUntil: "2026-08-11T00:01:00.000Z" })).toBe(true);
    expect(repo.claimAnalysisRun({ id: "run-other", namespaceId: "local:project-a", inputHash: "lease-hash", owner: "owner-b", at: "2026-08-11T00:00:30.000Z", leaseUntil: "2026-08-11T00:02:00.000Z" })).toBe(false);
    expect(repo.claimAnalysisRun({ id: "run-other", namespaceId: "local:project-a", inputHash: "lease-hash", owner: "owner-b", at: "2026-08-11T00:01:00.000Z", leaseUntil: "2026-08-11T00:02:00.000Z" })).toBe(true);
    expect(repo.completeAnalysisRun({ namespaceId: "local:project-a", inputHash: "lease-hash", owner: "owner-a", status: "succeeded", result: {}, at: "2026-08-11T00:01:01.000Z" })).toBe(false);
    expect(repo.completeAnalysisRun({ namespaceId: "local:project-a", inputHash: "lease-hash", owner: "owner-b", status: "succeeded", result: { ok: true }, at: "2026-08-11T00:01:01.000Z" })).toBe(true);
  }));
  it("reclaims legacy claimed analysis rows without a lease", () => withRepo((repo, db) => {
    db.db.prepare(`INSERT INTO project_topic_analysis_runs
      (id, namespace_id, input_hash, status, owner, lease_until, result_json, created_at, updated_at)
      VALUES (?, ?, ?, 'claimed', NULL, NULL, '{}', ?, ?)`)
      .run("legacy-claim", "local:project-a", "legacy-hash", NOW, NOW);

    expect(repo.claimAnalysisRun({
      id: "replacement-id",
      namespaceId: "local:project-a",
      inputHash: "legacy-hash",
      owner: "recovery-owner",
      at: "2026-08-11T00:02:00.000Z",
      leaseUntil: "2026-08-11T00:03:00.000Z"
    })).toBe(true);
    expect(repo.findAnalysisRun("local:project-a", "legacy-hash")).toMatchObject({
      id: "legacy-claim",
      status: "claimed",
      result: {}
    });
  }));


  it("converges genuinely competing writers on one canonical analysis run", async () => {
    const root = mkdtempSync(join(tmpdir(), "project-topic-analysis-race-"));
    const path = join(root, "memory.sqlite");
    const setupDb = new MemoryDb({ path });
    setupDb.close();
    const rounds = 64;
    const barrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 4);
    const barrierState = new Int32Array(barrier);
    const workerUrl = new URL("./project-topic-analysis-writer.mjs", import.meta.url);
    type AnalysisRunResult = { id: string; inputHash: string };
    type Writer = { worker: Worker; ready: Promise<void>; results: Promise<AnalysisRunResult[]>; exit: Promise<void> };
    const workers: Writer[] = [];
    const runWriter = (writerId: string): Writer => {
      let markReady!: () => void;
      let resolveResults!: (value: AnalysisRunResult[]) => void;
      let rejectReady!: (reason: unknown) => void;
      let rejectResults!: (reason: unknown) => void;
      // Promise executors are required here because this package targets ES2022, before Promise.withResolvers.
      const readySignal = new Promise<void>((resolve, reject) => { markReady = resolve; rejectReady = reject; });
      const resultSignal = new Promise<AnalysisRunResult[]>((resolve, reject) => { resolveResults = resolve; rejectResults = reject; });
      const worker = new Worker(workerUrl, { execArgv: ["--import", "tsx"], workerData: { barrier, now: NOW, path, rounds, writer: writerId } });
      let receivedResults = false;
      const exitSignal = new Promise<void>((resolve, reject) => {
        worker.once("exit", (code) => {
          const error = code === 0
            ? new Error(`analysis writer ${writerId} exited before completing`)
            : new Error(`analysis writer ${writerId} exited with code ${code}`);
          rejectReady(error);
          if (!receivedResults) rejectResults(error);
          if (code === 0) resolve();
          else reject(error);
        });
      });
      worker.on("message", (message: { error?: string; ready?: boolean; results?: AnalysisRunResult[] }) => {
        if (message.ready) markReady();
        else if (message.error) rejectResults(new Error(message.error));
        else {
          receivedResults = true;
          resolveResults(message.results ?? []);
        }
      });
      worker.once("error", (error) => { rejectReady(error); rejectResults(error); });
      const writer = {
        worker,
        ready: bounded(readySignal, `analysis writer ${writerId} ready`),
        results: bounded(resultSignal, `analysis writer ${writerId} result`),
        exit: bounded(exitSignal, `analysis writer ${writerId} exit`)
      };
      void writer.ready.catch(() => undefined);
      void writer.results.catch(() => undefined);
      void writer.exit.catch(() => undefined);
      workers.push(writer);
      return writer;
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
      Atomics.store(barrierState, 3, 1);
      Atomics.notify(barrierState, 1);
      Atomics.notify(barrierState, 2);
      const exits = workers.map(({ exit }) => exit.catch(() => undefined));
      await bounded(Promise.all(workers.map(({ worker }) => worker.terminate())), "analysis writer termination");
      await bounded(Promise.all(exits), "analysis writer exit cleanup");
      rmSync(root, { recursive: true, force: true });
    }
  });
});
