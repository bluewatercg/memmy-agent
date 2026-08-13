import type { Repositories } from "../../storage/repositories.js";
import type { RuntimeNamespace, TopicAgentSpec } from "../../types.js";
import { newId, stableHash } from "../../utils/id.js";
import { nowIso } from "../../utils/time.js";
import { recommendAgents } from "./agent-roster.js";
import type { TopicDecisionDetail, TopicDecisionStartInput, TopicDecisionStartResult } from "./decision-types.js";
import { EvidenceSnapshotBuilder } from "./evidence-snapshot.js";
import { AgentPositionService } from "./agent-position.js";
import { EvidenceAcquisitionService } from "./evidence-acquisition.js";
import { DecisionabilityService } from "./decisionability.js";
import { createLlmClient } from "../../model/llm.js";
import type { LlmConfig } from "../../config/index.js";
import type { LlmClient } from "../../model/types.js";

export interface TopicDecisionServiceOptions {
  repos: Repositories;
  enabled: boolean;
  models: string[];
  llmConfigs?: Record<string, LlmConfig>;
  createLlmClient?: (model: string) => LlmClient;
}

export class TopicDecisionService {
  private readonly snapshotBuilder: EvidenceSnapshotBuilder;
  private readonly agentPositionService: AgentPositionService;
  private readonly evidenceAcquisitionService: EvidenceAcquisitionService;
  private readonly decisionabilityService: DecisionabilityService;

  constructor(private readonly options: TopicDecisionServiceOptions) {
    this.snapshotBuilder = new EvidenceSnapshotBuilder(options.repos);
    this.evidenceAcquisitionService = new EvidenceAcquisitionService({ repos: options.repos });
    this.decisionabilityService = new DecisionabilityService(
      { repos: options.repos },
      this.evidenceAcquisitionService
    );

    // Create LLM client factory - use provided or default
    const createClient = (model: string) => {
      if (this.options.createLlmClient) {
        return this.options.createLlmClient(model);
      }
      const config = this.options.llmConfigs?.[model] || { provider: "openai", model };
      return createLlmClient(config);
    };

    this.agentPositionService = new AgentPositionService({
      repos: options.repos,
      createLlmClient: createClient
    });
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

  /**
   * Run independent position analysis for all agents.
   */
  async runIndependentPositions(namespace: RuntimeNamespace, sessionId: string): Promise<void> {
    if (!this.options.enabled) {
      throw new Error("topic decisions disabled");
    }

    const namespaceId = stableHash(namespace);
    await this.agentPositionService.runIndependentPositions(namespace, sessionId);
  }

  /**
   * Check decisionability and get open questions.
   */
  async checkDecisionability(namespace: RuntimeNamespace, sessionId: string) {
    if (!this.options.enabled) {
      throw new Error("topic decisions disabled");
    }

    const namespaceId = stableHash(namespace);
    const session = this.options.repos.topicDecisions.getSession(namespaceId, sessionId);
    if (!session) {
      throw new Error(`session not found: ${sessionId}`);
    }

    const snapshots = this.options.repos.topicDecisions.getSnapshotsForSession(namespaceId, sessionId);
    if (snapshots.length === 0) {
      throw new Error(`no snapshot found for session: ${sessionId}`);
    }

    const snapshot = snapshots[snapshots.length - 1];
    return this.decisionabilityService.checkDecisionability(namespaceId, sessionId, snapshot);
  }

  /**
   * Submit evidence answers from user.
   */
  async submitEvidenceAnswers(
    namespace: RuntimeNamespace,
    sessionId: string,
    expectedVersion: number,
    answers: Array<{ questionKey: string; answer: string; source: "user_preference" | "user_supplied_unverified" }>
  ): Promise<TopicDecisionDetail> {
    if (!this.options.enabled) {
      throw new Error("topic decisions disabled");
    }

    const namespaceId = stableHash(namespace);
    const session = this.options.repos.topicDecisions.getSession(namespaceId, sessionId);
    if (!session) {
      throw new Error(`session not found: ${sessionId}`);
    }

    // Validate expected version for optimistic locking
    if (session.version !== expectedVersion) {
      throw new Error(`version conflict: expected ${expectedVersion}, got ${session.version}`);
    }

    // Submit answers - map source to verification type
    const mappedAnswers = answers.map(a => ({
      questionKey: a.questionKey,
      answer: a.answer,
      source: a.source === "user_preference" ? "user_authoritative" : "user_supplied_unverified"
    }));

    await this.evidenceAcquisitionService.submitAnswers(namespaceId, sessionId, expectedVersion, mappedAnswers);

    // Rebuild snapshot with new evidence (if answer changed inputs)
    const snapshots = this.options.repos.topicDecisions.getSnapshotsForSession(namespaceId, sessionId);
    if (snapshots.length > 0) {
      // Mark old positions as historical
      const oldSnapshot = snapshots[snapshots.length - 1];
      const positions = this.options.repos.topicDecisions.listPositions(namespaceId, sessionId, oldSnapshot.id);
      // Positions remain accessible but are now from previous snapshot

      // Create new snapshot round
      const newRound = oldSnapshot.round + 1;
      const newSnapshot = this.options.repos.topicDecisions.insertSnapshot({
        id: newId("tdsnap"),
        namespaceId,
        sessionId: session.id,
        round: newRound,
        payload: oldSnapshot.payload, // In real implementation, would rebuild with new evidence
        createdAt: nowIso()
      });
    }

    // Update session state - use valid state from schema
    const now = nowIso();
    const updatedSession = this.options.repos.topicDecisions.updateSession(
      { ...session, state: "awaiting_user_input", version: session.version + 1, updatedAt: now },
      expectedVersion
    );

    const updatedSnapshots = this.options.repos.topicDecisions.getSnapshotsForSession(namespaceId, sessionId);
    return { session: updatedSession, snapshots: updatedSnapshots };
  }

  /**
   * Get evidence source for external queries.
   */
  getEvidenceSource() {
    // Return the first source (MemoryEvidenceSource)
    const sources = (this.evidenceAcquisitionService as any).sources;
    return sources?.[0] || this.evidenceAcquisitionService;
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