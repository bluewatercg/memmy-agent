import Database from "better-sqlite3";
import { parentPort, workerData } from "node:worker_threads";
import { ProjectTopicRepository } from "../../src/storage/repositories.ts";

const barrier = new Int32Array(workerData.barrier);
const db = new Database(workerData.path);
db.pragma("foreign_keys = ON");
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");
const repository = new ProjectTopicRepository(db);
parentPort.postMessage({ ready: true });
if (Atomics.wait(barrier, 2, 0, 10_000) === "timed-out") {
  throw new Error("analysis writer start barrier timed out");
}
const results = [];

function rendezvous(round) {
  const phase = Atomics.load(barrier, 1);
  if (Atomics.add(barrier, 0, 1) === 1) {
    Atomics.store(barrier, 0, 0);
    Atomics.add(barrier, 1, 1);
    Atomics.notify(barrier, 1);
    return;
  }
  if (Atomics.wait(barrier, 1, phase, 10_000) === "timed-out") {
    throw new Error(`analysis writer barrier timed out in round ${round}`);
  }
}

try {
  for (let round = 0; round < workerData.rounds; round += 1) {
    rendezvous(round);
    const run = {
      id: `run-${workerData.writer}-${round}`,
      namespaceId: "local:project-a",
      inputHash: `shared-hash-${round}`,
      status: "completed",
      result: { writer: workerData.writer },
      createdAt: workerData.now,
      updatedAt: workerData.now
    };
    results.push(repository.recordAnalysisRun(run));
  }
  parentPort.postMessage({ results });
} catch (error) {
  parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) });
} finally {
  db.close();
}
