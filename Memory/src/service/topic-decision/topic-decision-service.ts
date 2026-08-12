import type { Repositories } from "../../storage/repositories.js";
import type { RuntimeNamespace, TopicAgentSpec } from "../../types.js";
import { newId, stableHash } from "../../utils/id.js";
import { nowIso } from "../../utils/time.js";
import { recommendAgents } from "./agent-roster.js";
import type { TopicDecisionDetail, TopicDecisionStartInput, TopicDecisionStartResult } from "./decision-types.js";
import { EvidenceSnapshotBuilder } from "./evidence-snapshot.js";

export interface TopicDecisionServiceOptions {
  repos: Repositories;
  enabled: boolean;
  models: string[];
}

export class TopicDecisionService {
  private readonly snapshotBuilder: EvidenceSnapshotBuilder;

  constructor(private readonly options: TopicDecisionServiceOptions) {
    this.snapshotBuilder = new EvidenceSnapshotBuilder(options.repos);
  }

  recommendAgents(namespace: RuntimeNamespace, topicId: string): TopicAgentSpec[] {
    const namespaceId = stableHash(namespace);
    const topic = this.options.repos.topics.getTopic(topicId, namespaceId);
    const metadata = topic?.metadata;
    return recommendAgents(this.options.models, metadata);
  }

  start(input: TopicDecisionStartInput): TopicDecisionStartResult {
    if (!this.options.enabled) {
      throw new Error("topic decisions disabled");
    }

    const namespaceId = stableHash(input.namespace);
    const agents = input.agents ?? this.recommendAgents(input.namespace, input.topicId);

    const snapshotData = this.snapshotBuilder.build({
      namespaceId,
      topicId: input.topicId,
      agents
    });

    // Check for reusable session
    const existing = this.options.repos.topicDecisions.findReusableSession(
      namespaceId,
      input.topicId,
      snapshotData.inputHash
    );

    if (existing) {
      const snapshots = this.options.repos.topicDecisions.getSnapshotsForSession(namespaceId, existing.id);
      return {
        session: existing,
        snapshot: snapshots[0] ?? this.createSnapshotRecord(existing, snapshotData),
        reused: true
      };
    }

    // Create new session and snapshot
    const now = nowIso();
    const session = this.options.repos.topicDecisions.createSession({
      id: newId("tds"),
      namespaceId,
      topicId: input.topicId,
      inputHash: snapshotData.inputHash,
      state: "draft",
      version: 1,
      metadata: {},
      createdAt: now,
      updatedAt: now
    });

    const snapshot = this.createSnapshotRecord(session, snapshotData);

    return { session, snapshot, reused: false };
  }

  read(namespace: RuntimeNamespace, sessionId: string): TopicDecisionDetail {
    if (!this.options.enabled) {
      throw new Error("topic decisions disabled");
    }

    const namespaceId = stableHash(namespace);
    const session = this.options.repos.topicDecisions.getSession(namespaceId, sessionId);
    if (!session) {
      throw new Error(`session not found: ${sessionId}`);
    }

    const snapshots = this.options.repos.topicDecisions.getSnapshotsForSession(namespaceId, sessionId);
    return { session, snapshots };
  }

  private createSnapshotRecord(
    session: { id: string; namespaceId: string },
    data: ReturnType<EvidenceSnapshotBuilder["build"]>
  ): TopicDecisionStartResult["snapshot"] {
    const snapshot = this.options.repos.topicDecisions.insertSnapshot({
      id: newId("tdsnap"),
      namespaceId: session.namespaceId,
      sessionId: session.id,
      round: 0,
      payload: data,
      createdAt: nowIso()
    });
    return snapshot;
  }
}