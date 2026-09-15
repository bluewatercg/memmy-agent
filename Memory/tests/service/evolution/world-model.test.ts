import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { DEFAULT_MEMMY_CONFIG, MemoryDb } from "../../../src/index.js";
import { Repositories } from "../../../src/storage/repositories.js";
import { createMemoryServiceFixture } from "../../fixtures/memory-service-fixture.js";
import {
  insertActivePolicyMemory,
  makeTraceEligibleForL2,
  setPolicySignatureAndVectorForTest
} from "../../fixtures/evolution-fixture.js";
import { createCapturingL2Llm } from "./evolution-llm-stubs.js";

const {
  cleanup: cleanupMemoryServiceFixture,
  createTestMemoryService,
  createTestRoot,
  createTestService
} = createMemoryServiceFixture();

afterEach(() => {
  cleanupMemoryServiceFixture();
});

describe("MemoryService / evolution / legacy world model", () => {
  it("does not generate policy-derived legacy L3 records after schema v6", async () => {
    const { db, service } = createTestService();
    insertActivePolicyMemory(db, {
      id: "policy_no_legacy_world_model",
      userId: "world-model-user",
      sessionId: "world-model-session",
      agentId: "codex",
      appId: "world-model-workspace",
      profileId: "default",
      sourceTraceId: "trace_world_model",
      sourceEpisodeId: "episode_world_model"
    });
    const repos = new Repositories(db.db);
    const at = new Date().toISOString();
    const job = repos.runtime.enqueueJob({
      id: "job_legacy_l3_noop",
      jobType: "l3_abstraction",
      status: "queued",
      userId: "world-model-user",
      payload: {
        targetKind: "policy_cluster",
        seedPolicyId: "policy_no_legacy_world_model",
        policyIds: ["policy_no_legacy_world_model"]
      },
      attempts: 0,
      maxAttempts: 1,
      createdAt: at,
      updatedAt: at
    });

    await service.runWorkerOnce(10);

    expect(repos.runtime.getJob(job.id)?.status).toBe("succeeded");
    expect(db.db.prepare(
      `SELECT COUNT(*) AS count FROM memories WHERE memory_layer = 'L3'`
    ).get()).toEqual({ count: 0 });

  it("skips L3 abstraction when the policy cluster has no centroid vector like the plugin", async () => {
    const { db, service } = createTestService({ skillLlm: createCapturingL2Llm([]) });
    const session = service.openSession({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "user-l3-no-centroid"
      },
      workspaceId: "workspace-l3-no-centroid"
    });
    const complete = service.completeTurn("turn-l3-no-centroid", {
      sessionId: session.sessionId,
      episodeId: "episode-l3-no-centroid",
      query: "python pytest l3 cluster without vectors",
      answer: "Run pytest, inspect the failure, retry after fixing issue, then verify the result."
    });
    insertActivePolicyMemory(db, {
      id: "policy_l3_no_centroid",
      userId: "user-l3-no-centroid",
      sessionId: session.sessionId,
      agentId: "codex",
      appId: "workspace-l3-no-centroid",
      profileId: "jiang",
      sourceTraceId: complete.l1MemoryId,
      sourceEpisodeId: complete.episodeId
    });
    setPolicySignatureAndVectorForTest(db, "policy_l3_no_centroid", "python|pytest|_|_", null);
    db.db.prepare(`UPDATE evolution_jobs SET status = 'succeeded'`).run();
    const at = new Date().toISOString();
    db.db.prepare(
      `INSERT INTO evolution_jobs (
         id, job_type, status, user_id, session_id, episode_id, target_memory_id,
         payload_json, attempts, max_attempts, created_at, updated_at
       ) VALUES (?, 'l3_abstraction', 'queued', ?, ?, ?, ?, '{}', 0, 3, ?, ?)`
    ).run(
      "job_l3_no_centroid",
      "user-l3-no-centroid",
      session.sessionId,
      complete.episodeId,
      "policy_l3_no_centroid",
      at,
      at
    );

    await service.runWorkerOnce(20);

    const worldCount = db.db.prepare(
      `SELECT COUNT(*) AS count
       FROM memories
       WHERE user_id = 'user-l3-no-centroid'
         AND memory_layer = 'L3'`
    ).get() as { count: number };
    expect(worldCount.count).toBe(0);
    const skipped = db.db.prepare(
      `SELECT after_json
       FROM memory_change_log
       WHERE user_id = 'user-l3-no-centroid'
         AND kind = 'world_model'
         AND op = 'skipped'
         AND change_type = 'l3_abstraction_skipped'
       ORDER BY seq DESC
       LIMIT 1`
    ).get() as { after_json: string } | undefined;
    expect(JSON.parse(skipped!.after_json)).toMatchObject({
      policyIds: ["policy_l3_no_centroid"],
      reason: "no_centroid"
    });

    db.close();
  });

  it("creates a fresh L3 world model instead of reviving an archived one with the same key", async () => {
    const { db, service } = createTestService({ skillLlm: createCapturingL2Llm([]) });
    const session = service.openSession({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "user-archived-l3-recreate"
      },
      workspaceId: "workspace-archived-l3-recreate"
    });
    const complete = service.completeTurn("turn-archived-l3-recreate", {
      sessionId: session.sessionId,
      episodeId: "episode-archived-l3-recreate",
      query: "python pytest l3 archived world model recreate",
      answer: "Run pytest, inspect the failure, retry after fixing issue, then verify the result."
    });
    insertActivePolicyMemory(db, {
      id: "policy_archived_l3_recreate",
      userId: "user-archived-l3-recreate",
      sessionId: session.sessionId,
      agentId: "codex",
      appId: "workspace-archived-l3-recreate",
      profileId: "jiang",
      sourceTraceId: complete.l1MemoryId,
      sourceEpisodeId: complete.episodeId
    });
    db.db.prepare(`UPDATE evolution_jobs SET status = 'succeeded'`).run();
    const firstAt = new Date().toISOString();
    db.db.prepare(
      `INSERT INTO evolution_jobs (
         id, job_type, status, user_id, session_id, episode_id, target_memory_id,
         payload_json, attempts, max_attempts, created_at, updated_at
       ) VALUES (?, 'l3_abstraction', 'queued', ?, ?, ?, ?, '{}', 0, 3, ?, ?)`
    ).run(
      "job_archived_l3_create",
      "user-archived-l3-recreate",
      session.sessionId,
      complete.episodeId,
      "policy_archived_l3_recreate",
      firstAt,
      firstAt
    );
    await service.runWorkerOnce(20);

    const firstWorld = db.db.prepare(
      `SELECT id, memory_key
       FROM memories
       WHERE user_id = 'user-archived-l3-recreate'
         AND memory_layer = 'L3'
       LIMIT 1`
    ).get() as { id: string; memory_key: string } | undefined;
    expect(firstWorld).toBeTruthy();
    service.archiveMemory(firstWorld!.id, {
      reason: "replace with a fresh world model"
    });
    const archivedWorld = db.db.prepare(
      `SELECT status, updated_at
       FROM memories
       WHERE id = ?`
    ).get(firstWorld!.id) as { status: string; updated_at: string };
    expect(archivedWorld.status).toBe("archived");

    db.db.prepare(`UPDATE evolution_jobs SET status = 'succeeded'`).run();
    const secondAt = new Date().toISOString();
    db.db.prepare(
      `INSERT INTO evolution_jobs (
         id, job_type, status, user_id, session_id, episode_id, target_memory_id,
         payload_json, attempts, max_attempts, created_at, updated_at
       ) VALUES (?, 'l3_abstraction', 'queued', ?, ?, ?, ?, '{}', 0, 3, ?, ?)`
    ).run(
      "job_archived_l3_recreate",
      "user-archived-l3-recreate",
      session.sessionId,
      complete.episodeId,
      "policy_archived_l3_recreate",
      secondAt,
      secondAt
    );
    await service.runWorkerOnce(20);

    const worlds = db.db.prepare(
      `SELECT id, status, memory_key, updated_at
       FROM memories
       WHERE user_id = 'user-archived-l3-recreate'
         AND memory_layer = 'L3'
       ORDER BY created_at ASC`
    ).all() as Array<{ id: string; status: string; memory_key: string; updated_at: string }>;
    expect(worlds).toHaveLength(2);
    const archived = worlds.find((world) => world.id === firstWorld!.id);
    const fresh = worlds.find((world) => world.id !== firstWorld!.id);
    expect(archived).toMatchObject({
      status: "archived",
      memory_key: firstWorld!.memory_key,
      updated_at: archivedWorld.updated_at
    });
    expect(fresh).toMatchObject({
      status: "resolving",
      memory_key: firstWorld!.memory_key
    });

    db.close();
  });

  it("skips L3 abstraction when configured LLM returns an invalid draft", async () => {
    const root = createTestRoot("mindock-memory-");
    const db = new MemoryDb({
      path: join(root, "memory.sqlite")
    });
    const calls: Array<{
      messages: Array<{ role: string; content: string }>;
      options: { operation: string };
    }> = [];
    const userId = "user-invalid-l3-draft";
    const service = createTestMemoryService({
      db,
      mode: "dev",
      skillLlm: createCapturingL2Llm(calls, undefined, undefined, {
        title: "Invalid world model"
      }),
      config: {
        ...DEFAULT_MEMMY_CONFIG,
        algorithm: {
          ...DEFAULT_MEMMY_CONFIG.algorithm,
          capture: {
            ...DEFAULT_MEMMY_CONFIG.algorithm.capture,
            synthReflection: false,
            embedAfterCapture: false
          },
          l2Induction: {
            ...DEFAULT_MEMMY_CONFIG.algorithm.l2Induction,
            traceCharCap: 700
          },
          l3Abstraction: {
            ...DEFAULT_MEMMY_CONFIG.algorithm.l3Abstraction,
            useLlm: true,
            minPolicies: 1,
            minPolicySupport: 1,
            minPolicyGain: 0.01
          },
          skill: {
            ...DEFAULT_MEMMY_CONFIG.algorithm.skill,
            useLlm: false
          }
        }
      }
    });
    const session = service.openSession({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId
      }
    });
    const complete = service.completeTurn("turn-invalid-l3-draft", {
      sessionId: session.sessionId,
      episodeId: "episode-invalid-l3-draft",
      query: "pytest sqlite migration workflow needs focused diagnostics",
      answer: "Run focused tests, inspect migration output, then retry the exact failure.",
      toolCalls: [{
        name: "shell",
        input: { cmd: "npm test -- migration" },
        output: "ok",
        success: true
      }]
    });
    await service.feedback({
      sessionId: session.sessionId,
      l1MemoryId: complete.l1MemoryId,
      channel: "explicit",
      polarity: "positive",
      magnitude: 1,
      rationale: "the focused pytest migration workflow worked"
    });
    makeTraceEligibleForL2(db, complete.l1MemoryId);
    insertActivePolicyMemory(db, {
      id: "policy_invalid_l3_draft",
      userId,
      sessionId: session.sessionId,
      agentId: "codex",
      appId: "",
      profileId: "jiang",
      sourceTraceId: complete.l1MemoryId,
      sourceEpisodeId: complete.episodeId
    });
    db.db.prepare(`UPDATE evolution_jobs SET status = 'succeeded'`).run();
    const at = new Date().toISOString();
    db.db.prepare(
      `INSERT INTO evolution_jobs (
         id, job_type, status, user_id, session_id, episode_id, target_memory_id,
         payload_json, attempts, max_attempts, created_at, updated_at
       ) VALUES (?, 'l3_abstraction', 'queued', ?, ?, ?, ?, '{}', 0, 3, ?, ?)`
    ).run(
      "job_invalid_l3_draft",
      userId,
      session.sessionId,
      complete.episodeId,
      "policy_invalid_l3_draft",
      at,
      at
    );
    for (let i = 0; i < 20; i += 1) {
      await service.runWorkerOnce(100);
      if (calls.some((call) => call.options.operation === "l3.abstraction.v2")) {
        break;
      }
    }

    expect(calls.some((call) => call.options.operation === "l3.abstraction.v2")).toBe(true);
    const l3Count = db.db.prepare(
      `SELECT COUNT(*) AS count
       FROM memories
       WHERE user_id = ? AND memory_layer = 'L3'`
    ).get(userId) as { count: number };
    expect(l3Count.count).toBe(0);
    const skippedRows = db.db.prepare(
      `SELECT after_json
       FROM memory_change_log
       WHERE user_id = ?
         AND kind = 'world_model'
         AND op = 'skipped'
         AND change_type = 'l3_abstraction_skipped'
       ORDER BY seq DESC`
    ).all(userId) as Array<{ after_json: string }>;
    const skippedReasons = skippedRows.map((row) => {
      const after = JSON.parse(row.after_json) as { reason?: string };
      return after.reason;
    });
    expect(skippedReasons).toContain("llm-failed: l3.abstraction.invalid: missing environment");

    db.close();
  });
});
});
