import type { Repositories } from "../../storage/repositories.js";
import type { RuntimeNamespace, TopicDecisionSnapshotPayload, TopicEvidenceRequestRecord, TopicAgentPositionRecord } from "../../types.js";
import { stableHash } from "../../utils/id.js";
import { nowIso } from "../../utils/time.js";
import { newId } from "../../utils/id.js";

export interface TopicEvidenceRequestRecord {
  id: string;
  namespaceId: string;
  sessionId: string;
  round: number;
  question: string;
  verification: "none" | "repository_verified" | "tool_verified" | "user_authoritative" | "user_supplied_unverified" | "contradicted";
  status: "pending" | "answered" | "blocked" | "auto_acquired";
  metadata: Record<string, unknown>;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface TopicEvidenceAcquisitionResult {
  found: boolean;
  answer?: string;
  source?: "memory" | "topic_evidence" | "project_context" | "none";
  confidence?: number;
}

// Type for verification status (must match DB schema)
export type TopicEvidenceVerification = 
  | "repository_verified" 
  | "tool_verified" 
  | "user_authoritative" 
  | "user_supplied_unverified" 
  | "contradicted";

export interface EvidenceSource {
  id: string;
  acquire(request: TopicEvidenceRequestRecord, snapshot: { payload: TopicDecisionSnapshotPayload }): Promise<TopicEvidenceAcquisitionResult>;
}

/**
 * Built-in evidence source that can query Memory repository, topic evidence, and project context.
 * Read-only, no code/log/tool providers.
 */
export class MemoryEvidenceSource implements EvidenceSource {
  id = "memory";

  constructor(private readonly repos: Repositories) {}

  async acquire(
    request: TopicEvidenceRequestRecord,
    snapshot: { payload: TopicDecisionSnapshotPayload }
  ): Promise<TopicEvidenceAcquisitionResult> {
    const question = request.question.toLowerCase();

    // Try to find answer in existing memory
    if (question.includes("memory") || question.includes("remember")) {
      // Check if any memory relates to the question
      const memories = this.repos.memories.listByNamespace(request.namespaceId);
      for (const memory of memories.slice(0, 5)) {
        if (
          memory.content.toLowerCase().includes(question) ||
          memory.title?.toLowerCase().includes(question)
        ) {
          return {
            found: true,
            answer: memory.content.substring(0, 500),
            source: "memory",
            confidence: 0.7
          };
        }
      }
    }

    // Try to find answer in topic evidence
    const evidenceIds = snapshot.payload.evidenceIds;
    for (const evId of evidenceIds) {
      const content = snapshot.payload.evidenceContent[evId];
      if (content && content.toLowerCase().includes(question)) {
        return {
          found: true,
          answer: content.substring(0, 500),
          source: "topic_evidence",
          confidence: 0.9
        };
      }
    }

    // Try project context
    if (snapshot.payload.projectConstraints.length > 0) {
      for (const constraint of snapshot.payload.projectConstraints) {
        const constraintStr = JSON.stringify(constraint).toLowerCase();
        if (constraintStr.includes(question)) {
          return {
            found: true,
            answer: JSON.stringify(constraint),
            source: "project_context",
            confidence: 0.85
          };
        }
      }
    }

    return { found: false, source: "none" };
  }
}

/**
 * Manages evidence acquisition workflow.
 */
export class EvidenceAcquisitionService {
  private readonly sources: EvidenceSource[];

  constructor(private readonly options: { repos: Repositories }) {
    this.sources = [new MemoryEvidenceSource(options.repos)];
  }

  /**
   * Attempt automatic evidence acquisition for all open questions.
   * Returns updated session state based on results.
   */
  async attemptAutoAcquisition(
    namespaceId: string,
    sessionId: string,
    snapshot: { payload: TopicDecisionSnapshotPayload }
  ): Promise<{
    state: "gathering_evidence" | "awaiting_user_input" | "ready" | "blocked_by_evidence";
    acquiredAnswers: TopicEvidenceAcquisitionResult[];
    remainingQuestions: string[];
  }> {
    // Get all positions for this session
    const positions = this.options.repos.topicDecisions.listPositions(
      namespaceId,
      sessionId,
      snapshot.id
    );

    // Extract all missing information questions
    const allQuestions: Array<{
      agentId: string;
      key: string;
      question: string;
      blocking: boolean;
    }> = [];

    for (const pos of positions) {
      // Try to parse missing information from rationale (simple approach)
      if (pos.stance === "unknown" || !pos.stance) {
        allQuestions.push({
          agentId: pos.agentId,
          key: `unknown_${pos.agentId}`,
          question: pos.rationale || "What is needed to make a decision?",
          blocking: true
        });
      }
    }

    if (allQuestions.length === 0) {
      return { state: "ready", acquiredAnswers: [], remainingQuestions: [] };
    }

    const acquiredAnswers: TopicEvidenceAcquisitionResult[] = [];
    const remainingQuestions: string[] = [];

    // Try each source in stable order
    for (const source of this.sources) {
      for (const q of allQuestions) {
        if (remainingQuestions.includes(q.key)) continue;

        const request: TopicEvidenceRequestRecord = {
          id: newId("tdevreq"),
          namespaceId,
          sessionId,
          round: snapshot.payload.topicVersion,
          question: q.question,
          verification: "none",
          status: "pending",
          metadata: { key: q.key, agentId: q.agentId },
          version: 1,
          createdAt: nowIso(),
          updatedAt: nowIso()
        };

        const result = await source.acquire(request, snapshot);

        if (result.found) {
          acquiredAnswers.push(result);

          // Store the evidence request as auto_acquired
          this.options.repos.topicDecisions.upsertEvidenceRequest({
            ...request,
            status: "auto_acquired",
            answer: result.answer,
            verification: "none",
            metadata: { ...request.metadata, source: result.source }
          }, undefined);
        } else {
          remainingQuestions.push(q.key);
        }
      }
    }

    // Determine state based on results
    let state: "gathering_evidence" | "awaiting_user_input" | "ready" | "blocked_by_evidence";

    if (remainingQuestions.length === 0 && acquiredAnswers.length > 0) {
      state = "ready";
    } else if (remainingQuestions.length > 0) {
      const blockingQuestions = allQuestions.filter(
        q => q.blocking && remainingQuestions.includes(q.key)
      );
      if (blockingQuestions.length > 0) {
        state = "blocked_by_evidence";
      } else {
        state = "awaiting_user_input";
      }
    } else {
      state = "ready";
    }

    return { state, acquiredAnswers, remainingQuestions };
  }

  /**
   * Submit user evidence answers.
   */
  async submitAnswers(
    namespaceId: string,
    sessionId: string,
    expectedVersion: number,
    answers: Array<{
      questionKey: string;
      answer: string;
      source: "user_preference" | "user_supplied_unverified";
    }>
  ): Promise<TopicEvidenceRequestRecord[]> {
    const results: TopicEvidenceRequestRecord[] = [];
    const now = nowIso();

    for (const answer of answers) {
      const request: TopicEvidenceRequestRecord = {
        id: newId("tdevreq"),
        namespaceId,
        sessionId,
        round: 0,
        question: answer.questionKey,
        verification: answer.source,
        status: "answered",
        metadata: { answer: answer.answer },
        version: 1,
        createdAt: now,
        updatedAt: now
      };

      const stored = this.options.repos.topicDecisions.upsertEvidenceRequest(request, undefined);
      results.push(stored);
    }

    return results;
  }
}
