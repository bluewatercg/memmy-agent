import { describe, expect, it } from "vitest";
import { MemoryDb, Repositories } from "../../../src/index.js";
import type { TopicActionProposalRecord, TopicDecisionSessionRecord, TopicExecutionRunRecord } from "../../../src/types.js";

function fixture() {
  const db = new MemoryDb({ path: ":memory:" });
  const repos = new Repositories(db.db);
  const namespaceId = "ns-stale";
  const topicId = "topic-stale";
  const session: TopicDecisionSessionRecord = { id: "session-stale", namespaceId, topicId, inputHash: "input-1", state: "executing", version: 2, metadata: {}, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
  repos.topicDecisions.createSession(session);
  const proposal: TopicActionProposalRecord = { id: "proposal-stale", namespaceId, sessionId: session.id, round: 1, rank: 1, effect: "authoritative_write", title: "Write", payload: { actions: [{ id: "a1", effect: "authoritative_write", target: "x", input: {}, dependsOn: [], recoveryPoint: "r", acceptanceCondition: "ok" }] }, status: "approved", version: 2, metadata: { recommended: true }, createdAt: session.createdAt, updatedAt: session.updatedAt };
  repos.topicDecisions.insertProposal(proposal);
  const run: TopicExecutionRunRecord = { id: "run-stale", namespaceId, sessionId: session.id, proposalId: proposal.id, status: "running", result: { actions: [{ id: "a1", status: "pending", confirmationEvents: [] }, { id: "a0", status: "succeeded", output: { ok: true }, confirmationEvents: [] }] }, version: 1, createdAt: session.createdAt, updatedAt: session.updatedAt };
  repos.topicDecisions.createExecutionRun(run);
  return { db, repos, namespaceId, session };
}

describe("topic decision staleness", () => {
  it("marks active sessions stale and stops only pending execution actions", () => {
    const { db, repos, namespaceId, session } = fixture();
    const result = repos.topicDecisions.markSessionsStaleForTopic(namespaceId, session.topicId, "topic changed", "2026-01-01T01:00:00.000Z");
    expect(result.sessions).toBe(1);
    expect(repos.topicDecisions.getSession(namespaceId, session.id)?.state).toBe("stale");
    const run = repos.topicDecisions.getRun(namespaceId, "run-stale")!;
    expect(run.status).toBe("failed");
    expect((run.result.actions as Array<{ id: string; status: string }>).find((a) => a.id === "a1")?.status).toBe("skipped");
    expect((run.result.actions as Array<{ id: string; status: string }>).find((a) => a.id === "a0")?.status).toBe("succeeded");
    db.close();
  });
});
