import type { Repositories } from "../../storage/repositories.js";
import type { RuntimeNamespace, TopicAgentSpec, TopicDecisionSessionRecord, TopicDecisionSnapshotPayload, TopicDecisionState, TopicExecutionRunRecord } from "../../types.js";
import { newId, stableHash } from "../../utils/id.js";
import { nowIso } from "../../utils/time.js";
import { recommendAgents } from "./agent-roster.js";
import type { TopicDecisionDetail, TopicDecisionStartInput, TopicDecisionStartResult } from "./decision-types.js";
import { EvidenceSnapshotBuilder } from "./evidence-snapshot.js";
import { AgentPositionService } from "./agent-position.js";
import { EvidenceAcquisitionService } from "./evidence-acquisition.js";
import { DecisionabilityService } from "./decisionability.js";
import { DebateOrchestrator } from "./debate-orchestrator.js";
import { ProposalSynthesis } from "./proposal-synthesis.js";
import { ProposalExecutor } from "./proposal-executor.js";
import type { TopicActionHandler } from "./proposal-executor.js";
import { createLlmClient } from "../../model/llm.js";
import type { LlmConfig } from "../../config/index.js";
import type { LlmClient } from "../../model/types.js";
import type { ProjectContextService } from "../project-context/project-context-service.js";
import { namespaceIdFromContext } from "../namespace/namespace-scope.js";

export class TopicDecisionStaleVersionError extends Error {
  readonly name = "TopicDecisionStaleVersionError";
  constructor(readonly sessionId: string, readonly currentVersion: number, readonly currentState: string) {
    super(`stale version: expected ${currentVersion}, session is at ${currentVersion} (${currentState})`);
  }
}

export interface TopicDecisionServiceOptions {
  repos: Repositories;
  enabled: boolean;
  models: string[];
  llmConfigs?: Record<string, unknown>;
  createLlmClient?: (model: string) => LlmClient;
  projectContextService?: ProjectContextService;
}

export class TopicDecisionService {
  private readonly snapshotBuilder: EvidenceSnapshotBuilder;
  private readonly agentPositionService: AgentPositionService;
  private readonly evidenceAcquisitionService: EvidenceAcquisitionService;
  private readonly decisionabilityService: DecisionabilityService;
  private readonly debateOrchestrator: DebateOrchestrator;
  private readonly proposalSynthesis: ProposalSynthesis;
  private readonly proposalExecutor: ProposalExecutor;

  get enabled(): boolean {
    return this.options.enabled;
  }
  constructor(private readonly options: TopicDecisionServiceOptions) {

    this.snapshotBuilder = new EvidenceSnapshotBuilder(options.repos);
    this.evidenceAcquisitionService = new EvidenceAcquisitionService({ repos: options.repos });
    this.decisionabilityService = new DecisionabilityService(
      { repos: options.repos },
      this.evidenceAcquisitionService,
      this // Pass self-reference for snapshot rebuild capability
    );

    // Create LLM client factory - use provided or default
    const createClient = (model: string) => {
      if (this.options.createLlmClient) {
        return this.options.createLlmClient(model);
      }
      const config = this.options.llmConfigs?.[model] || { provider: "openai_compatible" as const, model, enableThinking: false, temperature: 0.7, timeoutMs: 30000, maxRetries: 3, malformedRetries: 0 };
      return createLlmClient(config);
    };

    this.agentPositionService = new AgentPositionService({
      repos: options.repos,
      createLlmClient: createClient
    });

    this.debateOrchestrator = new DebateOrchestrator({
      repos: options.repos,
      createLlmClient: createClient
    });

    this.proposalSynthesis = new ProposalSynthesis({
      repos: options.repos,
      createLlmClient: createClient
    });

    if (!options.projectContextService) {
      throw new Error("TopicDecisionService requires projectContextService");
    }

    this.proposalExecutor = new ProposalExecutor({
      repos: options.repos,
      projectContextService: options.projectContextService
    });
  }
  private audit(
    namespace: RuntimeNamespace,
    sessionId: string,
    action: string,
    targetKind: string,
    targetId: string,
    meta: Record<string, unknown> = {}
  ): void {
    this.options.repos.runtime.insertAudit({
      userId: namespace.userId ?? "system",
      sessionId,
      actor: { namespace },
      action,
      targetKind,
      targetId,
      meta
    });
  }


  private assertMutationAllowed(
    session: TopicDecisionSessionRecord,
    operation: string,
    allowedStates?: readonly TopicDecisionState[]
  ): void {
    const blockedStates: readonly TopicDecisionState[] = ["executing", "completed", "stale", "failed", "cancelled"];
    const allowed = allowedStates
      ? allowedStates.includes(session.state)
      : !blockedStates.includes(session.state);
    if (allowed) {
      return;
    }

    const error = new Error(`cannot ${operation} in state: ${session.state}`);
    error.name = "TopicDecisionPolicyError";
    throw error;
  }

  recommendAgents(namespace: RuntimeNamespace, topicId: string): TopicAgentSpec[] {
    const namespaceId = namespaceIdFromContext(namespace)
    const topic = this.options.repos.topics.getTopic(topicId, namespaceId);
    const metadata = topic?.metadata;
    return recommendAgents(this.options.models, metadata);
  }

  start(input: TopicDecisionStartInput): TopicDecisionStartResult {
    if (!this.options.enabled) {
      throw new Error("topic decisions disabled");
    }

    const namespaceId = namespaceIdFromContext(input.namespace)
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
    this.audit(input.namespace, session.id, "topic_decision_session_created", "topic_decision_session", session.id, { topicId: session.topicId });
    this.audit(input.namespace, session.id, "topic_decision_snapshot_created", "topic_decision_snapshot", snapshot.id, { round: snapshot.round });


    return { session, snapshot, reused: false };
  }

  read(namespace: RuntimeNamespace, sessionId: string): TopicDecisionDetail {
    if (!this.options.enabled) {
      throw new Error("topic decisions disabled");
    }

    const namespaceId = namespaceIdFromContext(namespace)
    const session = this.options.repos.topicDecisions.getSession(namespaceId, sessionId);
    if (!session) {
      throw new Error(`session not found: ${sessionId}`);
    }

    const snapshots = this.options.repos.topicDecisions.getSnapshotsForSession(namespaceId, sessionId);
    const latestSnapshot = snapshots[snapshots.length - 1];
    const positions = latestSnapshot ? this.options.repos.topicDecisions.listPositions(namespaceId, sessionId, latestSnapshot.id) : [];
    return {
      session,
      snapshots,
      positions,
      debateRounds: this.options.repos.topicDecisions.listRounds(namespaceId, sessionId),
      evidenceRequests: this.options.repos.topicDecisions.listEvidenceRequests(namespaceId, sessionId),
      proposals: this.options.repos.topicDecisions.listProposals(namespaceId, sessionId),
      executionRuns: this.options.repos.topicDecisions.listExecutionRuns(namespaceId, sessionId)
    };
  }

  /**
   * Run independent position analysis for all agents.
   */
  async runIndependentPositions(namespace: RuntimeNamespace, sessionId: string, expectedVersion?: number): Promise<void> {
    if (!this.options.enabled) {
      throw new Error("topic decisions disabled");
    }

    const namespaceId = namespaceIdFromContext(namespace)
    const session = this.options.repos.topicDecisions.getSession(namespaceId, sessionId);
    if (!session) {
      throw new Error(`session not found: ${sessionId}`);
    }
    if (expectedVersion !== undefined && session.version !== expectedVersion) {
      throw new TopicDecisionStaleVersionError(sessionId, session.version, session.state);
    }
    this.assertMutationAllowed(session, "run independent positions");
    await this.agentPositionService.runIndependentPositions(namespace, sessionId);
    const snapshot = this.options.repos.topicDecisions.getSnapshotsForSession(namespaceId, sessionId).at(-1);
    if (snapshot) {
      for (const position of this.options.repos.topicDecisions.listPositions(namespaceId, sessionId, snapshot.id)) {
        this.audit(namespace, sessionId, "topic_decision_position_created", "topic_decision_position", position.id, { snapshotId: snapshot.id, agentId: position.agentId, round: position.round });
      }
    }
  }

  /**
   * Update session agents and bump version.
   */
  async updateTopicDecisionSessionAgents(
    namespace: RuntimeNamespace,
    sessionId: string,
    expectedVersion: number,
    agents: TopicAgentSpec[]
  ): Promise<TopicDecisionDetail> {
    if (!this.options.enabled) {
      throw new Error("topic decisions disabled");
    }

    const namespaceId = namespaceIdFromContext(namespace);
    const session = this.options.repos.topicDecisions.getSession(namespaceId, sessionId);
    if (!session) {
      throw new Error(`session not found: ${sessionId}`);
    }
    if (session.version !== expectedVersion) {
      throw new TopicDecisionStaleVersionError(sessionId, session.version, session.state);
    }

    const updatedSession = {
      ...session,
      agents,
      version: session.version + 1,
      updatedAt: nowIso()
    };
    this.options.repos.topicDecisions.updateSession(updatedSession, session.version);

    return this.read(namespace, sessionId);
  }


  async runDecision(namespace: RuntimeNamespace, sessionId: string, expectedVersion?: number): Promise<void> {
    if (!this.options.enabled) {
      throw new Error("topic decisions disabled");
    }
    const namespaceId = namespaceIdFromContext(namespace)
    const session = this.options.repos.topicDecisions.getSession(namespaceId, sessionId);
    if (!session) {
      throw new Error(`session not found: ${sessionId}`);
    }
    if (expectedVersion !== undefined && session.version !== expectedVersion) {
      throw new TopicDecisionStaleVersionError(sessionId, session.version, session.state);
    }
    this.assertMutationAllowed(session, "run decision");
    
    // First run independent positions to gather agent stances
    await this.runIndependentPositions(namespace, sessionId);
    
    // Now check decisionability with the positions we just gathered
    const snapshots = this.options.repos.topicDecisions.getSnapshotsForSession(namespaceId, sessionId);
    const snapshot = snapshots.at(-1);
    
    if (!snapshot) {
      throw new Error(`no snapshot found for session: ${sessionId}`);
    }
    
    const decisionability = await this.decisionabilityService.checkDecisionability(
      namespaceId,
      sessionId,
      snapshot
    );
    
    const newState = decisionability.status === "ready" ? "ready_for_decision" : decisionability.status;

    // Get the current session state after runIndependentPositions
    const currentSession = this.options.repos.topicDecisions.getSession(namespaceId, sessionId);
    if (!currentSession) {
      throw new Error(`session not found: ${sessionId}`);
    }

    this.options.repos.topicDecisions.updateSession(
      {
        ...currentSession,
        state: newState,
        version: currentSession.version + 1,
        updatedAt: nowIso()
      },
      currentSession.version
    );
    for (const request of this.options.repos.topicDecisions.listEvidenceRequests(namespaceId, sessionId)) {
      this.audit(namespace, sessionId, "topic_decision_evidence_question_created", "topic_decision_evidence_request", request.id, { round: request.round, verification: request.verification, status: request.status });
    }
  }

  /**
   * Check decisionability and get open questions.
   */
  async checkDecisionability(namespace: RuntimeNamespace, sessionId: string) {
    if (!this.options.enabled) {
      throw new Error("topic decisions disabled");
    }

    const namespaceId = namespaceIdFromContext(namespace)
    const session = this.options.repos.topicDecisions.getSession(namespaceId, sessionId);
    if (!session) {
      throw new Error(`session not found: ${sessionId}`);
    }

    const snapshots = this.options.repos.topicDecisions.getSnapshotsForSession(namespaceId, sessionId);
    if (snapshots.length === 0) {
      throw new Error(`no snapshot found for session: ${sessionId}`);
    }

    const snapshot = snapshots[snapshots.length - 1]!;
    return this.decisionabilityService.checkDecisionability(namespaceId, sessionId, snapshot);
  }

  /**
   * Rebuild snapshot with auto-acquired answers from repository.
   * Public method for DecisionabilityService to use when auto-acquisition resolves gaps.
   */
  async rebuildWithAutoAcquiredAnswers(
    namespaceId: string,
    sessionId: string,
    acquiredAnswers: Array<{ questionKey: string; answer: string }>
  ): Promise<{ newSnapshotId: string; rebuilt: boolean }> {
    const snapshots = this.options.repos.topicDecisions.getSnapshotsForSession(namespaceId, sessionId);
    const oldSnapshot = snapshots[snapshots.length - 1];

    if (!oldSnapshot) {
      return { newSnapshotId: "", rebuilt: false };
    }

    // Convert to same format as user answers
    const answers = acquiredAnswers.map(a => ({
      questionKey: a.questionKey,
      answer: a.answer,
      source: "user_supplied_unverified" as const
    }));

    // Rebuild payload
    const newPayload = this.rebuildPayloadWithAnswers(oldSnapshot.payload, answers);

    if (!newPayload || newPayload.inputHash === oldSnapshot.payload.inputHash) {
      return { newSnapshotId: oldSnapshot.id, rebuilt: false };
    }

    // Update session input hash
    const session = this.options.repos.topicDecisions.getSession(namespaceId, sessionId);
    if (session) {
      const historicalSnapshots = (session.metadata?.historicalSnapshotIds as string[] || []);
      const now = nowIso();
      this.options.repos.topicDecisions.updateSession(
        {
          ...session,
          inputHash: newPayload.inputHash,
          state: "gathering_evidence",
          version: session.version + 1,
          metadata: {
            ...session.metadata,
            historicalSnapshotIds: [...historicalSnapshots, oldSnapshot.id]
          },
          updatedAt: now
        },
        session.version
      );

      // Create new snapshot
      const newSnapshot = this.options.repos.topicDecisions.insertSnapshot({
        id: newId("tdsnap"),
        namespaceId,
        sessionId: session.id,
        round: oldSnapshot.round + 1,
        payload: newPayload,
        createdAt: now
      });

      return { newSnapshotId: newSnapshot.id, rebuilt: true };
    }

    return { newSnapshotId: oldSnapshot.id, rebuilt: false };
  }

  /**
   * Rebuild snapshot payload incorporating user answers.
   * Returns new payload if answers changed, null if equivalent.
   */
  private rebuildPayloadWithAnswers(
    oldPayload: TopicDecisionSnapshotPayload,
    answers: Array<{ questionKey: string; answer: string; source: "user_authoritative" | "user_supplied_unverified" }>
  ): TopicDecisionSnapshotPayload | null {
    // Build new evidence entries for answers
    const newEvidenceIds: string[] = [...oldPayload.evidenceIds];
    const newEvidenceHashes = { ...oldPayload.evidenceHashes };
    const newEvidenceContent = { ...oldPayload.evidenceContent };

    for (const answer of answers) {
      // Create deterministic evidence ID from question key
      const answerEvId = `answer:${stableHash(answer.questionKey).slice(0, 16)}`;

      // Only add if not already present
      if (!newEvidenceIds.includes(answerEvId)) {
        newEvidenceIds.push(answerEvId);

        // Hash with verification type for deterministic content
        const contentHash = stableHash({
          questionKey: answer.questionKey,
          answer: answer.answer,
          verification: answer.source
        });
        newEvidenceHashes[answerEvId] = contentHash;
        newEvidenceContent[answerEvId] = `[${answer.source}] ${answer.questionKey}: ${answer.answer}`;
      }
    }

    // Check if any new evidence was actually added
    if (newEvidenceIds.length === oldPayload.evidenceIds.length) {
      // No new evidence - check if any answers differ from existing content
      let changed = false;
      for (const answer of answers) {
        const answerEvId = `answer:${stableHash(answer.questionKey).slice(0, 16)}`;
        const existingContent = newEvidenceContent[answerEvId];
        const newContent = `[${answer.source}] ${answer.questionKey}: ${answer.answer}`;
        if (existingContent !== newContent) {
          changed = true;
          newEvidenceContent[answerEvId] = newContent;
        }
      }
      if (!changed) return null; // No changes, don't create new snapshot
    }

    // Recompute canonical inputHash with new evidence
    const canonicalInput = {
      topicVersion: oldPayload.topicVersion,
      evidenceIds: newEvidenceIds.sort(),
      evidenceHashes: Object.entries(newEvidenceHashes).sort(([a], [b]) => a.localeCompare(b)),
      projectConstraints: oldPayload.projectConstraints.map((c: Record<string, unknown>) => c.id || JSON.stringify(c)).sort(),
      roster: oldPayload.roster.map((a: TopicAgentSpec) => ({ id: a.id, role: a.role, model: a.model, reason: a.reason }))
    };
    const newInputHash = stableHash(canonicalInput);

    // Return rebuilt payload
    return {
      ...oldPayload,
      evidenceIds: newEvidenceIds,
      evidenceHashes: newEvidenceHashes,
      evidenceContent: newEvidenceContent,
      inputHash: newInputHash
    };
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

    const namespaceId = namespaceIdFromContext(namespace)
    const session = this.options.repos.topicDecisions.getSession(namespaceId, sessionId);
    if (!session) {
      throw new Error(`session not found: ${sessionId}`);
    }

    this.assertMutationAllowed(session, "submit evidence answers");

    // Validate expected version for optimistic locking
    if (session.version !== expectedVersion) {
      throw new Error(`version conflict: expected ${expectedVersion}, got ${session.version}`);
    }

    // Submit answers - map source to verification type
    const mappedAnswers = answers.map(a => ({
      questionKey: a.questionKey,
      answer: a.answer,
      source: (a.source === "user_preference" ? "user_authoritative" : "user_supplied_unverified") as "user_authoritative" | "user_supplied_unverified"
    }));

    await this.evidenceAcquisitionService.submitAnswers(namespaceId, sessionId, expectedVersion, mappedAnswers);

    // Rebuild snapshot with new evidence
    const snapshots = this.options.repos.topicDecisions.getSnapshotsForSession(namespaceId, sessionId);
    const oldSnapshot = snapshots[snapshots.length - 1];

    if (!oldSnapshot) {
      throw new Error(`no snapshot found for session: ${sessionId}`);
    }

    // Rebuild payload with answers
    const newPayload = this.rebuildPayloadWithAnswers(oldSnapshot.payload, mappedAnswers);

    // Check if we need a new snapshot (only when inputs changed)
    if (newPayload && newPayload.inputHash !== oldSnapshot.payload.inputHash) {
      // Mark old snapshot's positions as historical via session metadata
      const now = nowIso();
      const historicalSnapshots = (session.metadata?.historicalSnapshotIds as string[] || []);

      // Update session with historical reference and new inputHash
      const updatedSession = this.options.repos.topicDecisions.updateSession(
        {
          ...session,
          inputHash: newPayload.inputHash,
          state: "gathering_evidence",
          version: session.version + 1,
          metadata: {
            ...session.metadata,
            historicalSnapshotIds: [...historicalSnapshots, oldSnapshot.id]
          },
          updatedAt: now
        },
        expectedVersion
      );

      // Create new snapshot round
      const newRound = oldSnapshot.round + 1;
      const newSnapshot = this.options.repos.topicDecisions.insertSnapshot({
        id: newId("tdsnap"),
        namespaceId,
        sessionId: updatedSession.id,
        round: newRound,
        payload: newPayload,
        createdAt: now
      });
      for (const request of this.options.repos.topicDecisions.listEvidenceRequests(namespaceId, sessionId)) {
        if (request.status === "answered") this.audit(namespace, sessionId, "topic_decision_evidence_answered", "topic_decision_evidence_request", request.id, { snapshotId: newSnapshot.id, round: request.round, verification: request.verification });
      }
      this.audit(namespace, sessionId, "topic_decision_snapshot_created", "topic_decision_snapshot", newSnapshot.id, { previousSnapshotId: oldSnapshot.id, round: newSnapshot.round });


      return {
        session: updatedSession,
        snapshots: [...snapshots.slice(0, -1), newSnapshot]
      };
    }

    // No changes - update session state but don't create new snapshot
    const now = nowIso();
    const updatedSession = this.options.repos.topicDecisions.updateSession(
      { ...session, state: "awaiting_user_input", version: session.version + 1, updatedAt: now },
      expectedVersion
    );

    return { session: updatedSession, snapshots };
  }

  /**
   * Get evidence source for external queries.
   */
  getEvidenceSource() {
    // Return the first source (MemoryEvidenceSource)
    const sources = (this.evidenceAcquisitionService as any).sources;
    return sources?.[0] || this.evidenceAcquisitionService;
  }

  /**
   * Run adaptive debate with bounded rounds.
   */
  async runDebate(namespace: RuntimeNamespace, sessionId: string, expectedVersion?: number): Promise<TopicDecisionDetail> {
    if (!this.options.enabled) {
      throw new Error("topic decisions disabled");
    }

    const namespaceId = namespaceIdFromContext(namespace)
    const session = this.options.repos.topicDecisions.getSession(namespaceId, sessionId);
    if (!session) {
      throw new Error(`session not found: ${sessionId}`);
    }
    if (expectedVersion !== undefined && session.version !== expectedVersion) {
      throw new TopicDecisionStaleVersionError(sessionId, session.version, session.state);
    }
    this.assertMutationAllowed(session, "run debate");
    const startedAt = Date.now();
    const debate = await this.debateOrchestrator.runDebate(namespace, sessionId);
    for (const round of debate.roundRecords) {
      this.audit(namespace, sessionId, "topic_decision_debate_round_completed", "topic_decision_debate_round", round.id, { round: round.round, status: round.status, durationMs: Math.max(0, Date.now() - startedAt) });
    }

    // Return updated session detail
    return this.read(namespace, sessionId);
  }

  /**
   * Synthesize proposals from debate results.
   */
  async synthesizeProposals(namespace: RuntimeNamespace, sessionId: string, expectedVersion?: number): Promise<TopicDecisionDetail> {
    if (!this.options.enabled) {
      throw new Error("topic decisions disabled");
    }

    const namespaceId = namespaceIdFromContext(namespace)
    const session = this.options.repos.topicDecisions.getSession(namespaceId, sessionId);
    if (!session) {
      throw new Error(`session not found: ${sessionId}`);
    }
    if (expectedVersion !== undefined && session.version !== expectedVersion) {
      throw new TopicDecisionStaleVersionError(sessionId, session.version, session.state);
    }
    this.assertMutationAllowed(session, "synthesize proposals");
    const result = await this.proposalSynthesis.synthesizeProposals(namespace, sessionId);
    for (const proposal of result.proposals) {
      this.audit(namespace, sessionId, "topic_decision_proposal_created", "topic_decision_proposal", proposal.id, { round: proposal.round, rank: proposal.rank, effect: proposal.effect, status: proposal.status });
    }

    // Return updated session detail
    return this.read(namespace, sessionId);
  }

  /**
   * Approve and execute a recommended proposal.
   */
  async approveProposal(
    namespace: RuntimeNamespace,
    sessionId: string,
    proposalId: string,
    expectedProposalVersion: number,
    actor: Record<string, unknown>
  ): Promise<TopicExecutionRunRecord> {
    if (!this.options.enabled) {
      throw new Error("topic decisions disabled");
    }

    const startedAt = Date.now();
    const run = await this.proposalExecutor.approveProposal(namespace, sessionId, proposalId, expectedProposalVersion, actor);
    this.audit(namespace, sessionId, "topic_decision_proposal_approved", "topic_decision_proposal", proposalId, { runId: run.id, status: run.status, durationMs: Math.max(0, Date.now() - startedAt) });
    this.audit(namespace, sessionId, "topic_decision_execution_started", "topic_decision_execution", run.id, { proposalId, status: run.status });
    for (const action of Array.isArray(run.result.actions) ? run.result.actions : []) {
      if (typeof action === "object" && action !== null) {
        const value = action as Record<string, unknown>;
        this.audit(namespace, sessionId, "topic_decision_execution_action", "topic_decision_execution_action", String(value.id ?? "unknown"), { runId: run.id, status: value.status });
      }
    }
    if (run.status === "completed") this.audit(namespace, sessionId, "topic_decision_execution_completed", "topic_decision_execution", run.id, { proposalId, status: run.status });
    return run;
  }

  /**
   * Resume a paused or failed execution run.
   */
  async resumeExecution(namespace: RuntimeNamespace, runId: string): Promise<TopicExecutionRunRecord> {
    if (!this.options.enabled) {
      throw new Error("topic decisions disabled");
    }

    return this.proposalExecutor.resumeExecution(namespace, runId);
  }

  /**
   * Confirm or reject a pending confirmation-required action.
   * Irreversible effects require two separate confirmations; the idempotencyKey
   * prevents replay of the same confirmation request from counting twice.
   */
  async confirmExecutionAction(
    namespace: RuntimeNamespace,
    runId: string,
    actionId: string,
    expectedRunVersion: number,
    approved: boolean,
    actor: Record<string, unknown>,
    idempotencyKey: string
  ): Promise<TopicExecutionRunRecord> {
    if (!this.options.enabled) {
      throw new Error("topic decisions disabled");
    }

    const run = await this.proposalExecutor.confirmExecutionAction(namespace, runId, actionId, expectedRunVersion, approved, actor, idempotencyKey);
    this.audit(namespace, run.sessionId, "topic_decision_execution_action_confirmed", "topic_decision_execution_action", actionId, { runId, approved, status: run.status });
    if (run.status === "completed") this.audit(namespace, run.sessionId, "topic_decision_execution_completed", "topic_decision_execution", run.id, { proposalId: run.proposalId, status: run.status });
    return run;
  }

  /**
   * Update the agent roster for a session.
   * Validates that changing agents won't invalidate immutable inputs.
   * If the new roster would change the inputHash, creates a new snapshot.
   * Returns updated session and snapshots.
   */
  updateSessionAgents(
    namespace: RuntimeNamespace,
    sessionId: string,
    expectedVersion: number,
    agents: TopicAgentSpec[]
  ): TopicDecisionDetail {
    if (!this.options.enabled) {
      throw new Error("topic decisions disabled");
    }

    const namespaceId = namespaceIdFromContext(namespace)
    const session = this.options.repos.topicDecisions.getSession(namespaceId, sessionId);
    if (!session) {
      throw new Error(`session not found: ${sessionId}`);
    }

    // Validate expected version for optimistic locking
    if (session.version !== expectedVersion) {
      const error = new Error(`version conflict: expected ${expectedVersion}, got ${session.version}`);
      (error as Error & { name: string }).name = "TopicDecisionConflictError";
      Object.assign(error, { entityId: sessionId, currentVersion: session.version, currentState: session.state });
      throw error;
    }

    // Cannot update agents if session is in executing/completed/cancelled state
    const terminalStates = ["executing", "completed", "cancelled", "failed"];
    if (terminalStates.includes(session.state)) {
      const error = new Error(`cannot update agents in state: ${session.state}`);
      (error as Error & { name: string }).name = "TopicDecisionPolicyError";
      throw error;
    }

    // Get current snapshot
    const snapshots = this.options.repos.topicDecisions.getSnapshotsForSession(namespaceId, sessionId);
    const currentSnapshot = snapshots[snapshots.length - 1];
    if (!currentSnapshot) {
      throw new Error(`no snapshot found for session: ${sessionId}`);
    }

    // Build new payload with updated roster
    const newPayload: TopicDecisionSnapshotPayload = {
      ...currentSnapshot.payload,
      roster: agents
    };

    // Recompute canonical inputHash with new roster
    const canonicalInput = {
      topicVersion: newPayload.topicVersion,
      evidenceIds: newPayload.evidenceIds.sort(),
      evidenceHashes: Object.entries(newPayload.evidenceHashes).sort(([a], [b]) => a.localeCompare(b)),
      projectConstraints: newPayload.projectConstraints.map((c: Record<string, unknown>) => c.id || JSON.stringify(c)).sort(),
      roster: agents.map((a) => ({ id: a.id, role: a.role, model: a.model, reason: a.reason }))
    };
    newPayload.inputHash = stableHash(canonicalInput);

    const now = nowIso();

    // If inputHash changed (roster affects it), create new snapshot
    if (newPayload.inputHash !== currentSnapshot.payload.inputHash) {
      const historicalSnapshots = (session.metadata.historicalSnapshotIds as string[] | undefined) || [];

      // Update session with new inputHash and historical reference
      const updatedSession = this.options.repos.topicDecisions.updateSession(
        {
          ...session,
          inputHash: newPayload.inputHash,
          version: session.version + 1,
          metadata: {
            ...session.metadata,
            historicalSnapshotIds: [...historicalSnapshots, currentSnapshot.id]
          },
          updatedAt: now
        },
        expectedVersion
      );

      // Create new snapshot round
      const newRound = currentSnapshot.round + 1;
      const newSnapshot = this.options.repos.topicDecisions.insertSnapshot({
        id: newId("tdsnap"),
        namespaceId,
        sessionId: updatedSession.id,
        round: newRound,
        payload: newPayload,
        createdAt: now
      });

      return {
        session: updatedSession,
        snapshots: [...snapshots, newSnapshot]
      };
    }

    // No inputHash change - just update metadata with new agents
    const updatedSession = this.options.repos.topicDecisions.updateSession(
      {
        ...session,
        version: session.version + 1,
        metadata: { ...session.metadata, updatedAgents: agents, updatedAt: now },
        updatedAt: now
      },
      expectedVersion
    );

    return { session: updatedSession, snapshots };
  }

  /**
   * Cancel a decision session.
   * Idempotent: if already cancelled, returns success.
   * Rejects if session is in executing or completed state.
   */
  cancelSession(
    namespace: RuntimeNamespace,
    sessionId: string,
    expectedVersion: number
  ): TopicDecisionDetail {
    if (!this.options.enabled) {
      throw new Error("topic decisions disabled");
    }

    const namespaceId = namespaceIdFromContext(namespace)
    const session = this.options.repos.topicDecisions.getSession(namespaceId, sessionId);
    if (!session) {
      throw new Error(`session not found: ${sessionId}`);
    }

    // Idempotent: already cancelled
    if (session.state === "cancelled") {
      const snapshots = this.options.repos.topicDecisions.getSnapshotsForSession(namespaceId, sessionId);
      return { session, snapshots };
    }

    // Validate expected version for optimistic locking
    if (session.version !== expectedVersion) {
      const error = new Error(`version conflict: expected ${expectedVersion}, got ${session.version}`);
      (error as Error & { name: string }).name = "TopicDecisionConflictError";
      Object.assign(error, { entityId: sessionId, currentVersion: session.version, currentState: session.state });
      throw error;
    }

    // Cannot cancel if session is executing or completed
    const nonCancellableStates = ["executing", "completed"];
    if (nonCancellableStates.includes(session.state)) {
      const error = new Error(`cannot cancel session in state: ${session.state}`);
      (error as Error & { name: string }).name = "TopicDecisionPolicyError";
      throw error;
    }

    // Update session state to cancelled
    const now = nowIso();
    const updatedSession = this.options.repos.topicDecisions.updateSession(
      {
        ...session,
        state: "cancelled",
        version: session.version + 1,
        metadata: { ...session.metadata, cancelledAt: now },
        updatedAt: now
      },
      expectedVersion
    );

    const snapshots = this.options.repos.topicDecisions.getSnapshotsForSession(namespaceId, sessionId);
    return { session: updatedSession, snapshots };
  }

  /**
   * Register a custom action handler for a specific effect.
   */
  registerActionHandler(handler: TopicActionHandler): void {
    this.proposalExecutor.registerHandler(handler);
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