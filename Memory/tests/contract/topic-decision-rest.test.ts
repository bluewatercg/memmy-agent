import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryHttpServer, API_ROUTES } from "../../src/index.js";
import { MemoryRestClient } from "../../src/client/rest-client.js";
import type { MemoryService } from "../../src/service/memory-service.js";
import { createMemoryServiceFixture, configWithMemoryGates } from "../fixtures/memory-service-fixture.js";

const { cleanup, createTestService } = createMemoryServiceFixture();

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

async function withServerClosed(
  server: ReturnType<typeof createMemoryHttpServer>,
  run: () => Promise<void>
): Promise<void> {
  try {
    await run();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("Topic Decision REST contract", () => {
  it("requires panel read for GET session, write for all mutations", async () => {
    const { db, service } = createTestService({ topicDecisionEnabled: true });
    const namespace = { source: "codex", profileId: "default", userId: "td-user", projectId: "td-project" };
    // Mock service methods for auth tests
    service.readTopicDecisionSession = () => ({
      session: { id: "session-1", namespaceId: "ns", topicId: "t1", inputHash: "h1", state: "draft", version: 1, metadata: {}, createdAt: "2026-08-12T00:00:00Z", updatedAt: "2026-08-12T00:00:00Z" },
      snapshots: []
    });
    service.startTopicDecisionSession = () => ({
      session: { id: "session-1", namespaceId: "ns", topicId: "t1", inputHash: "h1", state: "draft", version: 1, metadata: {}, createdAt: "2026-08-12T00:00:00Z", updatedAt: "2026-08-12T00:00:00Z" },
      snapshot: { id: "snap-1", namespaceId: "ns", sessionId: "session-1", round: 0, payload: { topicVersion: 1, evidenceIds: [], evidenceHashes: {}, evidenceContent: {}, projectConstraints: [], roster: [], inputHash: "h1" }, createdAt: "2026-08-12T00:00:00Z" },
      reused: false
    });
    const server = createMemoryHttpServer({
      service,
      auth: {
        scopedApiKeys: {
          "reader": { namespace, scopes: ["panel:read"] },
          "writer": { namespace, scopes: ["panel:write"] }
        }
      }
    });
    await withServerClosed(server, async () => {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("expected TCP address");
      const base = `http://127.0.0.1:${address.port}`;
      const headers = (token: string) => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

      // GET requires read
      const nsEncoded = encodeURIComponent(JSON.stringify(namespace));
      const readOk = await fetch(`${base}/api/v1/topic-inbox/decisions/session-1?namespace=${nsEncoded}`, {
        headers: headers("reader")
      });
      expect(readOk.status).toBe(200);

      // POST start requires write
      const startDenied = await fetch(`${base}/api/v1/topic-inbox/topics/topic-1/decisions`, {
        method: "POST",
        headers: headers("reader"),
        body: JSON.stringify({ namespace })
      });
      expect(startDenied.status).toBe(403);

      const startOk = await fetch(`${base}/api/v1/topic-inbox/topics/topic-1/decisions`, {
        method: "POST",
        headers: headers("writer"),
        body: JSON.stringify({ namespace, adapterId: "test", requestId: "req-auth-start" })
      });
      expect(startOk.status).toBe(200);

      // PATCH agents requires write
      const agentsDenied = await fetch(`${base}/api/v1/topic-inbox/decisions/session-1/agents`, {
        method: "PATCH",
        headers: headers("reader"),
        body: JSON.stringify({ namespace, agents: [], adapterId: "test", requestId: "req-auth-agents" })
      });
      expect(agentsDenied.status).toBe(403);

      // POST run requires write
      const runDenied = await fetch(`${base}/api/v1/topic-inbox/decisions/session-1/run`, {
        method: "POST",
        headers: headers("reader"),
        body: JSON.stringify({ namespace, adapterId: "test", requestId: "req-auth-run" })
      });
      expect(runDenied.status).toBe(403);

      // POST answers requires write
      const answersDenied = await fetch(`${base}/api/v1/topic-inbox/decisions/session-1/answers`, {
        method: "POST",
        headers: headers("reader"),
        body: JSON.stringify({ namespace, expectedVersion: 1, answers: [], adapterId: "test", requestId: "req-auth-answers" })
      });
      expect(answersDenied.status).toBe(403);

      // POST approve requires write
      const approveDenied = await fetch(`${base}/api/v1/topic-inbox/decisions/session-1/proposals/prop-1/approve`, {
        method: "POST",
        headers: headers("reader"),
        body: JSON.stringify({ namespace, expectedProposalVersion: 1, adapterId: "test", requestId: "req-auth-approve" })
      });
      expect(approveDenied.status).toBe(403);

      // POST resume requires write
      const resumeDenied = await fetch(`${base}/api/v1/topic-inbox/decisions/session-1/executions/run-1/resume`, {
        method: "POST",
        headers: headers("reader"),
        body: JSON.stringify({ namespace, adapterId: "test", requestId: "req-auth-resume" })
      });
      expect(resumeDenied.status).toBe(403);

      // POST confirm requires write
      const confirmDenied = await fetch(`${base}/api/v1/topic-inbox/decisions/session-1/executions/run-1/actions/action-1/confirm`, {
        method: "POST",
        headers: headers("reader"),
        body: JSON.stringify({ namespace, expectedRunVersion: 1, approved: true, idempotencyKey: "k1", adapterId: "test", requestId: "req-auth-confirm" })
      });
      expect(confirmDenied.status).toBe(403);

      // POST cancel requires write
      const cancelDenied = await fetch(`${base}/api/v1/topic-inbox/decisions/session-1/cancel`, {
        method: "POST",
        headers: headers("reader"),
        body: JSON.stringify({ namespace, adapterId: "test", requestId: "req-auth-cancel" })
      });
      expect(cancelDenied.status).toBe(403);
    });
    db.close();
  });

  it("enforces namespace scope on all decision endpoints", async () => {
    const { db, service } = createTestService({ topicDecisionEnabled: true });
    const namespace = { source: "codex", profileId: "default", userId: "td-user", projectId: "td-project" };
    const otherNamespace = { source: "codex", profileId: "default", userId: "other-user", projectId: "other-project" };
    const server = createMemoryHttpServer({
      service,
      auth: { scopedApiKeys: { "writer": { namespace, scopes: ["panel:write"] } } }
    });
    await withServerClosed(server, async () => {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("expected TCP address");
      const base = `http://127.0.0.1:${address.port}`;
      const headers = { authorization: "Bearer writer", "content-type": "application/json" };

      // Start with wrong namespace
      const startForbidden = await fetch(`${base}/api/v1/topic-inbox/topics/topic-1/decisions`, {
        method: "POST",
        headers,
        body: JSON.stringify({ namespace: otherNamespace })
      });
      expect(startForbidden.status).toBe(403);

      // Answers with wrong namespace
      const answersForbidden = await fetch(`${base}/api/v1/topic-inbox/decisions/session-1/answers`, {
        method: "POST",
        headers,
        body: JSON.stringify({ namespace: otherNamespace, expectedVersion: 1, answers: [] })
      });
      expect(answersForbidden.status).toBe(403);

      // Approve with wrong namespace
      const approveForbidden = await fetch(`${base}/api/v1/topic-inbox/decisions/session-1/proposals/prop-1/approve`, {
        method: "POST",
        headers,
        body: JSON.stringify({ namespace: otherNamespace, expectedProposalVersion: 1 })
      });
      expect(approveForbidden.status).toBe(403);
    });
    db.close();
  });

  it("rejects unknown fields, validates bounded strings/arrays", async () => {
    const { db, service } = createTestService({ topicDecisionEnabled: true });
    const namespace = { source: "codex", profileId: "default", userId: "td-user", projectId: "td-project" };
    const server = createMemoryHttpServer({
      service,
      auth: { scopedApiKeys: { "writer": { namespace, scopes: ["panel:write"] } } }
    });
    await withServerClosed(server, async () => {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("expected TCP address");
      const base = `http://127.0.0.1:${address.port}`;
      const headers = { authorization: "Bearer writer", "content-type": "application/json" };

      // Unknown field rejected
      const unknownField = await fetch(`${base}/api/v1/topic-inbox/topics/topic-1/decisions`, {
        method: "POST",
        headers,
        body: JSON.stringify({ namespace, unknownField: true })
      });
      expect(unknownField.status).toBe(400);

      // Agents array bounded
      const tooManyAgents = await fetch(`${base}/api/v1/topic-inbox/decisions/session-1/agents`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ namespace, agents: Array.from({ length: 20 }, (_, i) => ({ id: `a${i}`, role: "analyst", model: "gpt", reason: "r" })) })
      });
      expect(tooManyAgents.status).toBe(400);

      // Answer length bounded
      const longAnswer = await fetch(`${base}/api/v1/topic-inbox/decisions/session-1/answers`, {
        method: "POST",
        headers,
        body: JSON.stringify({ namespace, expectedVersion: 1, answers: [{ questionKey: "q1", answer: "x".repeat(10001), source: "user_preference" }] })
      });
      expect(longAnswer.status).toBe(400);

      // Answers array bounded
      const tooManyAnswers = await fetch(`${base}/api/v1/topic-inbox/decisions/session-1/answers`, {
        method: "POST",
        headers,
        body: JSON.stringify({ namespace, expectedVersion: 1, answers: Array.from({ length: 51 }, (_, i) => ({ questionKey: `q${i}`, answer: "a", source: "user_preference" as const })) })
      });
      expect(tooManyAnswers.status).toBe(400);
    });
    db.close();
  });

  it("maps disabled feature to 404, version conflict to 409 with details", async () => {
    const { db, service } = createTestService();
    const namespace = { source: "codex", profileId: "default", userId: "td-user", projectId: "td-project" };
    const server = createMemoryHttpServer({
      service,
      auth: { scopedApiKeys: { "writer": { namespace, scopes: ["panel:write"] } } }
    });
    await withServerClosed(server, async () => {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("expected TCP address");
      const base = `http://127.0.0.1:${address.port}`;
      const headers = { authorization: "Bearer writer", "content-type": "application/json" };

      // Disabled feature -> 404
      const disabledStart = await fetch(`${base}/api/v1/topic-inbox/topics/topic-1/decisions`, {
        method: "POST",
        headers,
        body: JSON.stringify({ namespace, adapterId: "test", requestId: "req-disabled" })
      });
      expect(disabledStart.status).toBe(404);
      const disabledBody = await disabledStart.json() as { error: { code: string } };
      expect(disabledBody.error.code).toBe("not_found");

      // Version conflict -> 409
      const conflictService = createTestService({ topicDecisionEnabled: true });
      conflictService.service.startTopicDecisionSession = () => {
        throw Object.assign(new Error("version conflict"), { name: "TopicDecisionConflictError", entityId: "session-1", currentVersion: 5, currentState: "debating" });
      };
      const conflictServer = createMemoryHttpServer({
        service: conflictService.service,
        auth: { scopedApiKeys: { "writer": { namespace, scopes: ["panel:write"] } } }
      });
      await withServerClosed(conflictServer, async () => {
        await new Promise<void>((resolve) => conflictServer.listen(0, "127.0.0.1", resolve));
        const cAddress = conflictServer.address();
        if (!cAddress || typeof cAddress === "string") throw new Error("expected TCP address");
        const cBase = `http://127.0.0.1:${cAddress.port}`;

        const conflict = await fetch(`${cBase}/api/v1/topic-inbox/topics/topic-1/decisions`, {
          method: "POST",
          headers,
          body: JSON.stringify({ namespace, adapterId: "test", requestId: "req-conflict" })
        });
        expect(conflict.status).toBe(409);
        const conflictBody = await conflict.json() as { error: { code: string }; details: { sessionId: string; currentVersion: number; currentState: string } };
        expect(conflictBody.error.code).toBe("conflict");
        expect(conflictBody.details.sessionId).toBe("session-1");
        expect(conflictBody.details.currentVersion).toBe(5);
      });
    });
    db.close();
  });

  it("preserves 409 error details for stale version in answers, approve, confirm", async () => {
    const { db, service } = createTestService({ topicDecisionEnabled: true });
    const namespace = { source: "codex", profileId: "default", userId: "td-user", projectId: "td-project" };
    service.readTopicDecisionSession = () => ({ session: { id: "session-1", namespaceId: "ns", topicId: "topic-1", inputHash: "h1", state: "draft", version: 1, metadata: {}, createdAt: "2026-08-12T00:00:00Z", updatedAt: "2026-08-12T00:00:00Z" }, snapshots: [], executionRuns: [{ id: "run-1", sessionId: "session-1" }] } as any);

    // Setup mock conflict behaviors
    service.submitEvidenceAnswers = async () => { throw Object.assign(new Error("stale version"), { name: "TopicDecisionConflictError", entityId: "session-1", currentVersion: 3, currentState: "gathering_evidence" }); };
    service.approveProposal = async () => { throw Object.assign(new Error("stale proposal"), { name: "TopicDecisionConflictError", entityId: "prop-1", entityType: "proposal", currentVersion: 7, currentState: "approved" }); };
    service.confirmExecutionAction = async () => { throw Object.assign(new Error("stale run"), { name: "TopicDecisionConflictError", entityId: "run-1", entityType: "run", currentVersion: 2, currentState: "completed" }); };

    const server = createMemoryHttpServer({
      service,
      auth: { scopedApiKeys: { "writer": { namespace, scopes: ["panel:write"] } } }
    });
    await withServerClosed(server, async () => {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("expected TCP address");
      const base = `http://127.0.0.1:${address.port}`;
      const headers = { authorization: "Bearer writer", "content-type": "application/json" };

      // Answers conflict
      const answersConflict = await fetch(`${base}/api/v1/topic-inbox/decisions/session-1/answers`, {
        method: "POST",
        headers,
        body: JSON.stringify({ namespace, expectedVersion: 1, answers: [{ questionKey: "q1", answer: "a", source: "user_preference" }], adapterId: "test", requestId: "req-answers-conflict" })
      });
      expect(answersConflict.status).toBe(409);
      const answersBody = await answersConflict.json() as { error: { code: string }; details: { sessionId: string; currentVersion: number } };
      expect(answersBody.details.sessionId).toBe("session-1");
      expect(answersBody.details.currentVersion).toBe(3);

      // Approve conflict
      const approveConflict = await fetch(`${base}/api/v1/topic-inbox/decisions/session-1/proposals/prop-1/approve`, {
        method: "POST",
        headers,
        body: JSON.stringify({ namespace, expectedProposalVersion: 1, adapterId: "test", requestId: "req-approve-conflict" })
      });
      expect(approveConflict.status).toBe(409);
      const approveBody = await approveConflict.json() as { error: { code: string }; details: { proposalId: string; currentVersion: number } };
      expect(approveBody.details.proposalId).toBe("prop-1");
      expect(approveBody.details.currentVersion).toBe(7);

      // Confirm conflict
      const confirmConflict = await fetch(`${base}/api/v1/topic-inbox/decisions/session-1/executions/run-1/actions/action-1/confirm`, {
        method: "POST",
        headers,
        body: JSON.stringify({ namespace, expectedRunVersion: 1, approved: true, idempotencyKey: "k1", adapterId: "test", requestId: "req-confirm-conflict" })
      });
      expect(confirmConflict.status).toBe(409);
      const confirmBody = await confirmConflict.json() as { error: { code: string }; details: { runId: string; currentVersion: number } };
      expect(confirmBody.details.runId).toBe("run-1");
      expect(confirmBody.details.currentVersion).toBe(2);
    });
    db.close();
  });

  it("idempotent exact replay for start, answers, approve, confirm, cancel, agents", async () => {
    const { db, service } = createTestService({
      config: {
        ...configWithMemoryGates({ enableMemoryAdd: true }),
        algorithm: { ...configWithMemoryGates({ enableMemoryAdd: true }).algorithm, topicDecisions: { enabled: true, models: [] } }
      },
      topicDecisionEnabled: true
    });
    const namespace = { source: "codex", profileId: "default", userId: "td-user", projectId: "td-project" };
    let startCount = 0;
    let answerCount = 0;
    let approveCount = 0;
    let confirmCount = 0;
    let cancelCount = 0;
    let agentsCount = 0;
    service.readTopicDecisionSession = () => ({
      session: { id: "session-1", namespaceId: "ns", topicId: "topic-1", inputHash: "h1", state: "draft", version: 1, metadata: {}, createdAt: "2026-08-12T00:00:00Z", updatedAt: "2026-08-12T00:00:00Z" },
      snapshots: [],
      executionRuns: [{ id: "run-1", namespaceId: "ns", sessionId: "session-1", round: 1, rank: 1, effect: "test", title: "test", payload: {}, status: "running", version: 1, metadata: {}, createdAt: "2026-08-12T00:00:00Z", updatedAt: "2026-08-12T00:00:00Z" }]
    } as any);

    // Mock service methods to track calls while returning stable results
    service.startTopicDecisionSession = () => {
      startCount++;
      return {
        session: { id: "session-1", namespaceId: "ns", topicId: "topic-1", inputHash: "h1", state: "draft", version: 1, metadata: {}, createdAt: "2026-08-12T00:00:00Z", updatedAt: "2026-08-12T00:00:00Z" },
        snapshot: { id: "snap-1", namespaceId: "ns", sessionId: "session-1", round: 0, payload: { topicVersion: 1, evidenceIds: [], evidenceHashes: {}, evidenceContent: {}, projectConstraints: [], roster: [], inputHash: "h1" }, createdAt: "2026-08-12T00:00:00Z" },
        reused: false
      };
    };
    service.submitEvidenceAnswers = async () => {
      answerCount++;
      return { session: { id: "session-1", version: 2 } as any, snapshots: [] };
    };
    service.approveProposal = async () => {
      approveCount++;
      return { id: "run-1", status: "running" } as any;
    };
    service.confirmExecutionAction = async () => {
      confirmCount++;
      return { id: "run-1", status: "awaiting_second_confirmation", version: 2 } as any;
    };
    service.cancelTopicDecisionSession = () => {
      cancelCount++;
      return {
        session: { id: "session-1", version: 2, state: "cancelled" } as any,
        snapshots: []
      };
    };
    service.updateTopicDecisionSessionAgents = () => {
      agentsCount++;
      return {
        session: { id: "session-1", version: 2 } as any,
        snapshots: []
      };
    };

    const server = createMemoryHttpServer({
      service,
      auth: { scopedApiKeys: { "writer": { namespace, scopes: ["panel:write"] } } }
    });
    await withServerClosed(server, async () => {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("expected TCP address");
      const base = `http://127.0.0.1:${address.port}`;
      const headers = { authorization: "Bearer writer", "content-type": "application/json" };

      // Idempotent start
      const startBody = JSON.stringify({ namespace, adapterId: "test", requestId: "req-start", agents: [{ id: "a1", role: "analyst", model: "gpt", reason: "test" }] });
      const start1 = await fetch(`${base}/api/v1/topic-inbox/topics/topic-1/decisions`, { method: "POST", headers, body: startBody });
      const start2 = await fetch(`${base}/api/v1/topic-inbox/topics/topic-1/decisions`, { method: "POST", headers, body: startBody });
      expect(start1.status).toBe(200);
      expect(await start1.json()).toEqual(await start2.json());
      expect(startCount).toBe(1);

      // Idempotent agents (PATCH)
      const agentsBody = JSON.stringify({ namespace, adapterId: "test", requestId: "req-agents", expectedVersion: 1, agents: [{ id: "a1", role: "analyst", model: "gpt", reason: "test" }] });
      const agents1 = await fetch(`${base}/api/v1/topic-inbox/decisions/session-1/agents`, { method: "PATCH", headers, body: agentsBody });
      const agents2 = await fetch(`${base}/api/v1/topic-inbox/decisions/session-1/agents`, { method: "PATCH", headers, body: agentsBody });
      expect(agents1.status).toBe(200);
      const agents1Json = await agents1.json() as { session: { version: number } };
      const agents2Json = await agents2.json() as { session: { version: number } };
      expect(agents1Json).toEqual(agents2Json);
      expect(agentsCount).toBe(1);
      // Version unchanged on replay
      expect(agents1Json.session.version).toBe(agents2Json.session.version);

      // Idempotent answers
      const answersBody = JSON.stringify({ namespace, adapterId: "test", requestId: "req-answers", expectedVersion: 1, answers: [{ questionKey: "q1", answer: "a", source: "user_preference" }] });
      const ans1 = await fetch(`${base}/api/v1/topic-inbox/decisions/session-1/answers`, { method: "POST", headers, body: answersBody });
      const ans2 = await fetch(`${base}/api/v1/topic-inbox/decisions/session-1/answers`, { method: "POST", headers, body: answersBody });
      expect(ans1.status).toBe(200);
      expect(await ans1.json()).toEqual(await ans2.json());
      expect(answerCount).toBe(1);

      // Idempotent approve
      const approveBody = JSON.stringify({ namespace, adapterId: "test", requestId: "req-approve", expectedProposalVersion: 1 });
      const appr1 = await fetch(`${base}/api/v1/topic-inbox/decisions/session-1/proposals/prop-1/approve`, { method: "POST", headers, body: approveBody });
      const appr2 = await fetch(`${base}/api/v1/topic-inbox/decisions/session-1/proposals/prop-1/approve`, { method: "POST", headers, body: approveBody });
      expect(appr1.status).toBe(200);
      expect(await appr1.json()).toEqual(await appr2.json());
      expect(approveCount).toBe(1);

      // Idempotent confirm
      const confirmBody = JSON.stringify({ namespace, adapterId: "test", requestId: "req-confirm", expectedRunVersion: 1, approved: true, idempotencyKey: "k1" });
      const conf1 = await fetch(`${base}/api/v1/topic-inbox/decisions/session-1/executions/run-1/actions/action-1/confirm`, { method: "POST", headers, body: confirmBody });
      const conf2 = await fetch(`${base}/api/v1/topic-inbox/decisions/session-1/executions/run-1/actions/action-1/confirm`, { method: "POST", headers, body: confirmBody });
      expect(conf1.status).toBe(200);
      expect(await conf1.json()).toEqual(await conf2.json());
      expect(confirmCount).toBe(1);

      // Idempotent cancel
      const cancelBody = JSON.stringify({ namespace, adapterId: "test", requestId: "req-cancel", expectedVersion: 1 });
      const canc1 = await fetch(`${base}/api/v1/topic-inbox/decisions/session-1/cancel`, { method: "POST", headers, body: cancelBody });
      const canc2 = await fetch(`${base}/api/v1/topic-inbox/decisions/session-1/cancel`, { method: "POST", headers, body: cancelBody });
      expect(canc1.status).toBe(200);
      expect(await canc1.json()).toEqual(await canc2.json());
      expect(cancelCount).toBe(1);
    });
    db.close();
  });

  it("sanitizes model errors, omits credentials and provider payloads from responses", async () => {
    const { db, service } = createTestService({ topicDecisionEnabled: true });
    const namespace = { source: "codex", profileId: "default", userId: "td-user", projectId: "td-project" };

    service.startTopicDecisionSession = () => ({
      session: { id: "session-1", namespaceId: "ns", topicId: "t1", inputHash: "h1", state: "draft", version: 1, metadata: { apiKey: "secret123", internalProviderPayload: { token: "leak" } }, createdAt: "2026-08-12T00:00:00Z", updatedAt: "2026-08-12T00:00:00Z" },
      snapshot: { id: "snap-1", namespaceId: "ns", sessionId: "session-1", round: 0, payload: { topicVersion: 1, evidenceIds: [], evidenceHashes: {}, evidenceContent: { e1: "sensitive data" }, projectConstraints: [], roster: [], inputHash: "h1" }, createdAt: "2026-08-12T00:00:00Z" },
      reused: false
    });

    const server = createMemoryHttpServer({
      service,
      auth: { scopedApiKeys: { "writer": { namespace, scopes: ["panel:write"] } } }
    });
    await withServerClosed(server, async () => {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("expected TCP address");
      const base = `http://127.0.0.1:${address.port}`;
      const headers = { authorization: "Bearer writer", "content-type": "application/json" };

      const start = await fetch(`${base}/api/v1/topic-inbox/topics/topic-1/decisions`, {
        method: "POST",
        headers,
        body: JSON.stringify({ namespace, adapterId: "test", requestId: "req-sanitize" })
      });
      const body = await start.json() as { session: Record<string, unknown>; snapshot: Record<string, unknown> };
      expect(start.status).toBe(200);
      expect(body.session).not.toHaveProperty("apiKey");
      expect(body.session).not.toHaveProperty("internalProviderPayload");
      expect(body.snapshot.payload).not.toHaveProperty("evidenceContent");
    });
    db.close();
  });

  it("provides action-first routes with correct URL encoding", async () => {
    const { db, service } = createTestService({ topicDecisionEnabled: true });
    const namespace = { source: "codex", profileId: "default", userId: "td-user", projectId: "td-project" };
    const server = createMemoryHttpServer({
      service,
      auth: { scopedApiKeys: { "writer": { namespace, scopes: ["panel:write"] } } }
    });
    await withServerClosed(server, async () => {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("expected TCP address");
      const base = `http://127.0.0.1:${address.port}`;
      const headers = { authorization: "Bearer writer", "content-type": "application/json" };

      // Action-first route: positions
      service.runIndependentPositions = async () => {};
      const positions = await fetch(`${base}/api/v1/topic-inbox/decisions/session-1/positions`, {
        method: "POST",
        headers,
        body: JSON.stringify({ namespace, adapterId: "test", requestId: "req-positions" })
      });
      expect([200, 202]).toContain(positions.status);

      // Action-first route: debate
      service.runDebate = async () => ({ session: { id: "s", namespaceId: "ns", topicId: "t1", inputHash: "h1", state: "debating", version: 1, metadata: {}, createdAt: "2026-08-12T00:00:00Z", updatedAt: "2026-08-12T00:00:00Z" }, snapshots: [] });
      const debate = await fetch(`${base}/api/v1/topic-inbox/decisions/session-1/debate`, {
        method: "POST",
        headers,
        body: JSON.stringify({ namespace, adapterId: "test", requestId: "req-debate" })
      });
      expect([200, 202]).toContain(debate.status);

      // Action-first route: proposals
      service.synthesizeProposals = async () => ({ session: { id: "s", namespaceId: "ns", topicId: "t1", inputHash: "h1", state: "proposing", version: 1, metadata: {}, createdAt: "2026-08-12T00:00:00Z", updatedAt: "2026-08-12T00:00:00Z" }, snapshots: [] });
      const proposals = await fetch(`${base}/api/v1/topic-inbox/decisions/session-1/proposals`, {
        method: "POST",
        headers,
        body: JSON.stringify({ namespace, adapterId: "test", requestId: "req-proposals" })
      });
      expect([200, 202]).toContain(proposals.status);

      // URL encoding for special characters in IDs
      service.readTopicDecisionSession = () => ({
        session: { id: "session-1", namespaceId: "ns", topicId: "t1", inputHash: "h1", state: "draft", version: 1, metadata: {}, createdAt: "2026-08-12T00:00:00Z", updatedAt: "2026-08-12T00:00:00Z" },
        snapshots: []
      });
      const encodedId = await fetch(`${base}/api/v1/topic-inbox/decisions/session%2D1?namespace=${encodeURIComponent(JSON.stringify(namespace))}`, {
        headers
      });
      expect(encodedId.status).toBe(200);
    });
    db.close();
  });

  it("client methods match server routes with bearer token propagation", async () => {
    const { db, service } = createTestService({ topicDecisionEnabled: true });
    const namespace = { source: "codex", profileId: "default", userId: "td-user", projectId: "td-project" };
    const server = createMemoryHttpServer({
      service,
      auth: { scopedApiKeys: { "test-token": { namespace, scopes: ["panel:read", "panel:write"] } } }
    });
    await withServerClosed(server, async () => {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("expected TCP address");
      const client = new MemoryRestClient({ endpoint: `http://127.0.0.1:${address.port}`, token: "test-token" });

      // Client methods exist
      expect(typeof client.startTopicDecision).toBe("function");
      expect(typeof client.readTopicDecision).toBe("function");
      expect(typeof client.patchTopicDecisionAgents).toBe("function");
      expect(typeof client.runTopicDecisionPositions).toBe("function");
      expect(typeof client.runTopicDecisionDebate).toBe("function");
      expect(typeof client.runTopicDecisionProposals).toBe("function");
      expect(typeof client.submitTopicDecisionAnswers).toBe("function");
      expect(typeof client.approveTopicDecisionProposal).toBe("function");
      expect(typeof client.resumeTopicDecisionExecution).toBe("function");
      expect(typeof client.confirmTopicDecisionAction).toBe("function");
    });
    db.close();
  });

  it("client preserves 409 error details", async () => {
    const { db, service } = createTestService({ topicDecisionEnabled: true });
    const namespace = { source: "codex", profileId: "default", userId: "td-user", projectId: "td-project" };

    service.submitEvidenceAnswers = async () => {
      throw Object.assign(new Error("stale"), { name: "TopicDecisionConflictError", entityId: "session-1", currentVersion: 5, currentState: "debating" });
    };

    const server = createMemoryHttpServer({
      service,
      auth: { scopedApiKeys: { "test-token": { namespace, scopes: ["panel:write"] } } }
    });
    await withServerClosed(server, async () => {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("expected TCP address");
      const client = new MemoryRestClient({ endpoint: `http://127.0.0.1:${address.port}`, token: "test-token" });

      try {
        await client.submitTopicDecisionAnswers("session-1", {
          namespace,
          expectedVersion: 1,
          answers: [{ questionKey: "q1", answer: "a", source: "user_preference" }]
        });
        expect.fail("expected error");
      } catch (err: any) {
        expect(err.status).toBe(409);
        expect(err.payload).toMatchObject({
          error: { code: "conflict" },
          details: { sessionId: "session-1", currentVersion: 5 }
        });
      }
    });
    db.close();
  });

  it("maps forbidden policy to 403", async () => {
    const { db, service } = createTestService({ topicDecisionEnabled: true });
    const namespace = { source: "codex", profileId: "default", userId: "td-user", projectId: "td-project" };

    service.approveProposal = async () => {
      const err = new Error("execution policy forbids this action");
      (err as any).name = "TopicDecisionPolicyError";
      (err as any).policy = "require_second_confirmation";
      throw err;
    };

    const server = createMemoryHttpServer({
      service,
      auth: { scopedApiKeys: { "writer": { namespace, scopes: ["panel:write"] } } }
    });
    await withServerClosed(server, async () => {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("expected TCP address");
      const base = `http://127.0.0.1:${address.port}`;
      const headers = { authorization: "Bearer writer", "content-type": "application/json" };

      const forbidden = await fetch(`${base}/api/v1/topic-inbox/decisions/session-1/proposals/prop-1/approve`, {
        method: "POST",
        headers,
        body: JSON.stringify({ namespace, expectedProposalVersion: 1, adapterId: "test", requestId: "req-policy" })
      });
      expect(forbidden.status).toBe(403);
      const body = await forbidden.json() as { error: { code: string; message: string } };
      expect(body.error.code).toBe("forbidden");
      expect(body.error.message).toContain("policy");
    });
    db.close();
  });

  it("maps invalid confirmation to 400", async () => {
    const { db, service } = createTestService({ topicDecisionEnabled: true });
    const namespace = { source: "codex", profileId: "default", userId: "td-user", projectId: "td-project" };
    service.readTopicDecisionSession = () => ({ session: { id: "session-1", namespaceId: "ns", topicId: "topic-1", inputHash: "h1", state: "draft", version: 1, metadata: {}, createdAt: "2026-08-12T00:00:00Z", updatedAt: "2026-08-12T00:00:00Z" }, snapshots: [], executionRuns: [{ id: "run-1", sessionId: "session-1" }] } as any);

    service.confirmExecutionAction = async () => {
      const err = new Error("action not awaiting confirmation");
      (err as any).name = "TopicDecisionConfirmError";
      throw err;
    };

    const server = createMemoryHttpServer({
      service,
      auth: { scopedApiKeys: { "writer": { namespace, scopes: ["panel:write"] } } }
    });
    await withServerClosed(server, async () => {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("expected TCP address");
      const base = `http://127.0.0.1:${address.port}`;
      const headers = { authorization: "Bearer writer", "content-type": "application/json" };

      const invalidConfirm = await fetch(`${base}/api/v1/topic-inbox/decisions/session-1/executions/run-1/actions/action-1/confirm`, {
        method: "POST",
        headers,
        body: JSON.stringify({ namespace, expectedRunVersion: 1, approved: true, idempotencyKey: "k1", adapterId: "test", requestId: "req-invalid-confirm" })
      });
      expect(invalidConfirm.status).toBe(400);
      const body = await invalidConfirm.json() as { error: { code: string } };
      expect(body.error.code).toBe("invalid_argument");
    });
    db.close();
  });

  it("maps structured execution failure to 500 with safe message", async () => {
    const { db, service } = createTestService({ topicDecisionEnabled: true });
    const namespace = { source: "codex", profileId: "default", userId: "td-user", projectId: "td-project" };

    service.readTopicDecisionSession = () => ({
      session: { id: "session-1", namespaceId: "ns", topicId: "topic-1", inputHash: "h1", state: "draft", version: 1, metadata: {}, createdAt: "2026-08-12T00:00:00Z", updatedAt: "2026-08-12T00:00:00Z" },
      snapshots: [],
      executionRuns: [{ id: "run-1", namespaceId: "ns", sessionId: "session-1", round: 1, rank: 1, effect: "test", title: "test", payload: {}, status: "running", version: 1, metadata: {}, createdAt: "2026-08-12T00:00:00Z", updatedAt: "2026-08-12T00:00:00Z" }]
    } as any);
    service.resumeExecution = async () => {
      const err = new Error("execution failed: apiKey=secret123");
      (err as any).name = "TopicExecutionError";
      (err as any).actionId = "action-1";
      (err as any).phase = "execute";
      throw err;
    };

    const server = createMemoryHttpServer({
      service,
      auth: { scopedApiKeys: { "writer": { namespace, scopes: ["panel:write"] } } }
    });
    await withServerClosed(server, async () => {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("expected TCP address");
      const base = `http://127.0.0.1:${address.port}`;
      const headers = { authorization: "Bearer writer", "content-type": "application/json" };

      const execFailed = await fetch(`${base}/api/v1/topic-inbox/decisions/session-1/executions/run-1/resume`, {
        method: "POST",
        headers,
        body: JSON.stringify({ namespace, adapterId: "test", requestId: "req-exec-failed" })
      });
      expect(execFailed.status).toBe(500);
      const body = await execFailed.json() as { error: { code: string; message: string } };
      expect(body.error.code).toBe("internal");
      expect(body.error.message).not.toContain("secret123");
    });
    db.close();
  });

  describe("PATCH agents", () => {
    it("success with version change", async () => {
      const { db, service } = createTestService({ topicDecisionEnabled: true });
      const namespace = { source: "codex", profileId: "default", userId: "td-user", projectId: "td-project" };

      service.updateTopicDecisionSessionAgents = () => ({
        session: { id: "session-1", namespaceId: "ns", topicId: "t1", inputHash: "h1", state: "draft", version: 2, metadata: {}, createdAt: "2026-08-12T00:00:00Z", updatedAt: "2026-08-12T00:00:00Z" },
        snapshots: []
      });

      const server = createMemoryHttpServer({
        service,
        auth: { scopedApiKeys: { "writer": { namespace, scopes: ["panel:write"] } } }
      });
      await withServerClosed(server, async () => {
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("expected TCP address");
        const base = `http://127.0.0.1:${address.port}`;
        const headers = { authorization: "Bearer writer", "content-type": "application/json" };

        const patch = await fetch(`${base}/api/v1/topic-inbox/decisions/session-1/agents`, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ namespace, adapterId: "test", requestId: "req-patch-success", expectedVersion: 1, agents: [{ id: "agent-1", role: "analyst", model: "gpt-4", reason: "test" }] })
        });
        expect(patch.status).toBe(200);
        const body = await patch.json() as { session: { version: number } };
        expect(body.session.version).toBe(2);
      });
      db.close();
    });

    it("conflict error on stale version", async () => {
      const { db, service } = createTestService({ topicDecisionEnabled: true });
      const namespace = { source: "codex", profileId: "default", userId: "td-user", projectId: "td-project" };

      service.updateTopicDecisionSessionAgents = () => {
        throw Object.assign(new Error("stale version"), { name: "TopicDecisionConflictError", entityId: "session-1", currentVersion: 5, currentState: "gathering_evidence" });
      };

      const server = createMemoryHttpServer({
        service,
        auth: { scopedApiKeys: { "writer": { namespace, scopes: ["panel:write"] } } }
      });
      await withServerClosed(server, async () => {
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("expected TCP address");
        const base = `http://127.0.0.1:${address.port}`;
        const headers = { authorization: "Bearer writer", "content-type": "application/json" };

        const patch = await fetch(`${base}/api/v1/topic-inbox/decisions/session-1/agents`, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ namespace, adapterId: "test", requestId: "req-patch-conflict", expectedVersion: 1, agents: [] })
        });
        expect(patch.status).toBe(409);
        const body = await patch.json() as { error: { code: string }; details: { sessionId: string; currentVersion: number } };
        expect(body.error.code).toBe("conflict");
        expect(body.details.sessionId).toBe("session-1");
        expect(body.details.currentVersion).toBe(5);
      });
      db.close();
    });

    it("policy error on terminal state", async () => {
      const { db, service } = createTestService({ topicDecisionEnabled: true });
      const namespace = { source: "codex", profileId: "default", userId: "td-user", projectId: "td-project" };

      service.updateTopicDecisionSessionAgents = () => {
        const err = new Error("cannot update agents in terminal state");
        (err as any).name = "TopicDecisionPolicyError";
        throw err;
      };

      const server = createMemoryHttpServer({
        service,
        auth: { scopedApiKeys: { "writer": { namespace, scopes: ["panel:write"] } } }
      });
      await withServerClosed(server, async () => {
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("expected TCP address");
        const base = `http://127.0.0.1:${address.port}`;
        const headers = { authorization: "Bearer writer", "content-type": "application/json" };

        const patch = await fetch(`${base}/api/v1/topic-inbox/decisions/session-1/agents`, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ namespace, adapterId: "test", requestId: "req-patch-policy", expectedVersion: 1, agents: [] })
        });
        expect(patch.status).toBe(403);
        const body = await patch.json() as { error: { code: string; message: string } };
        expect(body.error.code).toBe("forbidden");
        expect(body.error.message).toContain("terminal state");
      });
      db.close();
    });
  });

  describe("POST cancel", () => {
    it("success with state change", async () => {
      const { db, service } = createTestService({ topicDecisionEnabled: true });
      const namespace = { source: "codex", profileId: "default", userId: "td-user", projectId: "td-project" };

      service.cancelTopicDecisionSession = () => ({
        session: { id: "session-1", namespaceId: "ns", topicId: "t1", inputHash: "h1", state: "cancelled", version: 2, metadata: {}, createdAt: "2026-08-12T00:00:00Z", updatedAt: "2026-08-12T00:00:00Z" },
        snapshots: []
      });

      const server = createMemoryHttpServer({
        service,
        auth: { scopedApiKeys: { "writer": { namespace, scopes: ["panel:write"] } } }
      });
      await withServerClosed(server, async () => {
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("expected TCP address");
        const base = `http://127.0.0.1:${address.port}`;
        const headers = { authorization: "Bearer writer", "content-type": "application/json" };

        const cancel = await fetch(`${base}/api/v1/topic-inbox/decisions/session-1/cancel`, {
          method: "POST",
          headers,
          body: JSON.stringify({ namespace, adapterId: "test", requestId: "req-cancel-success", expectedVersion: 1 })
        });
        expect(cancel.status).toBe(200);
        const body = await cancel.json() as { session: { state: string; version: number } };
        expect(body.session.state).toBe("cancelled");
        expect(body.session.version).toBe(2);
      });
      db.close();
    });

    it("conflict error on stale version", async () => {
      const { db, service } = createTestService({ topicDecisionEnabled: true });
      const namespace = { source: "codex", profileId: "default", userId: "td-user", projectId: "td-project" };

      service.cancelTopicDecisionSession = () => {
        throw Object.assign(new Error("stale version"), { name: "TopicDecisionConflictError", entityId: "session-1", currentVersion: 3, currentState: "gathering_evidence" });
      };

      const server = createMemoryHttpServer({
        service,
        auth: { scopedApiKeys: { "writer": { namespace, scopes: ["panel:write"] } } }
      });
      await withServerClosed(server, async () => {
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("expected TCP address");
        const base = `http://127.0.0.1:${address.port}`;
        const headers = { authorization: "Bearer writer", "content-type": "application/json" };

        const cancel = await fetch(`${base}/api/v1/topic-inbox/decisions/session-1/cancel`, {
          method: "POST",
          headers,
          body: JSON.stringify({ namespace, adapterId: "test", requestId: "req-cancel-conflict", expectedVersion: 1 })
        });
        expect(cancel.status).toBe(409);
        const body = await cancel.json() as { error: { code: string }; details: { sessionId: string; currentVersion: number } };
        expect(body.error.code).toBe("conflict");
        expect(body.details.sessionId).toBe("session-1");
        expect(body.details.currentVersion).toBe(3);
      });
      db.close();
    });

    it("policy error on executing state", async () => {
      const { db, service } = createTestService({ topicDecisionEnabled: true });
      const namespace = { source: "codex", profileId: "default", userId: "td-user", projectId: "td-project" };

      service.cancelTopicDecisionSession = () => {
        const err = new Error("cannot cancel while execution is running");
        (err as any).name = "TopicDecisionPolicyError";
        throw err;
      };

      const server = createMemoryHttpServer({
        service,
        auth: { scopedApiKeys: { "writer": { namespace, scopes: ["panel:write"] } } }
      });
      await withServerClosed(server, async () => {
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("expected TCP address");
        const base = `http://127.0.0.1:${address.port}`;
        const headers = { authorization: "Bearer writer", "content-type": "application/json" };

        const cancel = await fetch(`${base}/api/v1/topic-inbox/decisions/session-1/cancel`, {
          method: "POST",
          headers,
          body: JSON.stringify({ namespace, adapterId: "test", requestId: "req-cancel-policy", expectedVersion: 1 })
        });
        expect(cancel.status).toBe(403);
        const body = await cancel.json() as { error: { code: string; message: string } };
        expect(body.error.code).toBe("forbidden");
        expect(body.error.message).toContain("execution");
      });
      db.close();
    });
    it("idempotent success on already cancelled", async () => {
      const { db, service } = createTestService({
        config: {
          ...configWithMemoryGates({ enableMemoryAdd: true }),
          algorithm: { ...configWithMemoryGates({ enableMemoryAdd: true }).algorithm, topicDecisions: { enabled: true, models: [] } }
        },
        topicDecisionEnabled: true
      });
      const namespace = { source: "codex", profileId: "default", userId: "td-user", projectId: "td-project" };

      let cancelCount = 0;
      service.cancelTopicDecisionSession = () => {
        cancelCount++;
        return {
          session: { id: "session-1", version: 2, state: "cancelled" } as any,
          snapshots: []
        };
      };

      const server = createMemoryHttpServer({
        service,
        auth: { scopedApiKeys: { "writer": { namespace, scopes: ["panel:write"] } } }
      });
      await withServerClosed(server, async () => {
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("expected TCP address");
        const base = `http://127.0.0.1:${address.port}`;
        const headers = { authorization: "Bearer writer", "content-type": "application/json" };

        const cancelBody = JSON.stringify({ namespace, adapterId: "test", requestId: "req-cancel", expectedVersion: 2 });
        const cancel1 = await fetch(`${base}/api/v1/topic-inbox/decisions/session-1/cancel`, {
          method: "POST",
          headers,
          body: cancelBody
        });
        const cancel2 = await fetch(`${base}/api/v1/topic-inbox/decisions/session-1/cancel`, {
          method: "POST",
          headers,
          body: cancelBody
        });
        expect(cancel1.status).toBe(200);
        expect(cancel2.status).toBe(200);
        expect(await cancel1.json()).toEqual(await cancel2.json());
        // With exactReplay enabled, cancel route uses idempotent() wrapper
        expect(cancelCount).toBe(1);
      });
      db.close();
    });
  });
});
  it("rejects missing idempotency envelope fields on every mutation", async () => {
    const { db, service } = createTestService({ topicDecisionEnabled: true });
    const namespace = { source: "codex", profileId: "default", userId: "td-user", projectId: "td-project" };
    const server = createMemoryHttpServer({ service, auth: { scopedApiKeys: { writer: { namespace, scopes: ["panel:write"] } } } });
    await withServerClosed(server, async () => {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("expected TCP address");
      const base = `http://127.0.0.1:${address.port}`;
      const headers = { authorization: "Bearer writer", "content-type": "application/json" };
      const cases: Array<[string, Record<string, unknown>]> = [
        [`${base}/api/v1/topic-inbox/topics/t1/decisions`, { namespace }],
        [`${base}/api/v1/topic-inbox/decisions/s1/run`, { namespace }],
        [`${base}/api/v1/topic-inbox/decisions/s1/positions`, { namespace }],
        [`${base}/api/v1/topic-inbox/decisions/s1/debate`, { namespace }],
        [`${base}/api/v1/topic-inbox/decisions/s1/proposals`, { namespace }],
        [`${base}/api/v1/topic-inbox/decisions/s1/proposals/p1/approve`, { namespace, expectedProposalVersion: 1 }],
        [`${base}/api/v1/topic-inbox/decisions/s1/executions/r1/resume`, { namespace }],
        [`${base}/api/v1/topic-inbox/decisions/s1/executions/r1/actions/a1/confirm`, { namespace, expectedRunVersion: 1, approved: true, idempotencyKey: "k" }]
      ];
      for (const [url, body] of cases) {
        const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
        expect(response.status, url).toBe(400);
      }
    });
    db.close();
  });

  it("sends namespace in the decision read query", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ session: {}, snapshots: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new MemoryRestClient({ endpoint: "http://example.test" });
    const namespace = { source: "codex", profileId: "default", userId: "u", projectId: "p" };
    await client.readTopicDecision("s1", namespace);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("namespace=");
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(encodeURIComponent(JSON.stringify(namespace)));
  });

  it("sanitizes nested execution result fields", async () => {
    const { db, service } = createTestService({ topicDecisionEnabled: true });
    const namespace = { source: "codex", profileId: "default", userId: "td-user", projectId: "td-project" };
    const run = { id: "r1", namespaceId: "ns", sessionId: "s1", proposalId: "p1", status: "failed", result: { status: "failed", actions: [{ id: "a1", status: "failed", output: { token: "secret", safe: "ok" }, error: { code: "E_FAIL", message: "safe", providerPayload: { apiKey: "secret" } }, providerPayload: { secret: "x" } }] }, version: 2, createdAt: "2026-08-12T00:00:00Z", updatedAt: "2026-08-12T00:00:00Z" };
    service.approveProposal = async () => run as any;
    const server = createMemoryHttpServer({ service, auth: { scopedApiKeys: { writer: { namespace, scopes: ["panel:write"] } } } });
    await withServerClosed(server, async () => {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("expected TCP address");
      const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/topic-inbox/decisions/s1/proposals/p1/approve`, { method: "POST", headers: { authorization: "Bearer writer", "content-type": "application/json" }, body: JSON.stringify({ namespace, expectedProposalVersion: 1, adapterId: "sanitizer-test", requestId: "req-nested-sanitizer" }) });
      const body = await response.json() as any;
      expect(body.result.actions[0].output).toEqual({});
      expect(body.result.actions[0].error).toEqual({ code: "E_FAIL", message: "safe" });
      expect(JSON.stringify(body)).not.toContain("secret");
    });
    db.close();
  });