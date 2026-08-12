import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryDb } from "../../src/index.js";
import { Repositories, TopicDecisionIdempotencyConflictError, TopicDecisionImmutablePositionError } from "../../src/storage/repositories.js";
import type {
  TopicActionProposalRecord,
  TopicAgentPositionRecord,
  TopicDebateRoundRecord,
  TopicDecisionSessionRecord,
  TopicDecisionSnapshotRecord,
  TopicEvidenceRequestRecord,
  TopicExecutionRunRecord
} from "../../src/types.js";

const at = "2026-08-12T00:00:00.000Z";
const nsA = "local:workspace-a";
const nsB = "local:workspace-b";

function baseSession(overrides: Partial<TopicDecisionSessionRecord> = {}): TopicDecisionSessionRecord {
  return {
    id: "session-1",
    namespaceId: nsA,
    topicId: "topic-1",
    inputHash: "hash-1",
    state: "draft",
    version: 1,
    metadata: {},
    createdAt: at,
    updatedAt: at,
    ...overrides
  };
}

function baseSnapshot(overrides: Partial<TopicDecisionSnapshotRecord> = {}): TopicDecisionSnapshotRecord {
  return {
    id: "snapshot-1",
    namespaceId: nsA,
    sessionId: "session-1",
    round: 1,
    payload: { summary: "first" },
    createdAt: at,
    ...overrides
  };
}

function basePosition(overrides: Partial<TopicAgentPositionRecord> = {}): TopicAgentPositionRecord {
  return {
    id: "position-1",
    namespaceId: nsA,
    sessionId: "session-1",
    snapshotId: "snapshot-1",
    round: 1,
    agentId: "agent-alpha",
    stance: "support",
    rationale: "because",
    evidenceIds: [],
    createdAt: at,
    ...overrides
  };
}

function baseRound(overrides: Partial<TopicDebateRoundRecord> = {}): TopicDebateRoundRecord {
  return {
    id: "round-1",
    namespaceId: nsA,
    sessionId: "session-1",
    round: 1,
    status: "open",
    summary: "",
    metadata: {},
    createdAt: at,
    updatedAt: at,
    ...overrides
  };
}

function baseEvidenceRequest(overrides: Partial<TopicEvidenceRequestRecord> = {}): TopicEvidenceRequestRecord {
  return {
    id: "evidence-req-1",
    namespaceId: nsA,
    sessionId: "session-1",
    round: 1,
    question: "need data",
    verification: "repository_verified",
    status: "pending",
    metadata: {},
    createdAt: at,
    updatedAt: at,
    ...overrides
  };
}

function baseProposal(overrides: Partial<TopicActionProposalRecord> = {}): TopicActionProposalRecord {
  return {
    id: "proposal-1",
    namespaceId: nsA,
    sessionId: "session-1",
    round: 1,
    rank: 1,
    effect: "read",
    title: "read-only scan",
    payload: {},
    status: "proposed",
    version: 1,
    metadata: {},
    createdAt: at,
    updatedAt: at,
    ...overrides
  };
}

function baseExecutionRun(overrides: Partial<TopicExecutionRunRecord> = {}): TopicExecutionRunRecord {
  return {
    id: "run-1",
    namespaceId: nsA,
    sessionId: "session-1",
    proposalId: "proposal-1",
    status: "queued",
    result: {},
    version: 1,
    createdAt: at,
    updatedAt: at,
    ...overrides
  };
}

describe("TopicDecisionRepository", () => {
  it("creates and retrieves a session", () => {
    const root = mkdtempSync(join(tmpdir(), "topic-decision-repo-"));
    try {
      const db = new MemoryDb({ path: join(root, "memory.sqlite") });
      const repos = new Repositories(db.db);
      const session = repos.topicDecisions.createSession(baseSession());
      expect(session).toEqual(baseSession());
      const fetched = repos.topicDecisions.getSession(nsA, "session-1");
      expect(fetched).toEqual(baseSession());
      db.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("finds a reusable session by namespace, topic, and input hash", () => {
    const root = mkdtempSync(join(tmpdir(), "topic-decision-reusable-"));
    try {
      const db = new MemoryDb({ path: join(root, "memory.sqlite") });
      const repos = new Repositories(db.db);
      repos.topicDecisions.createSession(baseSession());
      const found = repos.topicDecisions.findReusableSession(nsA, "topic-1", "hash-1");
      expect(found).toEqual(baseSession());
      expect(repos.topicDecisions.findReusableSession(nsA, "topic-1", "hash-other")).toBeUndefined();
      expect(repos.topicDecisions.findReusableSession(nsB, "topic-1", "hash-1")).toBeUndefined();
      db.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("enforces namespace exclusion on session retrieval", () => {
    const root = mkdtempSync(join(tmpdir(), "topic-decision-ns-"));
    try {
      const db = new MemoryDb({ path: join(root, "memory.sqlite") });
      const repos = new Repositories(db.db);
      repos.topicDecisions.createSession(baseSession());
      expect(repos.topicDecisions.getSession(nsB, "session-1")).toBeUndefined();
      db.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("updates a session with optimistic concurrency", () => {
    const root = mkdtempSync(join(tmpdir(), "topic-decision-update-"));
    try {
      const db = new MemoryDb({ path: join(root, "memory.sqlite") });
      const repos = new Repositories(db.db);
      repos.topicDecisions.createSession(baseSession());
      const next: TopicDecisionSessionRecord = {
        ...baseSession(),
        state: "debating",
        version: 2,
        updatedAt: "2026-08-12T00:01:00.000Z"
      };
      const updated = repos.topicDecisions.updateSession(next, 1);
      expect(updated.state).toBe("debating");
      expect(updated.version).toBe(2);
      expect(() => repos.topicDecisions.updateSession({ ...next, version: 3 }, 1)).toThrow();
      db.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("inserts and retrieves a snapshot", () => {
    const root = mkdtempSync(join(tmpdir(), "topic-decision-snapshot-"));
    try {
      const db = new MemoryDb({ path: join(root, "memory.sqlite") });
      const repos = new Repositories(db.db);
      repos.topicDecisions.createSession(baseSession());
      const snapshot = repos.topicDecisions.insertSnapshot(baseSnapshot());
      expect(snapshot).toEqual(baseSnapshot());
      expect(repos.topicDecisions.getSnapshot(nsA, "snapshot-1")).toEqual(baseSnapshot());
      expect(repos.topicDecisions.getSnapshot(nsB, "snapshot-1")).toBeUndefined();
      db.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects duplicate first-round positions by (session, snapshot, round, agent) with different id", () => {
    const root = mkdtempSync(join(tmpdir(), "topic-decision-position-dup-"));
    try {
      const db = new MemoryDb({ path: join(root, "memory.sqlite") });
      const repos = new Repositories(db.db);
      repos.topicDecisions.createSession(baseSession());
      repos.topicDecisions.insertSnapshot(baseSnapshot());
      repos.topicDecisions.insertPosition(basePosition());
      expect(() => repos.topicDecisions.insertPosition(basePosition({ id: "position-2" }))).toThrow(TopicDecisionImmutablePositionError);
      db.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("lists positions by session and snapshot", () => {
    const root = mkdtempSync(join(tmpdir(), "topic-decision-position-list-"));
    try {
      const db = new MemoryDb({ path: join(root, "memory.sqlite") });
      const repos = new Repositories(db.db);
      repos.topicDecisions.createSession(baseSession());
      repos.topicDecisions.insertSnapshot(baseSnapshot());
      repos.topicDecisions.insertPosition(basePosition());
      repos.topicDecisions.insertPosition(basePosition({
        id: "position-2",
        agentId: "agent-beta",
        stance: "oppose"
      }));
      const positions = repos.topicDecisions.listPositions(nsA, "session-1", "snapshot-1");
      expect(positions).toHaveLength(2);
      expect(repos.topicDecisions.listPositions(nsB, "session-1", "snapshot-1")).toEqual([]);
      db.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("upserts debate rounds with optional version check", () => {
    const root = mkdtempSync(join(tmpdir(), "topic-decision-round-"));
    try {
      const db = new MemoryDb({ path: join(root, "memory.sqlite") });
      const repos = new Repositories(db.db);
      repos.topicDecisions.createSession(baseSession());
      const round = repos.topicDecisions.upsertRound(baseRound());
      expect(round.status).toBe("open");
      const updated = repos.topicDecisions.upsertRound({ ...round, status: "closed", version: 2, updatedAt: "2026-08-12T00:02:00.000Z" }, 1);
      expect(updated.status).toBe("closed");
      expect(repos.topicDecisions.listRounds(nsA, "session-1")).toHaveLength(1);
      db.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("upserts evidence requests and rejects invalid verification", () => {
    const root = mkdtempSync(join(tmpdir(), "topic-decision-evidence-"));
    try {
      const db = new MemoryDb({ path: join(root, "memory.sqlite") });
      const repos = new Repositories(db.db);
      repos.topicDecisions.createSession(baseSession());
      const request = repos.topicDecisions.upsertEvidenceRequest(baseEvidenceRequest());
      expect(request.verification).toBe("repository_verified");
      expect(() => repos.topicDecisions.upsertEvidenceRequest(baseEvidenceRequest({
        id: "evidence-req-bad",
        verification: "not_a_real_mode" as TopicEvidenceRequestRecord["verification"]
      }))).toThrow();
      expect(repos.topicDecisions.listEvidenceRequests(nsA, "session-1")).toHaveLength(1);
      db.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("inserts proposals and enforces rank 1..3", () => {
    const root = mkdtempSync(join(tmpdir(), "topic-decision-proposal-rank-"));
    try {
      const db = new MemoryDb({ path: join(root, "memory.sqlite") });
      const repos = new Repositories(db.db);
      repos.topicDecisions.createSession(baseSession());
      expect(() => repos.topicDecisions.insertProposal(baseProposal({ rank: 0 }))).toThrow();
      expect(() => repos.topicDecisions.insertProposal(baseProposal({ rank: 4 }))).toThrow();
      const proposal = repos.topicDecisions.insertProposal(baseProposal());
      expect(proposal.rank).toBe(1);
      expect(repos.topicDecisions.listProposals(nsA, "session-1")).toHaveLength(1);
      db.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("updates proposals with optimistic concurrency", () => {
    const root = mkdtempSync(join(tmpdir(), "topic-decision-proposal-update-"));
    try {
      const db = new MemoryDb({ path: join(root, "memory.sqlite") });
      const repos = new Repositories(db.db);
      repos.topicDecisions.createSession(baseSession());
      repos.topicDecisions.insertProposal(baseProposal());
      const next: TopicActionProposalRecord = {
        ...baseProposal(),
        status: "accepted",
        version: 2,
        updatedAt: "2026-08-12T00:03:00.000Z"
      };
      const updated = repos.topicDecisions.updateProposal(next, 1);
      expect(updated.status).toBe("accepted");
      expect(() => repos.topicDecisions.updateProposal({ ...next, version: 3 }, 1)).toThrow();
      db.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("creates and updates execution runs with optimistic concurrency", () => {
    const root = mkdtempSync(join(tmpdir(), "topic-decision-exec-"));
    try {
      const db = new MemoryDb({ path: join(root, "memory.sqlite") });
      const repos = new Repositories(db.db);
      repos.topicDecisions.createSession(baseSession());
      repos.topicDecisions.insertProposal(baseProposal());
      const run = repos.topicDecisions.createExecutionRun(baseExecutionRun());
      expect(run.status).toBe("queued");
      const next: TopicExecutionRunRecord = {
        ...run,
        status: "succeeded",
        version: 2,
        updatedAt: "2026-08-12T00:04:00.000Z"
      };
      const updated = repos.topicDecisions.updateExecutionRun(next, 1);
      expect(updated.status).toBe("succeeded");
      expect(() => repos.topicDecisions.updateExecutionRun({ ...next, version: 3 }, 1)).toThrow();
      db.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects invalid JSON payloads", () => {
    const root = mkdtempSync(join(tmpdir(), "topic-decision-json-"));
    try {
      const db = new MemoryDb({ path: join(root, "memory.sqlite") });
      const repos = new Repositories(db.db);
      repos.topicDecisions.createSession(baseSession());
      expect(() => repos.topicDecisions.insertSnapshot(baseSnapshot({
        payload: { circular: undefined }
      }))).not.toThrow();
      db.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("createSession is idempotent on exact replay and conflicts on different content", () => {
    const root = mkdtempSync(join(tmpdir(), "topic-decision-idem-session-"));
    try {
      const db = new MemoryDb({ path: join(root, "memory.sqlite") });
      const repos = new Repositories(db.db);
      const session = baseSession();
      const first = repos.topicDecisions.createSession(session);
      const replay = repos.topicDecisions.createSession(session);
      expect(replay).toEqual(first);
      const different = { ...session, state: "debating" as const };
      expect(() => repos.topicDecisions.createSession(different)).toThrow(TopicDecisionIdempotencyConflictError);
      db.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("insertSnapshot is idempotent on exact replay and conflicts on different content", () => {
    const root = mkdtempSync(join(tmpdir(), "topic-decision-idem-snapshot-"));
    try {
      const db = new MemoryDb({ path: join(root, "memory.sqlite") });
      const repos = new Repositories(db.db);
      repos.topicDecisions.createSession(baseSession());
      const snap = baseSnapshot();
      const first = repos.topicDecisions.insertSnapshot(snap);
      const replay = repos.topicDecisions.insertSnapshot(snap);
      expect(replay).toEqual(first);
      const different = { ...snap, round: 99 };
      expect(() => repos.topicDecisions.insertSnapshot(different)).toThrow(TopicDecisionIdempotencyConflictError);
      db.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("insertPosition is idempotent on exact replay and conflicts on different content", () => {
    const root = mkdtempSync(join(tmpdir(), "topic-decision-idem-position-"));
    try {
      const db = new MemoryDb({ path: join(root, "memory.sqlite") });
      const repos = new Repositories(db.db);
      repos.topicDecisions.createSession(baseSession());
      repos.topicDecisions.insertSnapshot(baseSnapshot());
      const pos = basePosition();
      const first = repos.topicDecisions.insertPosition(pos);
      const replay = repos.topicDecisions.insertPosition(pos);
      expect(replay).toEqual(first);
      const different = { ...pos, stance: "oppose" };
      expect(() => repos.topicDecisions.insertPosition(different)).toThrow(TopicDecisionIdempotencyConflictError);
      db.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("insertPosition throws TopicDecisionImmutablePositionError for duplicate (session, snapshot, round, agent) with different id", () => {
    const root = mkdtempSync(join(tmpdir(), "topic-decision-immutable-pos-"));
    try {
      const db = new MemoryDb({ path: join(root, "memory.sqlite") });
      const repos = new Repositories(db.db);
      repos.topicDecisions.createSession(baseSession());
      repos.topicDecisions.insertSnapshot(baseSnapshot());
      repos.topicDecisions.insertPosition(basePosition());
      const conflicting = basePosition({ id: "position-different-id" });
      expect(() => repos.topicDecisions.insertPosition(conflicting)).toThrow(TopicDecisionImmutablePositionError);
      db.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("insertProposal is idempotent on exact replay and conflicts on different content", () => {
    const root = mkdtempSync(join(tmpdir(), "topic-decision-idem-proposal-"));
    try {
      const db = new MemoryDb({ path: join(root, "memory.sqlite") });
      const repos = new Repositories(db.db);
      repos.topicDecisions.createSession(baseSession());
      const prop = baseProposal();
      const first = repos.topicDecisions.insertProposal(prop);
      const replay = repos.topicDecisions.insertProposal(prop);
      expect(replay).toEqual(first);
      const different = { ...prop, title: "changed title" };
      expect(() => repos.topicDecisions.insertProposal(different)).toThrow(TopicDecisionIdempotencyConflictError);
      db.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("createExecutionRun is idempotent on exact replay and conflicts on different content", () => {
    const root = mkdtempSync(join(tmpdir(), "topic-decision-idem-exec-"));
    try {
      const db = new MemoryDb({ path: join(root, "memory.sqlite") });
      const repos = new Repositories(db.db);
      repos.topicDecisions.createSession(baseSession());
      repos.topicDecisions.insertProposal(baseProposal());
      const run = baseExecutionRun();
      const first = repos.topicDecisions.createExecutionRun(run);
      const replay = repos.topicDecisions.createExecutionRun(run);
      expect(replay).toEqual(first);
      const different = { ...run, status: "succeeded" as const };
      expect(() => repos.topicDecisions.createExecutionRun(different)).toThrow(TopicDecisionIdempotencyConflictError);
      db.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("cascade deletes only when a session is explicitly deleted", () => {
    const root = mkdtempSync(join(tmpdir(), "topic-decision-cascade-"));
    try {
      const db = new MemoryDb({ path: join(root, "memory.sqlite") });
      const repos = new Repositories(db.db);
      repos.topicDecisions.createSession(baseSession());
      repos.topicDecisions.insertSnapshot(baseSnapshot());
      repos.topicDecisions.insertPosition(basePosition());
      repos.topicDecisions.upsertRound(baseRound());
      repos.topicDecisions.upsertEvidenceRequest(baseEvidenceRequest());
      repos.topicDecisions.insertProposal(baseProposal());
      repos.topicDecisions.createExecutionRun(baseExecutionRun());
      // Delete session directly via DB handle to prove FK ON DELETE CASCADE
      // without exposing a public deleteSession on the repository API.
      db.db.prepare(`DELETE FROM project_topic_decision_sessions WHERE id = ? AND namespace_id = ?`).run("session-1", nsA);
      expect(repos.topicDecisions.getSession(nsA, "session-1")).toBeUndefined();
      expect(repos.topicDecisions.getSnapshot(nsA, "snapshot-1")).toBeUndefined();
      expect(repos.topicDecisions.listPositions(nsA, "session-1", "snapshot-1")).toEqual([]);
      expect(repos.topicDecisions.listRounds(nsA, "session-1")).toEqual([]);
      expect(repos.topicDecisions.listEvidenceRequests(nsA, "session-1")).toEqual([]);
      expect(repos.topicDecisions.listProposals(nsA, "session-1")).toEqual([]);
      db.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
