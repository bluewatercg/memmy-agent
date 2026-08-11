import { afterEach, describe, expect, it } from "vitest";
import { evaluateTopicAutoApproval } from "../../../src/service/topic-inbox/auto-approval-policy.js";
import { evolutionJobDedupeKey } from "../../../src/service/worker/job-handlers.js";
import { Repositories, type MemoryRow } from "../../../src/index.js";
import type { TopicCandidateAnalysis } from "../../../src/service/topic-inbox/topic-inbox-types.js";
import { createFailingLlm, createMemoryServiceFixture } from "../../fixtures/memory-service-fixture.js";

const fixture = createMemoryServiceFixture();
afterEach(fixture.cleanup);

const eligible: TopicCandidateAnalysis = {
  title: "Verified formatting practice",
  conclusion: "Run the focused formatter check after changes.",
  proposedLayer: "L2", risk: "low", confidence: "high", verificationStatus: "verified",
  verificationEvidence: "model says passed", sourceEvidenceIds: ["trace_verified"], conflicts: [], sensitiveCategories: []
};

function evidence(value = "formatter check completed", overrides: Partial<MemoryRow> = {}): MemoryRow {
  return {
    id: "trace_verified", timeline: "2026-08-11T00:00:00.000Z", userId: "u", memoryType: "LongTermMemory",
    status: "activated", visibility: "private", memoryValue: value, tags: ["formatter"], info: { verification_status: "verified", verification_passed: true },
    properties: { internal_info: { memory_layer: "L1", memory_kind: "trace", trace: { summary: value, tool_calls: [{ name: "npm-test", success: true, output: "1 passed" }] } } },
    memoryLayer: "L1", version: 1, createdAt: "2026-08-11T00:00:00.000Z", updatedAt: "2026-08-11T00:00:00.000Z", ...overrides
  };
}

describe("project topic worker policy", () => {
  it.each([
    ["eligible", eligible, [evidence()], true],
    ["L3", { ...eligible, proposedLayer: "L3" as const }, [evidence()], false],
    ["risk", { ...eligible, risk: "medium" as const }, [evidence()], false],
    ["confidence", { ...eligible, confidence: "medium" as const }, [evidence()], false],
    ["uncited", { ...eligible, sourceEvidenceIds: [] }, [evidence()], false],
    ["unverified", { ...eligible, verificationStatus: "unverified" as const }, [evidence()], false],
    ["verification failed", { ...eligible, verificationStatus: "failed" as const }, [evidence()], false],
    ["failed", eligible, [evidence("formatter check did not pass")], false],
    ["migration", eligible, [evidence("migration check passed")], false],
    ["conflict", { ...eligible, conflicts: ["contradiction"] }, [evidence()], false],
    ["sensitive", { ...eligible, sensitiveCategories: ["credential"] }, [evidence()], false]
  ])("enforces %s boundary", (_name, candidate, source, approved) => {
    expect(evaluateTopicAutoApproval(candidate, source).approved).toBe(approved);
  });

  it("builds stable content and namespace cursor dedupe keys", () => {
    expect(evolutionJobDedupeKey({ jobType: "topic_ingest", targetMemoryId: "trace_1", payload: { contentHash: "abc" } })).toBe("topic_ingest:trace_1:abc");
    expect(evolutionJobDedupeKey({ jobType: "topic_refresh", payload: { namespaceId: "local:project", evidenceCursor: "cursor" } })).toBe("topic_refresh:local:project:cursor");
  });

  it.each(["topic_ingest", "topic_refresh"] as const)("persists %s retries across restart and eventually dead-letters", async (jobType) => {
    const llm = createFailingLlm();
    const { db, service } = fixture.createTestService({ llm });
    const repos = new Repositories(db.db);
    let targetMemoryId: string | undefined;
    if (jobType === "topic_ingest") {
      targetMemoryId = service.addMemory({
        namespace: { source: "codex", profileId: "p", userId: "topic-worker-user", projectId: "worker-project" },
        adapterId: "test",
        requestId: "worker-ingest-failure",
        layer: "L1",
        source: "codex",
        title: "topic ingest failure",
        content: "## user\n\nAnalyze this topic.\n\n## assistant\n\nAnalysis must retry on failure.",
        turnId: "worker-ingest-failure"
      }).id;
      db.db.prepare("DELETE FROM evolution_jobs").run();
      db.db.prepare("DELETE FROM memory_processing_state").run();
    }
    const at = new Date(Date.now() - 60_000).toISOString();
    const job = repos.runtime.enqueueJob({
      id: `job-${jobType}`,
      jobType,
      status: "queued",
      userId: "topic-worker-user",
      targetMemoryId,
      payload: {},
      attempts: 0,
      maxAttempts: 2,
      createdAt: at,
      updatedAt: at
    });

    const first = await service.runWorkerOnce(1);
    expect(first.jobs).toEqual([
      expect.objectContaining({ jobId: job.id, jobType, status: "failed" })
    ]);
    expect(repos.runtime.getJob(job.id)).toMatchObject({ status: "failed", attempts: 1 });

    const restarted = fixture.createTestMemoryService({ db, mode: "dev", llm });
    expect(restarted.reconcileWorkerStartup()).toMatchObject({ requeuedJobs: 1 });
    expect(repos.runtime.getJob(job.id)).toMatchObject({ status: "queued", attempts: 1 });

    const second = await restarted.runWorkerOnce(1);
    expect(second.jobs).toEqual([
      expect.objectContaining({ jobId: job.id, jobType, status: "dead_letter" })
    ]);
    expect(repos.runtime.getJob(job.id)).toMatchObject({ status: "dead_letter", attempts: 2 });
    expect(db.db.prepare(
      "SELECT op FROM memory_change_log WHERE entity_id = ? ORDER BY seq ASC"
    ).all(job.id)).toEqual([
      { op: "leased" },
      { op: "failed" },
      { op: "queued" },
      { op: "leased" },
      { op: "dead_letter" }
    ]);

    db.close();
  });
});
