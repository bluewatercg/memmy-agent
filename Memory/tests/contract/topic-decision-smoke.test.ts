
import { Repositories } from "../../src/storage/repositories.js";
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryHttpServer, DEFAULT_MEMMY_CONFIG } from "../../src/index.js";
import { nowIso } from "../../src/utils/time.js";
import { namespaceIdFromContext } from "../../src/service/namespace/namespace-scope.js";
import type { LlmClient, LlmCompletionOptions, LlmMessage } from "../../src/model/types.js";
import { createMemoryServiceFixture } from "../fixtures/memory-service-fixture.js";
const namespace = { source: "codex", profileId: "default", userId: "smoke-user", projectId: "smoke-project" };
const deterministicLlm: LlmClient = {
  config: { provider: "openai_compatible", model: "smoke-model", enableThinking: false, temperature: 0, timeoutMs: 1000, maxRetries: 0, malformedRetries: 0 },
  isConfigured: () => true,
  status: () => ({ provider: "openai_compatible", model: "smoke-model", configured: true, remote: false, lastOkAt: nowIso() }),
  complete: async () => "{}",
  completeJson: async <T extends Record<string, unknown>>() => ({ judgment: "unknown", confidence: 0.5, evidenceIds: [], facts: [{ claim: "Need an accountable owner", evidenceIds: [] }], assumptions: [], missingInformation: [{ key: "owner", question: "Who owns this decision?", blocking: true, decisionImpact: "Cannot approve without an owner" }], risks: [], counterarguments: [], suggestedActions: [] }) as unknown as T
};


async function openServer(service: Parameters<typeof createMemoryHttpServer>[0]["service"], fn: (base: string) => Promise<void>): Promise<void> {
  const server = createMemoryHttpServer({ service, auth: { scopedApiKeys: { smoke: { namespace, scopes: ["panel:read", "panel:write"] } } } });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected TCP address");
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("topic decision real-server smoke", () => {
  it("runs real start, roster, blocked evidence, readback, and stale branch", async () => {
    const fixture = createMemoryServiceFixture();
    const config = {
      ...DEFAULT_MEMMY_CONFIG,
      algorithm: {
        ...DEFAULT_MEMMY_CONFIG.algorithm,
        topicDecisions: { enabled: true, models: ["smoke-model"] }
      }
    };
    const { service, db } = fixture.createTestService({
      config,
      createLlmClient: () => deterministicLlm
    });
    const repos = new Repositories(db.db);
    const namespaceId = namespaceIdFromContext(namespace);
    const at = nowIso();
    repos.topics.insertTopic({ id: "smoke-topic", namespaceId, title: "Smoke topic", summary: "A deterministic topic", status: "active", version: 1, sourceMemoryIds: [], metadata: {}, createdAt: at, updatedAt: at });
    repos.topics.insertTopic({ id: "merge-target", namespaceId, title: "Merge target", summary: "A deterministic merge target", status: "active", version: 1, sourceMemoryIds: [], metadata: {}, createdAt: at, updatedAt: at });

    await openServer(service, async (base) => {
      const headers = { authorization: "Bearer smoke", "content-type": "application/json" };
      const post = (path: string, payload: Record<string, unknown>) => fetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(payload) });
      const start = await post("/api/v1/topic-inbox/topics/smoke-topic/decisions", { namespace, adapterId: "smoke", requestId: "start-1" });
      expect(start.status).toBe(200);
      const started = await start.json() as { session: { id: string; state: string }; snapshot: { payload: { evidenceIds: string[] } } };
      expect(started.session.state).toBe("draft");
      expect(started.snapshot.payload.evidenceIds).toEqual([]);
      const sessionId = started.session.id;

      const patch = await fetch(`${base}/api/v1/topic-inbox/decisions/${sessionId}/agents`, { method: "PATCH", headers, body: JSON.stringify({ namespace, expectedVersion: 1, agents: [{ id: "agent-1", role: "evidence_analyst", model: "smoke-model", reason: "deterministic" }], adapterId: "smoke", requestId: "agents-1" }) });
      expect(patch.status).toBe(200);

      for (const [route, requestId] of [
        ["run", "stale-run"],
        ["positions", "stale-positions"],
        ["debate", "stale-debate"],
        ["proposals", "stale-proposals"]
      ] as const) {
        const stale = await post(`/api/v1/topic-inbox/decisions/${sessionId}/${route}`, {
          namespace,
          expectedVersion: 1,
          adapterId: "smoke",
          requestId
        });
        if (stale.status !== 409) {
          const body = await stale.json();
          console.error(`Route ${route} returned ${stale.status}:`, JSON.stringify(body, null, 2));
        }
        expect(stale.status).toBe(409);
        const conflict = await stale.json() as {
          error: { code: string };
          details: { sessionId: string; currentVersion: number; currentState: string };
        };
        expect(conflict.error.code).toBe("conflict");
        expect(conflict.details).toEqual({
          sessionId,
          currentVersion: 2,
          currentState: "draft"
        });
      }

      const run = await post(`/api/v1/topic-inbox/decisions/${sessionId}/run`, { namespace, expectedVersion: 2, adapterId: "smoke", requestId: "run-1" });
      expect(run.status).toBe(200);

      const read = await fetch(`${base}/api/v1/topic-inbox/decisions/${sessionId}?namespace=${encodeURIComponent(JSON.stringify(namespace))}`, { headers });
      expect(read.status).toBe(200);
      const detail = await read.json() as { session: { id: string; state: string } };
      expect(detail.session.id).toBe(sessionId);
      expect(detail.session.state).toBe("blocked_by_evidence");

      const merge = await post("/api/v1/topic-inbox/topics/smoke-topic/merge", { namespace, targetTopicId: "merge-target", expectedVersion: 1, targetExpectedVersion: 1 });
      expect(merge.status, await merge.text()).toBe(200);
      const staleRead = await fetch(`${base}/api/v1/topic-inbox/decisions/${sessionId}?namespace=${encodeURIComponent(JSON.stringify(namespace))}`, { headers });
      expect(staleRead.status).toBe(200);
      const staleDetail = await staleRead.json() as { session: { state: string } };
      expect(staleDetail.session.state).toBe("stale");
    });
    db.close();
    fixture.cleanup();
  });

  it("preserves synthesized actions through proposal approval", async () => {
    const fixture = createMemoryServiceFixture();
    const lifecycleLlm: LlmClient = {
      ...deterministicLlm,
      completeJson: async <T extends Record<string, unknown>>(_messages: LlmMessage[], options: LlmCompletionOptions) => {
        if (options?.operation === "topic.decision.synthesize") {
          return {
            proposals: [{
              title: "Delete obsolete smoke topic",
              benefit: "Removes obsolete state",
              risk: "Deletion is irreversible",
              dependencies: [],
              reversible: false,
              rollbackPlan: "Restore from backup",
              verificationPlan: "Confirm the topic no longer exists",
              evidenceIds: [],
              effectClass: "delete",
              permission: "panel:write",
              artifact: "smoke-topic",
              acceptanceCondition: "Topic is absent",
              recoveryPoint: "backup:smoke-topic",
              agentContributions: ["agent-1"],
              recommended: true,
              actions: [{
                id: "delete-smoke-topic",
                effect: "delete",
                target: "smoke-topic",
                input: {},
                dependsOn: [],
                recoveryPoint: "backup:smoke-topic",
                acceptanceCondition: "Topic is absent"
              }]
            }]
          } as unknown as T;
        }
        return {
          judgment: "support",
          confidence: 0.9,
          evidenceIds: [],
          facts: [{ claim: "The topic is obsolete", evidenceIds: [] }],
          assumptions: [],
          missingInformation: [],
          risks: [{ severity: "high", description: "Deletion is irreversible" }],
          counterarguments: [],
          suggestedActions: ["Delete the topic"]
        } as unknown as T;
      }
    };
    const config = {
      ...DEFAULT_MEMMY_CONFIG,
      algorithm: {
        ...DEFAULT_MEMMY_CONFIG.algorithm,
        topicDecisions: { enabled: true, models: ["smoke-model"] }
      }
    };
    const { service, db } = fixture.createTestService({
      config,
      createLlmClient: () => lifecycleLlm
    });
    const repos = new Repositories(db.db);
    const namespaceId = namespaceIdFromContext(namespace);
    const at = nowIso();
    repos.topics.insertTopic({ id: "lifecycle-topic", namespaceId, title: "Lifecycle topic", summary: "Obsolete state", status: "active", version: 1, sourceMemoryIds: [], metadata: {}, createdAt: at, updatedAt: at });

    await openServer(service, async (base) => {
      const headers = { authorization: "Bearer smoke", "content-type": "application/json" };
      const post = (path: string, payload: Record<string, unknown>) => fetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(payload) });
      const mutation = (requestId: string) => ({ namespace, adapterId: "smoke", requestId });
      const startedResponse = await post("/api/v1/topic-inbox/topics/lifecycle-topic/decisions", {
        ...mutation("lifecycle-start"),
        agents: [{ id: "agent-1", role: "evidence_analyst", model: "smoke-model", reason: "deterministic" }]
      });
      expect(startedResponse.status, await startedResponse.clone().text()).toBe(200);
      const started = await startedResponse.json() as { session: { id: string } };
      const sessionId = started.session.id;

      expect((await post(`/api/v1/topic-inbox/decisions/${sessionId}/positions`, mutation("lifecycle-positions"))).status).toBe(200);
      expect((await post(`/api/v1/topic-inbox/decisions/${sessionId}/debate`, mutation("lifecycle-debate"))).status).toBe(200);
      expect((await post(`/api/v1/topic-inbox/decisions/${sessionId}/proposals`, mutation("lifecycle-proposals"))).status).toBe(200);

      const detailResponse = await fetch(`${base}/api/v1/topic-inbox/decisions/${sessionId}?namespace=${encodeURIComponent(JSON.stringify(namespace))}`, { headers });
      expect(detailResponse.status).toBe(200);
      const detail = await detailResponse.json() as { proposals: Array<{ id: string; version: number }> };
      expect(detail.proposals).toHaveLength(1);
      const proposal = detail.proposals[0]!;

      const approvalResponse = await post(`/api/v1/topic-inbox/decisions/${sessionId}/proposals/${proposal.id}/approve`, {
        ...mutation("lifecycle-approve"),
        expectedProposalVersion: proposal.version
      });
      expect(approvalResponse.status, await approvalResponse.clone().text()).toBe(200);
      const run = await approvalResponse.json() as { status: string; result: { actions: Array<{ id: string; status: string }> } };
      expect(run.status).toBe("awaiting_confirmation");
      expect(run.result.actions).toEqual([{ id: "delete-smoke-topic", status: "awaiting_confirmation", output: {} }]);
    });
    db.close();
    fixture.cleanup();
  });

  it("advertises decision capabilities and aggregate metrics only when enabled", async () => {
    const fixture = createMemoryServiceFixture();
    const enabledConfig = {
      ...DEFAULT_MEMMY_CONFIG,
      algorithm: {
        ...DEFAULT_MEMMY_CONFIG.algorithm,
        topicDecisions: { enabled: true, models: ["smoke-model"] }
      }
    };
    const enabled = fixture.createTestService({ config: enabledConfig, createLlmClient: () => deterministicLlm });
    await openServer(enabled.service, async (base) => {
      const headers = { authorization: "Bearer smoke" };
      const health = await (await fetch(`${base}/api/v1/health`, { headers })).json() as { capabilities: { routes: string[]; topicDecisions?: { enabled: boolean; models: string[] } } };
      expect(health.capabilities.routes).toContain("POST /api/v1/topic-inbox/topics/:topicId/decisions");
      expect(health.capabilities.topicDecisions).toEqual({ enabled: true, models: ["smoke-model"] });
      const metrics = await (await fetch(`${base}/api/v1/panel/metrics`, { headers })).json() as { topicDecisions?: Record<string, number> };
      expect(metrics.topicDecisions).toEqual({ sessions: 0, snapshots: 0, positions: 0, evidenceQuestions: 0, proposalsApproved: 0, executionRuns: 0, totalDurationMs: 0 });
      const config = await (await fetch(`${base}/api/v1/panel/config`, { headers })).json();
      expect(JSON.stringify(config)).not.toContain("apiKey");
      expect(JSON.stringify(config)).toContain("smoke-model");
    });
    enabled.db.close();

    const disabled = fixture.createTestService({ topicDecisionEnabled: false });
    await openServer(disabled.service, async (base) => {
      const headers = { authorization: "Bearer smoke" };
      const health = await (await fetch(`${base}/api/v1/health`, { headers })).json() as { capabilities: { routes: string[]; topicDecisions?: unknown } };
      expect(health.capabilities.routes).not.toContain("POST /api/v1/topic-inbox/topics/:topicId/decisions");
      expect(health.capabilities.topicDecisions).toBeUndefined();
      const metrics = await (await fetch(`${base}/api/v1/panel/metrics`, { headers })).json() as { topicDecisions?: unknown };
      expect(metrics.topicDecisions).toBeUndefined();
    });
    disabled.db.close();
    fixture.cleanup();
  });
});
