import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import { MemoryDb, MemoryService, Repositories } from "../../../src/index.js";
import { loadMemmyConfig } from "../../../src/config/index.js";
import type { RuntimeNamespace, TopicActionEffect, TopicActionProposalRecord } from "../../../src/types.js";
import { nowIso } from "../../../src/utils/time.js";
import { stableHash } from "../../../src/utils/id.js";
import { namespaceIdFromContext } from "../../../src/service/namespace/namespace-scope.js";
import type { TopicActionHandler, TopicProposalAction, TopicExecutionContext, TopicActionOutcome } from "../../../src/service/topic-decision/proposal-executor.js";

const roots: string[] = [];

beforeEach(() => {
  process.env.MEMMY_TOPIC_DECISIONS_ENABLED = "true";
  process.env.MEMMY_TOPIC_DECISION_MODELS = "MiniMax-M2.5";
});

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

interface Setup {
  service: MemoryService;
  db: MemoryDb;
  repos: Repositories;
  namespaceId: string;
  namespace: RuntimeNamespace;
}

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "execution-test-"));
  roots.push(root);
  return root;
}

async function setup(): Promise<Setup> {
  const root = tempRoot();
  const configPath = join(root, "config.yaml");
  const dbPath = join(root, "memory.sqlite");
  writeFileSync(configPath, YAML.stringify({ memmyMemory: {} }));
  const { config } = loadMemmyConfig(configPath);
  const db = new MemoryDb({ path: dbPath });
  const repos = new Repositories(db.db);
  const namespace: RuntimeNamespace = { source: "test", profileId: "test-profile", userId: "user-1", projectId: "proj-1" };
  const namespaceId = namespaceIdFromContext(namespace)
  repos.topics.insertTopic({
    id: "topic-1",
    namespaceId,
    title: "Test Topic",
    summary: "Test",
    status: "active",
    version: 1,
    sourceMemoryIds: [],
    metadata: {},
    createdAt: nowIso(),
    updatedAt: nowIso()
  });
  const service = new MemoryService({ db, config, configPath, mode: "dev" });
  return { service, repos, db, namespaceId, namespace };
}

function setupSync(): { repos: Repositories; namespaceId: string } {
  const root = tempRoot();
  const dbPath = join(root, "memory.sqlite");
  const db = new MemoryDb({ path: dbPath });
  const repos = new Repositories(db.db);
  const namespace: RuntimeNamespace = { source: "test", profileId: "test-profile", userId: "user-1" };
  const namespaceId = namespaceIdFromContext(namespace)
  return { repos, namespaceId };
}

function insertProposal(
  repos: Repositories,
  namespaceId: string,
  sessionId: string,
  overrides: Partial<TopicActionProposalRecord> & { effect: TopicActionEffect }
): TopicActionProposalRecord {
  const now = nowIso();
  const proposal = repos.topicDecisions.insertProposal({
    id: overrides.id ?? `tdprop-${Math.random().toString(36).slice(2, 8)}`,
    namespaceId,
    sessionId,
    round: overrides.round ?? 0,
    rank: overrides.rank ?? 1,
    effect: overrides.effect,
    title: overrides.title ?? "Test proposal",
    payload: overrides.payload ?? {
      dependencies: [],
      actions: [
        {
          id: "action-1",
          effect: overrides.effect,
          target: "test-target",
          input: {},
          dependsOn: [],
          recoveryPoint: overrides.effect === "draft" || overrides.effect === "create_candidate_task" ? "pre-execution" : "pre",
          acceptanceCondition: "done"
        }
      ]
    },
    status: overrides.status ?? "draft",
    version: overrides.version ?? 1,
    metadata: overrides.metadata ?? {
      recommended: true,
      acceptanceCondition: "done",
      recoveryPoint: "pre-execution",
      artifact: "test-artifact",
      permission: "test"
    },
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now
  });
  markSessionReady(repos, namespaceId, sessionId);
  return proposal;
}

function markSessionReady(repos: Repositories, namespaceId: string, sessionId: string): void {
  const session = repos.topicDecisions.getSession(namespaceId, sessionId);
  if (!session || session.state === "ready_for_decision") {
    return;
  }
  repos.topicDecisions.updateSession(
    { ...session, state: "ready_for_decision", version: session.version + 1, updatedAt: nowIso() },
    session.version
  );
}

describe("approveProposal", () => {
  it("rejects when session not found", async () => {
    const { service, namespace } = await setup();
    await expect(
      service.approveProposal(namespace, "nonexistent-session", "prop-1", 1, { userId: "user-1" })
    ).rejects.toThrow(/not found/i);
  });

  it("rejects when proposal not found", async () => {
    const { service, repos, namespaceId, namespace } = await setup();
    const session = service.startTopicDecisionSession({ namespace, topicId: "topic-1" });
    markSessionReady(repos, namespaceId, session.session.id);
    await expect(
      service.approveProposal(namespace, session.session.id, "nonexistent-proposal", 1, { userId: "user-1" })
    ).rejects.toThrow(/not found/i);
  });

  it("rejects stale proposal version", async () => {
    const { service, repos, namespaceId, namespace } = await setup();
    const session = service.startTopicDecisionSession({ namespace, topicId: "topic-1" });
    const proposal = insertProposal(repos, namespaceId, session.session.id, {
      id: "tdprop-1",
      effect: "draft",
      version: 2
    });
    await expect(
      service.approveProposal(namespace, session.session.id, proposal.id, 1, { userId: "user-1" })
    ).rejects.toThrow(/version/i);
  });

  it("rejects non-recommended proposal", async () => {
    const { service, repos, namespaceId, namespace } = await setup();
    const session = service.startTopicDecisionSession({ namespace, topicId: "topic-1" });
    const proposal = insertProposal(repos, namespaceId, session.session.id, {
      id: "tdprop-1",
      effect: "draft",
      metadata: { recommended: false, acceptanceCondition: "done", recoveryPoint: "pre", artifact: "a", permission: "p" }
    });
    await expect(
      service.approveProposal(namespace, session.session.id, proposal.id, 1, { userId: "user-1" })
    ).rejects.toThrow(/recommended/i);
  });
  it("rolls back run and proposal when the session transition conflicts", async () => {
    const { service, repos, db, namespaceId, namespace } = await setup();
    const started = service.startTopicDecisionSession({ namespace, topicId: "topic-1" });
    const proposal = insertProposal(repos, namespaceId, started.session.id, {
      id: "tdprop-atomic",
      effect: "draft"
    });
    db.db.exec(`CREATE TRIGGER fail_topic_session_update BEFORE UPDATE ON project_topic_decision_sessions BEGIN SELECT RAISE(ABORT, 'topic decision session version conflict'); END`);

    await expect(
      service.approveProposal(namespace, started.session.id, proposal.id, proposal.version, { userId: "user-1" })
    ).rejects.toThrow(/session version conflict/i);
    expect(repos.topicDecisions.listExecutionRuns(namespaceId, started.session.id)).toEqual([]);
    expect(repos.topicDecisions.listProposals(namespaceId, started.session.id).find(item => item.id === proposal.id)?.status).toBe("draft");
  });

  it("rejects unknown effect at proposal insert (SQLite CHECK constraint)", () => {
    const { repos, namespaceId } = setupSync();
    expect(() =>
      insertProposal(repos, namespaceId, "session-1", {
        id: "tdprop-1",
        effect: "unknown_effect" as TopicActionEffect
      })
    ).toThrow();
  });

  it("executes automatic draft action and completes run", async () => {
    const { service, repos, namespaceId, namespace } = await setup();
    const session = service.startTopicDecisionSession({ namespace, topicId: "topic-1" });
    const proposal = insertProposal(repos, namespaceId, session.session.id, {
      id: "tdprop-1",
      effect: "draft"
    });
    const run = await service.approveProposal(namespace, session.session.id, proposal.id, 1, { userId: "user-1" });
    expect(run.status).toBe("completed");
    expect(repos.topicDecisions.getSession(namespaceId, session.session.id)?.state).toBe("completed");
    const result = run.result as any;
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0].status).toBe("succeeded");
  });

  it("pauses at confirmation-required action with awaiting_confirmation", async () => {
    const { service, repos, namespaceId, namespace } = await setup();
    const session = service.startTopicDecisionSession({ namespace, topicId: "topic-1" });
    const proposal = insertProposal(repos, namespaceId, session.session.id, {
      id: "tdprop-1",
      effect: "authoritative_write"
    });
    const run = await service.approveProposal(namespace, session.session.id, proposal.id, 1, { userId: "user-1" });
    expect(run.status).toBe("awaiting_confirmation");
    expect(run.result.pendingAction).toBeDefined();
  });

  it("executes automatic create_candidate_task action", async () => {
    const { service, repos, namespaceId, namespace } = await setup();
    const session = service.startTopicDecisionSession({ namespace, topicId: "topic-1" });
    const proposal = insertProposal(repos, namespaceId, session.session.id, {
      id: "tdprop-1",
      effect: "create_candidate_task",
      payload: {
        dependencies: [],
        actions: [
          {
            id: "action-1",
            effect: "create_candidate_task",
            target: "work-item",
            input: {
              title: "Test task",
              summary: "Test summary",
              nextStep: "Do something"
            },
            dependsOn: [],
            recoveryPoint: "pre-execution",
            acceptanceCondition: "work item created"
          }
        ]
      }
    });
    const run = await service.approveProposal(namespace, session.session.id, proposal.id, 1, { userId: "user-1" });
    expect(run.status).toBe("completed");
    const projectNamespaceId = namespaceIdFromContext(namespace);
    const workItems = repos.projectContext.listWorkItems(projectNamespaceId);
    expect(workItems).toHaveLength(1);
    expect(workItems[0]!.status).toBe("pending");
    expect(workItems[0]!.focused).toBe(false);
    expect(workItems[0]!.provenance.topicProposalId).toBe(proposal.id);
    expect(workItems[0]!.provenance.topicSessionId).toBe(session.session.id);
  });
});

describe("confirmExecutionAction", () => {
  it("rejects confirmation for different namespace", async () => {
    const { service, repos, namespaceId, namespace } = await setup();
    const session = service.startTopicDecisionSession({ namespace, topicId: "topic-1" });
    const proposal = insertProposal(repos, namespaceId, session.session.id, {
      id: "tdprop-1",
      effect: "authoritative_write"
    });
    const run = await service.approveProposal(namespace, session.session.id, proposal.id, 1, { userId: "user-1" });
    const otherNamespace: RuntimeNamespace = { source: "test", profileId: "other-profile", userId: "user-2" };
    await expect(
      service.confirmExecutionAction(otherNamespace, run.id, "action-1", 1, true, { userId: "user-2" }, "key-1")
    ).rejects.toThrow(/namespace|not found/i);
  });

  it("rejects confirmation for different action", async () => {
    const { service, repos, namespaceId, namespace } = await setup();
    const session = service.startTopicDecisionSession({ namespace, topicId: "topic-1" });
    const proposal = insertProposal(repos, namespaceId, session.session.id, {
      id: "tdprop-1",
      effect: "authoritative_write"
    });
    const run = await service.approveProposal(namespace, session.session.id, proposal.id, 1, { userId: "user-1" });
    await expect(
      service.confirmExecutionAction(namespace, run.id, "wrong-action-id", run.version, true, { userId: "user-1" }, "key-1")
    ).rejects.toThrow(/action not pending confirmation/i);
  });

  it("rejects stale run version", async () => {
    const { service, repos, namespaceId, namespace } = await setup();
    const session = service.startTopicDecisionSession({ namespace, topicId: "topic-1" });
    const proposal = insertProposal(repos, namespaceId, session.session.id, {
      id: "tdprop-1",
      effect: "authoritative_write"
    });
    const run = await service.approveProposal(namespace, session.session.id, proposal.id, 1, { userId: "user-1" });
    await expect(
      service.confirmExecutionAction(namespace, run.id, "action-1", 0, true, { userId: "user-1" }, "key-1")
    ).rejects.toThrow(/version/i);
  });

  it("cancels run on rejection", async () => {
    const { service, repos, namespaceId, namespace } = await setup();
    const session = service.startTopicDecisionSession({ namespace, topicId: "topic-1" });
    const proposal = insertProposal(repos, namespaceId, session.session.id, {
      id: "tdprop-1",
      effect: "authoritative_write"
    });
    const run = await service.approveProposal(namespace, session.session.id, proposal.id, 1, { userId: "user-1" });
    const updated = await service.confirmExecutionAction(namespace, run.id, "action-1", run.version, false, { userId: "user-1" }, "key-1");
    expect(updated.status).toBe("cancelled");
    expect(repos.topicDecisions.getSession(namespaceId, session.session.id)?.state).toBe("cancelled");
  });
});

describe("execution idempotency and dependency order", () => {
  it("does not repeat successful actions on resume", async () => {
    const { service, repos, namespaceId, namespace } = await setup();
    const session = service.startTopicDecisionSession({ namespace, topicId: "topic-1" });
    const executeSpy = vi.fn().mockResolvedValue({ status: "succeeded", output: { data: "test" } } satisfies TopicActionOutcome);
    const handler: TopicActionHandler = {
      effect: "draft",
      execute: executeSpy
    };
    service.registerActionHandler(handler);
    const proposal = insertProposal(repos, namespaceId, session.session.id, {
      id: "tdprop-1",
      effect: "draft"
    });
    const run1 = await service.approveProposal(namespace, session.session.id, proposal.id, 1, { userId: "user-1" });
    const run2 = await service.resumeExecution(namespace, run1.id);
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(run2.status).toBe("completed");
  });

  it("executes actions in dependency order", async () => {
    const { service, repos, namespaceId, namespace } = await setup();
    const session = service.startTopicDecisionSession({ namespace, topicId: "topic-1" });
    const executionOrder: string[] = [];
    const handler: TopicActionHandler = {
      effect: "draft",
      execute: async (action: TopicProposalAction) => {
        executionOrder.push(action.id);
        return { status: "succeeded", output: {} };
      }
    };
    service.registerActionHandler(handler);
    const proposal = insertProposal(repos, namespaceId, session.session.id, {
      id: "tdprop-1",
      effect: "draft",
      payload: {
        dependencies: [],
        actions: [
          { id: "action-b", effect: "draft", target: "t", input: {}, dependsOn: ["action-a"], recoveryPoint: "pre", acceptanceCondition: "done" },
          { id: "action-a", effect: "draft", target: "t", input: {}, dependsOn: [], recoveryPoint: "pre", acceptanceCondition: "done" },
          { id: "action-c", effect: "draft", target: "t", input: {}, dependsOn: ["action-b"], recoveryPoint: "pre", acceptanceCondition: "done" }
        ]
      }
    });
    const run = await service.approveProposal(namespace, session.session.id, proposal.id, 1, { userId: "user-1" });
    expect(executionOrder).toEqual(["action-a", "action-b", "action-c"]);
    expect(run.status).toBe("completed");
  });

  it("fails run on action failure without claiming success", async () => {
    const { service, repos, namespaceId, namespace } = await setup();
    const session = service.startTopicDecisionSession({ namespace, topicId: "topic-1" });
    const handler: TopicActionHandler = {
      effect: "draft",
      execute: async () => ({ status: "failed", error: "handler error" })
    };
    service.registerActionHandler(handler);
    const proposal = insertProposal(repos, namespaceId, session.session.id, {
      id: "tdprop-1",
      effect: "draft"
    });
    const run = await service.approveProposal(namespace, session.session.id, proposal.id, 1, { userId: "user-1" });
    expect(run.status).toBe("failed");
    expect(repos.topicDecisions.getSession(namespaceId, session.session.id)?.state).toBe("failed");
    const result = run.result as any;
    expect(result.actions[0].status).toBe("failed");
  });

  it("stops pending actions when snapshot is stale", async () => {
    const { service, repos, namespaceId, namespace } = await setup();
    const session = service.startTopicDecisionSession({ namespace, topicId: "topic-1" });
    const proposal = insertProposal(repos, namespaceId, session.session.id, {
      id: "tdprop-1",
      effect: "draft",
      payload: {
        dependencies: [],
        actions: [
          { id: "action-a", effect: "draft", target: "t", input: {}, dependsOn: [], recoveryPoint: "pre", acceptanceCondition: "done" },
          { id: "action-b", effect: "draft", target: "t", input: {}, dependsOn: ["action-a"], recoveryPoint: "pre", acceptanceCondition: "done" }
        ]
      }
    });
    const run = await service.approveProposal(namespace, session.session.id, proposal.id, 1, { userId: "user-1" });
    // Mark session as stale
    const currentSession = repos.topicDecisions.getSession(namespaceId, session.session.id)!;
    repos.topicDecisions.updateSession({ ...currentSession, state: "stale", version: currentSession.version + 1, updatedAt: nowIso() }, currentSession.version);
    const resumed = await service.resumeExecution(namespace, run.id);
    expect(resumed.status).toBe("failed");
    expect(resumed.result.error).toMatch(/stale/i);
  });
});

describe("irreversible two-confirmation flow", () => {
  it("first confirmation does not invoke handler; second does", async () => {
    const { service, repos, namespaceId, namespace } = await setup();
    const session = service.startTopicDecisionSession({ namespace, topicId: "topic-1" });
    const executeSpy = vi.fn().mockResolvedValue({ status: "succeeded", output: { data: "deleted" } } satisfies TopicActionOutcome);
    service.registerActionHandler({ effect: "delete", execute: executeSpy });
    const proposal = insertProposal(repos, namespaceId, session.session.id, {
      id: "tdprop-1",
      effect: "delete",
      payload: {
        dependencies: [],
        actions: [
          {
            id: "action-1",
            effect: "delete",
            target: "topic-1",
            input: {},
            dependsOn: [],
            recoveryPoint: "pre",
            acceptanceCondition: "deleted"
          }
        ]
      }
    });
    const run = await service.approveProposal(namespace, session.session.id, proposal.id, 1, { userId: "user-1" });
    expect(run.status).toBe("awaiting_confirmation");
    expect(executeSpy).not.toHaveBeenCalled();

    // First confirmation: handler still not invoked
    const afterFirst = await service.confirmExecutionAction(namespace, run.id, "action-1", run.version, true, { userId: "user-1" }, "key-1");
    expect(afterFirst.status).toBe("awaiting_second_confirmation");
    expect(executeSpy).not.toHaveBeenCalled();

    // Second confirmation: handler invoked
    const afterSecond = await service.confirmExecutionAction(namespace, afterFirst.id, "action-1", afterFirst.version, true, { userId: "user-1" }, "key-2");
    expect(afterSecond.status).toBe("completed");
    expect(executeSpy).toHaveBeenCalledTimes(1);
  });

  it("replay of first confirmation does not count twice", async () => {
    const { service, repos, namespaceId, namespace } = await setup();
    const session = service.startTopicDecisionSession({ namespace, topicId: "topic-1" });
    const executeSpy = vi.fn().mockResolvedValue({ status: "succeeded", output: {} } satisfies TopicActionOutcome);
    service.registerActionHandler({ effect: "delete", execute: executeSpy });
    const proposal = insertProposal(repos, namespaceId, session.session.id, {
      id: "tdprop-1",
      effect: "delete",
      payload: {
        dependencies: [],
        actions: [
          {
            id: "action-1",
            effect: "delete",
            target: "topic-1",
            input: {},
            dependsOn: [],
            recoveryPoint: "pre",
            acceptanceCondition: "deleted"
          }
        ]
      }
    });
    const run = await service.approveProposal(namespace, session.session.id, proposal.id, 1, { userId: "user-1" });

    // First confirmation
    const afterFirst = await service.confirmExecutionAction(namespace, run.id, "action-1", run.version, true, { userId: "user-1" }, "key-1");
    expect(afterFirst.status).toBe("awaiting_second_confirmation");

    // Replay same idempotency key: must be no-op
    const replay = await service.confirmExecutionAction(namespace, afterFirst.id, "action-1", afterFirst.version, true, { userId: "user-1" }, "key-1");
    expect(replay.status).toBe("awaiting_second_confirmation");
    expect(replay.version).toBe(afterFirst.version);
    expect(executeSpy).not.toHaveBeenCalled();

    // Second confirmation with different key: handler invoked
    const afterSecond = await service.confirmExecutionAction(namespace, replay.id, "action-1", replay.version, true, { userId: "user-1" }, "key-2");
    expect(afterSecond.status).toBe("completed");
    expect(executeSpy).toHaveBeenCalledTimes(1);
  });

  it("persisted provenance has two events with ordinals", async () => {
    const { service, repos, namespaceId, namespace } = await setup();
    const session = service.startTopicDecisionSession({ namespace, topicId: "topic-1" });
    service.registerActionHandler({ effect: "delete", execute: async () => ({ status: "succeeded", output: {} }) });
    const proposal = insertProposal(repos, namespaceId, session.session.id, {
      id: "tdprop-1",
      effect: "delete",
      payload: {
        dependencies: [],
        actions: [
          {
            id: "action-1",
            effect: "delete",
            target: "topic-1",
            input: {},
            dependsOn: [],
            recoveryPoint: "pre",
            acceptanceCondition: "deleted"
          }
        ]
      }
    });
    const run = await service.approveProposal(namespace, session.session.id, proposal.id, 1, { userId: "user-1" });
    const afterFirst = await service.confirmExecutionAction(namespace, run.id, "action-1", run.version, true, { userId: "user-1" }, "key-1");
    const afterSecond = await service.confirmExecutionAction(namespace, afterFirst.id, "action-1", afterFirst.version, true, { userId: "user-1" }, "key-2");

    const result = afterSecond.result as any;
    const actionResult = result.actions.find((a: any) => a.id === "action-1");
    expect(actionResult.confirmationEvents).toHaveLength(2);
    expect(actionResult.confirmationEvents[0].ordinal).toBe(1);
    expect(actionResult.confirmationEvents[0].actor).toEqual({ userId: "user-1" });
    expect(actionResult.confirmationEvents[0].actionId).toBe("action-1");
    expect(actionResult.confirmationEvents[0].idempotencyKey).toBe("key-1");
    expect(actionResult.confirmationEvents[0].eventId).toMatch(/^tdconf[_-]/);
    expect(actionResult.confirmationEvents[1].ordinal).toBe(2);
    expect(actionResult.confirmationEvents[1].idempotencyKey).toBe("key-2");
  });

  it("rejection after first confirmation cancels the run", async () => {
    const { service, repos, namespaceId, namespace } = await setup();
    const session = service.startTopicDecisionSession({ namespace, topicId: "topic-1" });
    const executeSpy = vi.fn().mockResolvedValue({ status: "succeeded", output: {} } satisfies TopicActionOutcome);
    service.registerActionHandler({ effect: "delete", execute: executeSpy });
    const proposal = insertProposal(repos, namespaceId, session.session.id, {
      id: "tdprop-1",
      effect: "delete",
      payload: {
        dependencies: [],
        actions: [
          {
            id: "action-1",
            effect: "delete",
            target: "topic-1",
            input: {},
            dependsOn: [],
            recoveryPoint: "pre",
            acceptanceCondition: "deleted"
          }
        ]
      }
    });
    const run = await service.approveProposal(namespace, session.session.id, proposal.id, 1, { userId: "user-1" });
    const afterFirst = await service.confirmExecutionAction(namespace, run.id, "action-1", run.version, true, { userId: "user-1" }, "key-1");
    expect(afterFirst.status).toBe("awaiting_second_confirmation");

    // Reject at second stage
    const cancelled = await service.confirmExecutionAction(namespace, afterFirst.id, "action-1", afterFirst.version, false, { userId: "user-1" }, "key-reject");
    expect(cancelled.status).toBe("cancelled");
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it("rejection at first confirmation cancels the run", async () => {
    const { service, repos, namespaceId, namespace } = await setup();
    const session = service.startTopicDecisionSession({ namespace, topicId: "topic-1" });
    const executeSpy = vi.fn().mockResolvedValue({ status: "succeeded", output: {} } satisfies TopicActionOutcome);
    service.registerActionHandler({ effect: "delete", execute: executeSpy });
    const proposal = insertProposal(repos, namespaceId, session.session.id, {
      id: "tdprop-1",
      effect: "delete",
      payload: {
        dependencies: [],
        actions: [
          {
            id: "action-1",
            effect: "delete",
            target: "topic-1",
            input: {},
            dependsOn: [],
            recoveryPoint: "pre",
            acceptanceCondition: "deleted"
          }
        ]
      }
    });
    const run = await service.approveProposal(namespace, session.session.id, proposal.id, 1, { userId: "user-1" });
    const cancelled = await service.confirmExecutionAction(namespace, run.id, "action-1", run.version, false, { userId: "user-1" }, "key-reject");
    expect(cancelled.status).toBe("cancelled");
    expect(executeSpy).not.toHaveBeenCalled();
  });
});
