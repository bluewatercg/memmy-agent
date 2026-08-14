import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryDb, MemoryService, Repositories } from "../../../src/index.js";
import { loadMemmyConfig } from "../../../src/config/index.js";
import type { RuntimeNamespace, TopicActionProposalRecord, TopicDecisionState } from "../../../src/types.js";
import { namespaceIdFromContext } from "../../../src/service/namespace/namespace-scope.js";
import { nowIso } from "../../../src/utils/time.js";

const roots: string[] = [];

beforeEach(() => {
  process.env.MEMMY_TOPIC_DECISIONS_ENABLED = "true";
  process.env.MEMMY_TOPIC_DECISION_MODELS = "MiniMax-M2.5";
});

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("topic decision transition guards", () => {
  it.each<TopicDecisionState>(["completed", "failed", "cancelled", "stale", "executing"])(
    "rejects analysis mutations for a %s session",
    async (state) => {
      const { service, repos, namespace, namespaceId } = setup();
      const started = service.startTopicDecisionSession({ namespace, topicId: "topic-1" });
      setSessionState(repos, namespaceId, started.session.id, state);

      await expect(service.runTopicDecision(namespace, started.session.id)).rejects.toThrow(/state/i);
      await expect(service.runDebate(namespace, started.session.id)).rejects.toThrow(/state/i);
      await expect(service.synthesizeProposals(namespace, started.session.id)).rejects.toThrow(/state/i);
    }
  );

  it.each<TopicDecisionState>(["completed", "failed", "cancelled", "stale", "executing"])(
    "rejects evidence answers for a %s session without persisting them",
    async (state) => {
      const { service, repos, namespace, namespaceId } = setup();
      const started = service.startTopicDecisionSession({ namespace, topicId: "topic-1" });
      const session = setSessionState(repos, namespaceId, started.session.id, state);

      await expect(service.submitEvidenceAnswers(namespace, session.id, session.version, [
        { questionKey: "blocked-question", answer: "must not persist", source: "user_preference" }
      ])).rejects.toThrow(/state/i);
      expect(repos.topicDecisions.listEvidenceRequests(namespaceId, session.id)).toEqual([]);
    }
  );

  it.each<TopicDecisionState>(["draft", "completed", "failed", "cancelled", "stale", "executing"])(
    "rejects proposal approval for a %s session",
    async (state) => {
      const { service, repos, namespace, namespaceId } = setup();
      const started = service.startTopicDecisionSession({ namespace, topicId: "topic-1" });
      setSessionState(repos, namespaceId, started.session.id, state);
      const proposal = insertRecommendedProposal(repos, namespaceId, started.session.id);

      await expect(service.approveProposal(
        namespace,
        started.session.id,
        proposal.id,
        proposal.version,
        { userId: "user-1" }
      )).rejects.toThrow(/state/i);
      expect(repos.topicDecisions.listExecutionRuns(namespaceId, started.session.id)).toEqual([]);
    }
  );

  it("does not resume a cancelled execution run", async () => {
    const { service, repos, namespace, namespaceId } = setup();
    const started = service.startTopicDecisionSession({ namespace, topicId: "topic-1" });
    setSessionState(repos, namespaceId, started.session.id, "ready_for_decision");
    const proposal = insertRecommendedProposal(repos, namespaceId, started.session.id, "authoritative_write");
    const run = await service.approveProposal(namespace, started.session.id, proposal.id, proposal.version, { userId: "user-1" });
    const cancelled = await service.confirmExecutionAction(
      namespace,
      run.id,
      "action-1",
      run.version,
      false,
      { userId: "user-1" },
      "reject-1"
    );

    expect(cancelled.status).toBe("cancelled");
    await expect(service.resumeExecution(namespace, cancelled.id)).rejects.toThrow(/cancelled/i);
  });
});

function setup(): {
  service: MemoryService;
  repos: Repositories;
  namespace: RuntimeNamespace;
  namespaceId: string;
} {
  const root = mkdtempSync(join(tmpdir(), "topic-transition-"));
  roots.push(root);
  const configPath = join(root, "config.yaml");
  writeFileSync(configPath, YAML.stringify({ memmyMemory: {} }));
  const { config } = loadMemmyConfig(configPath);
  const db = new MemoryDb({ path: join(root, "memory.sqlite") });
  const repos = new Repositories(db.db);
  const namespace: RuntimeNamespace = {
    source: "test",
    profileId: "test-profile",
    userId: "user-1",
    projectId: "project-1"
  };
  const namespaceId = namespaceIdFromContext(namespace);
  const now = nowIso();
  repos.topics.insertTopic({
    id: "topic-1",
    namespaceId,
    title: "Test topic",
    summary: "Test summary",
    status: "active",
    version: 1,
    sourceMemoryIds: [],
    metadata: {},
    createdAt: now,
    updatedAt: now
  });
  return {
    service: new MemoryService({ db, config, configPath, mode: "dev" }),
    repos,
    namespace,
    namespaceId
  };
}

function setSessionState(
  repos: Repositories,
  namespaceId: string,
  sessionId: string,
  state: TopicDecisionState
) {
  const session = repos.topicDecisions.getSession(namespaceId, sessionId)!;
  return repos.topicDecisions.updateSession(
    { ...session, state, version: session.version + 1, updatedAt: nowIso() },
    session.version
  );
}

function insertRecommendedProposal(
  repos: Repositories,
  namespaceId: string,
  sessionId: string,
  effect: "draft" | "authoritative_write" = "draft"
): TopicActionProposalRecord {
  const now = nowIso();
  return repos.topicDecisions.insertProposal({
    id: `proposal-${effect}`,
    namespaceId,
    sessionId,
    round: 1,
    rank: 1,
    effect,
    title: "Recommended proposal",
    payload: {
      dependencies: [],
      actions: [{
        id: "action-1",
        effect,
        target: "target-1",
        input: {},
        dependsOn: [],
        recoveryPoint: "before execution",
        acceptanceCondition: "completed"
      }]
    },
    status: "draft",
    version: 1,
    metadata: {
      recommended: true,
      artifact: "test artifact",
      permission: "test",
      recoveryPoint: "before execution",
      acceptanceCondition: "completed"
    },
    createdAt: now,
    updatedAt: now
  });
}
