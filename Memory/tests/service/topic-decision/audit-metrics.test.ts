import { describe, expect, it } from "vitest";
import { MemoryDb, Repositories } from "../../../src/index.js";

const namespace = { source: "codex", profileId: "default", userId: "audit-user", projectId: "audit-project" };

describe("topic decision audit metrics", () => {
  it("summarizes linked audit records without raw evidence or answers", () => {
    const db = new MemoryDb({ path: ":memory:" });
    const repos = new Repositories(db.db);
    repos.runtime.insertAudit({ userId: "audit-user", sessionId: "decision-session", actor: { namespace }, action: "topic_decision_snapshot_created", targetKind: "topic_decision_snapshot", targetId: "snap", meta: { round: 1, durationMs: 12 }, createdAt: "2026-01-01T00:00:00.000Z" });
    repos.runtime.insertAudit({ userId: "audit-user", sessionId: "decision-session", actor: { namespace }, action: "topic_decision_proposal_approved", targetKind: "topic_decision_proposal", targetId: "p", meta: { runId: "run", durationMs: 20 }, createdAt: "2026-01-01T00:00:01.000Z" });
    repos.runtime.insertAudit({ userId: "audit-user", sessionId: "decision-session", actor: { namespace }, action: "topic_decision_execution_started", targetKind: "topic_decision_execution", targetId: "run", meta: { proposalId: "p" }, createdAt: "2026-01-01T00:00:02.000Z" });
    repos.runtime.insertAudit({ userId: "audit-user", sessionId: "decision-session", actor: { namespace }, action: "topic_decision_execution_completed", targetKind: "topic_decision_execution", targetId: "run", meta: { proposalId: "p" }, createdAt: "2026-01-01T00:00:03.000Z" });
    const metrics = repos.runtime.topicDecisionMetrics("decision-session");
    expect(metrics).toMatchObject({ sessionId: "decision-session", snapshots: 1, proposalsApproved: 1, executionRuns: 1, totalDurationMs: 32 });
    const audits = repos.runtime.listAudit({ limit: 10 });
    expect(audits.every((audit) => JSON.stringify(audit.actor).includes("audit-project"))).toBe(true);
    expect(JSON.stringify({ metrics, audits })).not.toMatch(/secret answer|secret evidence|provider|prompt/);
    db.close();
  });
});
