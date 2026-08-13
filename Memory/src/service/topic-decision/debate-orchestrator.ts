import type { Repositories } from "../../storage/repositories.js";
import type {
  RuntimeNamespace,
  TopicAgentPositionRecord,
  TopicDebateRoundRecord,
  TopicDecisionSnapshotPayload,
  TopicDecisionSessionRecord
} from "../../types.js";
import { newId, stableHash } from "../../utils/id.js";
import { nowIso } from "../../utils/time.js";
import type { LlmClient, LlmCompletionOptions, LlmMessage } from "../../model/types.js";

export type DebateStopReason =
  | "no_material_conflict"
  | "convergence"
  | "pending_next_round"
  | "resolved_after_round2"
  | "max_rounds"
  | "blocked_by_evidence"
  | "insufficient_role_coverage";

export interface TopicConflict {
  id: string;
  severity: "low" | "medium" | "high";
  claim: string;
  positionIds: string[];
  evidenceIds: string[];
  resolved: boolean;
}

export interface DebateRoundResult {
  round: number;
  status: string;
  summary: string;
  conflicts: TopicConflict[];
  deltas: Record<string, unknown>;
  stopReason: DebateStopReason;
}

export interface DebateOrchestratorOptions {
  repos: Repositories;
  createLlmClient: (model: string) => LlmClient;
}

const MAX_ROUNDS = 3;

interface StructuredLlmResponse {
  judgment: "support" | "oppose" | "neutral";
  confidence: number;
  resolvedConflicts: string[];
  remainingRisks: Array<{ severity: "low" | "medium" | "high"; description: string }>;
  evidenceIds: string[];
  facts: Array<{ claim: string; evidenceIds: string[] }>;
  assumptions: string[];
  missingInformation: string[];
  risks: Array<{ severity: "low" | "medium" | "high"; description: string }>;
  counterarguments: string[];
  suggestedActions: string[];
}

export class DebateOrchestrator {
  constructor(private readonly options: DebateOrchestratorOptions) {}

  async runDebate(
    namespace: RuntimeNamespace,
    sessionId: string
  ): Promise<{ roundRecords: TopicDebateRoundRecord[]; finalState: string }> {
    const namespaceId = stableHash(namespace);
    const session = this.options.repos.topicDecisions.getSession(namespaceId, sessionId);
    if (!session) throw new Error(`session not found: ${sessionId}`);

    const snapshots = this.options.repos.topicDecisions.getSnapshotsForSession(namespaceId, sessionId);
    if (snapshots.length === 0) throw new Error(`no snapshot found for session: ${sessionId}`);

    const snapshot = snapshots[snapshots.length - 1]!;
    const positions = this.options.repos.topicDecisions.listPositions(namespaceId, sessionId, snapshot.id);
    const roster = snapshot.payload.roster;

    // Update session to debating state
    const now = nowIso();
    this.options.repos.topicDecisions.updateSession(
      { ...session, state: "debating", version: session.version + 1, updatedAt: now },
      session.version
    );

    const roundRecords: TopicDebateRoundRecord[] = [];

    // Round 1: Always evaluate contradictions and missing premises
    const round1Result = await this.runRound(
      namespaceId,
      sessionId,
      snapshot,
      positions,
      roster,
      1
    );
    const round1Record = this.persistRound(namespaceId, sessionId, round1Result);
    roundRecords.push(round1Record);

    // Determine if round 2 is needed
    const highConflicts = round1Result.conflicts.filter(c => c.severity === "high" && !c.resolved);
    const mediumConflicts = round1Result.conflicts.filter(c => c.severity === "medium" && !c.resolved);

    if (highConflicts.length > 0 || mediumConflicts.length > 0) {
      // Round 2: Address high-impact conflicts or expected information gain
      const round2Positions = this.mergePositions(positions, round1Result);
      const round2Result = await this.runRound(
        namespaceId,
        sessionId,
        snapshot,
        round2Positions,
        roster,
        2
      );
      const round2Record = this.persistRound(namespaceId, sessionId, round2Result);
      roundRecords.push(round2Record);

      // Round 3: Only if high-risk conflict remains after round 2
      const remainingHigh = round2Result.conflicts.filter(c => c.severity === "high" && !c.resolved);
      if (remainingHigh.length > 0) {
        const round3Positions = this.mergePositions(round2Positions, round2Result);
        const round3Result = await this.runRound(
          namespaceId,
          sessionId,
          snapshot,
          round3Positions,
          roster,
          3
        );
        const round3Record = this.persistRound(namespaceId, sessionId, round3Result);
        roundRecords.push(round3Record);
      }
    }

    // Determine final state
    const lastRound = roundRecords[roundRecords.length - 1]!;
    const lastStopReason = lastRound.metadata.stopReason as DebateStopReason;
    const hasUnresolvedHigh = (lastRound.metadata.conflicts as TopicConflict[])?.some(
      (c: TopicConflict) => c.severity === "high" && !c.resolved
    );

    let finalState: string;
    if (hasUnresolvedHigh) {
      finalState = "blocked_by_evidence";
    } else if (lastStopReason === "no_material_conflict" || lastStopReason === "resolved_after_round2" || lastStopReason === "convergence") {
      finalState = "ready_for_decision";
    } else {
      // max_rounds with no high-severity → still ready for decision
      finalState = "ready_for_decision";
    }

    // Update session to final state
    const currentSession = this.options.repos.topicDecisions.getSession(namespaceId, sessionId)!;
    this.options.repos.topicDecisions.updateSession(
      { ...currentSession, state: finalState as TopicDecisionSessionRecord["state"], version: currentSession.version + 1, updatedAt: nowIso() },
      currentSession.version
    );

    return { roundRecords, finalState };
  }

  private async runRound(
    namespaceId: string,
    sessionId: string,
    snapshot: { id: string; payload: TopicDecisionSnapshotPayload },
    positions: TopicAgentPositionRecord[],
    roster: Array<{ id: string; role: string; model: string }>,
    roundNumber: number
  ): Promise<DebateRoundResult> {
    // Detect conflicts deterministically from positions
    const conflicts = this.detectConflicts(positions, snapshot.payload);

    // Check stop conditions before calling LLM
    if (roundNumber === 1 && conflicts.length === 0) {
      return {
        round: roundNumber,
        status: "completed",
        summary: "No material conflicts detected among agent positions",
        conflicts,
        deltas: {},
        stopReason: "no_material_conflict"
      };
    }

    // Check role coverage
    const rolesPresent = new Set(positions.map(p => {
      const agent = roster.find(a => a.id === p.agentId);
      return agent?.role || "unknown";
    }));
    const requiredRoles = new Set(["evidence_analyst", "risk_challenger"]);
    const hasCoverage = [...requiredRoles].every(r => rolesPresent.has(r));

    if (!hasCoverage) {
      return {
        round: roundNumber,
        status: "completed",
        summary: "Insufficient role coverage for debate",
        conflicts,
        deltas: {},
        stopReason: "insufficient_role_coverage"
      };
    }

    // Call LLM for each agent role in this round
    const deltas: Record<string, unknown> = {};
    const llmResponses: Array<{ agentId: string; role: string; response: StructuredLlmResponse }> = [];

    for (const agent of roster) {
      const operation = `topic.decision.debate.round${roundNumber}.${agent.role}`;
      const messages: LlmMessage[] = [
        { role: "system", content: this.buildDebateSystemPrompt(agent.role, roundNumber) },
        { role: "user", content: this.buildDebateUserPrompt(snapshot.payload, positions, conflicts) }
      ];

      const llmOptions: LlmCompletionOptions = {
        operation,
        temperature: 0,
        jsonMode: true
      };

      try {
        const llm = this.options.createLlmClient(agent.model);
        const raw = await llm.completeJson(messages, llmOptions);
        const parsed = parseLlmResponse(raw);
        llmResponses.push({ agentId: agent.id, role: agent.role, response: parsed });
        deltas[agent.id] = { status: "responded", round: roundNumber };
      } catch (error) {
        // Failed responders do not erase prior positions
        deltas[agent.id] = { status: "failed", round: roundNumber, error: error instanceof Error ? error.message : "unknown" };
      }
    }

    // Update conflicts based on LLM responses — strict resolution
    const updatedConflicts = this.resolveConflicts(conflicts, llmResponses);

    // Determine stop reason — accurate distinction
    let stopReason: DebateStopReason;
    const unresolvedHigh = updatedConflicts.filter(c => c.severity === "high" && !c.resolved);
    const unresolvedMedium = updatedConflicts.filter(c => c.severity === "medium" && !c.resolved);
    const unresolvedLow = updatedConflicts.filter(c => c.severity === "low" && !c.resolved);
    const allResolved = updatedConflicts.length > 0 && updatedConflicts.every(c => c.resolved);

    if (roundNumber >= MAX_ROUNDS) {
      stopReason = "max_rounds";
    } else if (unresolvedHigh.length > 0) {
      // Unresolved high-severity → blocked
      stopReason = "blocked_by_evidence";
    } else if (allResolved) {
      // All conflicts resolved
      stopReason = roundNumber >= 2 ? "resolved_after_round2" : "convergence";
    } else if (unresolvedMedium.length > 0 || unresolvedLow.length > 0) {
      // Unresolved conflicts remain, more rounds possible
      stopReason = "pending_next_round";
    } else {
      // No conflicts at all (shouldn't reach here if conflicts existed)
      stopReason = "no_material_conflict";
    }

    const summary = this.buildRoundSummary(roundNumber, updatedConflicts, llmResponses, stopReason);

    return {
      round: roundNumber,
      status: "completed",
      summary,
      conflicts: updatedConflicts,
      deltas: { ...deltas, llmResponses: llmResponses.map(r => ({ agentId: r.agentId, role: r.role, response: r.response })) },
      stopReason
    };
  }

  private detectConflicts(
    positions: TopicAgentPositionRecord[],
    payload: TopicDecisionSnapshotPayload
  ): TopicConflict[] {
    const conflicts: TopicConflict[] = [];
    const supportPositions = positions.filter(p => p.stance === "support");
    const opposePositions = positions.filter(p => p.stance === "oppose");

    // Contradictory judgments
    if (supportPositions.length > 0 && opposePositions.length > 0) {
      // Determine severity from structured position risks
      const allRisks = positions.flatMap(p => p.risks ?? []);
      const hasHighRisk = allRisks.some(r => r.severity === "high");
      const hasMediumRisk = allRisks.some(r => r.severity === "medium");

      // Fallback to keyword matching only if no structured risks
      let severity: "low" | "medium" | "high";
      if (allRisks.length === 0) {
        const hasHighKeyword = positions.some(p =>
          p.rationale.toLowerCase().includes("critical") ||
          p.rationale.toLowerCase().includes("high risk") ||
          p.rationale.toLowerCase().includes("severe")
        );
        const hasMediumKeyword = positions.some(p =>
          p.rationale.toLowerCase().includes("moderate") ||
          p.rationale.toLowerCase().includes("medium") ||
          p.rationale.toLowerCase().includes("concern")
        );
        severity = hasHighKeyword ? "high" : hasMediumKeyword ? "medium" : "low";
      } else {
        severity = hasHighRisk ? "high" : hasMediumRisk ? "medium" : "low";
      }

      const positionIds = [...supportPositions, ...opposePositions].map(p => p.id).sort();
      const conflictId = stableHash({ claim: "contradictory_judgment", positionIds });

      conflicts.push({
        id: conflictId,
        severity,
        claim: `Contradictory positions: ${supportPositions.length} support vs ${opposePositions.length} oppose`,
        positionIds,
        evidenceIds: payload.evidenceIds.filter(evId =>
          positions.some(p => p.evidenceIds.includes(evId))
        ),
        resolved: false
      });
    }

    // Check for missing premises (unknown stances)
    const unknownPositions = positions.filter(p => p.stance === "unknown");
    if (unknownPositions.length > 0) {
      const positionIds = unknownPositions.map(p => p.id).sort();
      const conflictId = stableHash({ claim: "missing_premises", positionIds });

      conflicts.push({
        id: conflictId,
        severity: "high",
        claim: `Missing premises: ${unknownPositions.length} agents unable to form position`,
        positionIds,
        evidenceIds: [],
        resolved: false
      });
    }

    return conflicts;
  }

  private resolveConflicts(
    conflicts: TopicConflict[],
    llmResponses: Array<{ agentId: string; role: string; response: StructuredLlmResponse }>
  ): TopicConflict[] {
    // Build set of valid conflict IDs
    const validConflictIds = new Set(conflicts.map(c => c.id));

    // Collect all explicitly resolved conflict IDs from LLM responses
    const resolvedIds = new Set<string>();
    for (const { response } of llmResponses) {
      for (const id of response.resolvedConflicts) {
        // Reject unknown IDs — only accept valid conflict IDs
        if (validConflictIds.has(id)) {
          resolvedIds.add(id);
        }
      }
    }

    // Update conflicts: only explicitly named conflicts are resolved
    return conflicts.map(conflict => ({
      ...conflict,
      resolved: resolvedIds.has(conflict.id)
    }));
  }

  private mergePositions(
    existing: TopicAgentPositionRecord[],
    roundResult: DebateRoundResult
  ): TopicAgentPositionRecord[] {
    // Return existing positions — debate doesn't create new position records
    return existing;
  }

  private persistRound(
    namespaceId: string,
    sessionId: string,
    result: DebateRoundResult
  ): TopicDebateRoundRecord {
    const now = nowIso();
    return this.options.repos.topicDecisions.upsertRound({
      id: newId("tdr"),
      namespaceId,
      sessionId,
      round: result.round,
      status: result.status,
      summary: result.summary,
      metadata: {
        stopReason: result.stopReason,
        conflicts: result.conflicts,
        deltas: result.deltas
      },
      version: 1,
      createdAt: now,
      updatedAt: now
    });
  }

  private buildDebateSystemPrompt(role: string, roundNumber: number): string {
    return `You are a ${role} participating in debate round ${roundNumber}. Analyze the conflicting positions and evidence. Provide your assessment of whether conflicts can be resolved, what risks remain, and what additional information is needed. Respond with JSON.`;
  }

  private buildDebateUserPrompt(
    payload: TopicDecisionSnapshotPayload,
    positions: TopicAgentPositionRecord[],
    conflicts: TopicConflict[]
  ): string {
    let prompt = `# Debate Context\n\n`;

    prompt += `## Evidence\n`;
    for (const evId of payload.evidenceIds) {
      const content = payload.evidenceContent[evId] || "[no content]";
      prompt += `- ${evId}: ${content}\n`;
    }

    prompt += `\n## Current Positions\n`;
    for (const pos of positions) {
      prompt += `- ${pos.agentId}: ${pos.stance} — ${pos.rationale}\n`;
    }

    prompt += `\n## Conflicts\n`;
    for (const conflict of conflicts) {
      prompt += `- [${conflict.id}] [${conflict.severity}] ${conflict.claim} (resolved: ${conflict.resolved})\n`;
    }

    prompt += `\n## Response Format\n`;
    prompt += `{\n  "judgment": "support" | "oppose" | "neutral",\n  "confidence": 0.0-1.0,\n  "resolvedConflicts": ["conflict-id-1", ...],\n  "remainingRisks": [{"severity": "low"|"medium"|"high", "description": "..."}],\n  "evidenceIds": [...],\n  "facts": [{"claim": "...", "evidenceIds": [...]}],\n  "assumptions": [...],\n  "missingInformation": [],\n  "risks": [{"severity": "low"|"medium"|"high", "description": "..."}],\n  "counterarguments": [],\n  "suggestedActions": []\n}`;

    return prompt;
  }

  private buildRoundSummary(
    roundNumber: number,
    conflicts: TopicConflict[],
    llmResponses: Array<{ agentId: string; role: string; response: StructuredLlmResponse }>,
    stopReason: DebateStopReason
  ): string {
    const resolvedCount = conflicts.filter(c => c.resolved).length;
    const unresolvedCount = conflicts.filter(c => !c.resolved).length;
    const responderCount = llmResponses.length;

    return `Round ${roundNumber}: ${responderCount} agents responded. ${resolvedCount} conflicts resolved, ${unresolvedCount} unresolved. Stop: ${stopReason}`;
  }
}

/**
 * Strict parser/type guard for LLM debate responses.
 * Validates the full nested schema before business logic.
 */
function parseLlmResponse(raw: unknown): StructuredLlmResponse {
  if (!raw || typeof raw !== "object") {
    throw new Error("LLM debate response must be an object");
  }

  const r = raw as Record<string, unknown>;

  // judgment
  const judgment = r.judgment;
  if (judgment !== "support" && judgment !== "oppose" && judgment !== "neutral") {
    throw new Error(`LLM debate response.judgment must be "support"|"oppose"|"neutral", got ${JSON.stringify(judgment)}`);
  }

  // confidence
  const confidence = r.confidence;
  if (typeof confidence !== "number" || confidence < 0 || confidence > 1) {
    throw new Error(`LLM debate response.confidence must be number 0-1, got ${JSON.stringify(confidence)}`);
  }

  // resolvedConflicts
  const resolvedConflicts = r.resolvedConflicts;
  if (!Array.isArray(resolvedConflicts)) {
    throw new Error(`LLM debate response.resolvedConflicts must be array, got ${JSON.stringify(resolvedConflicts)}`);
  }
  for (const id of resolvedConflicts) {
    if (typeof id !== "string") {
      throw new Error(`LLM debate response.resolvedConflicts items must be strings, got ${JSON.stringify(id)}`);
    }
  }

  // remainingRisks
  const remainingRisks = parseRiskArray(r.remainingRisks, "remainingRisks");

  // evidenceIds
  const evidenceIds = parseStringArray(r.evidenceIds, "evidenceIds");

  // facts
  const facts = r.facts;
  if (!Array.isArray(facts)) {
    throw new Error(`LLM debate response.facts must be array, got ${JSON.stringify(facts)}`);
  }
  for (const fact of facts) {
    if (!fact || typeof fact !== "object") {
      throw new Error(`LLM debate response.facts items must be objects`);
    }
    const f = fact as Record<string, unknown>;
    if (typeof f.claim !== "string") {
      throw new Error(`LLM debate response.facts[].claim must be string`);
    }
    if (!Array.isArray(f.evidenceIds)) {
      throw new Error(`LLM debate response.facts[].evidenceIds must be array`);
    }
  }

  // assumptions
  const assumptions = parseStringArray(r.assumptions, "assumptions");

  // missingInformation
  const missingInformation = parseStringArray(r.missingInformation, "missingInformation");

  // risks
  const risks = parseRiskArray(r.risks, "risks");

  // counterarguments
  const counterarguments = parseStringArray(r.counterarguments, "counterarguments");

  // suggestedActions
  const suggestedActions = parseStringArray(r.suggestedActions, "suggestedActions");

  return {
    judgment,
    confidence,
    resolvedConflicts: resolvedConflicts as string[],
    remainingRisks,
    evidenceIds: evidenceIds as string[],
    facts: facts as Array<{ claim: string; evidenceIds: string[] }>,
    assumptions: assumptions as string[],
    missingInformation: missingInformation as string[],
    risks,
    counterarguments: counterarguments as string[],
    suggestedActions: suggestedActions as string[]
  };
}

function parseStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`LLM debate response.${field} must be array, got ${JSON.stringify(value)}`);
  }
  for (const item of value) {
    if (typeof item !== "string") {
      throw new Error(`LLM debate response.${field} items must be strings, got ${JSON.stringify(item)}`);
    }
  }
  return value as string[];
}

function parseRiskArray(value: unknown, field: string): Array<{ severity: "low" | "medium" | "high"; description: string }> {
  if (!Array.isArray(value)) {
    throw new Error(`LLM debate response.${field} must be array, got ${JSON.stringify(value)}`);
  }
  const result: Array<{ severity: "low" | "medium" | "high"; description: string }> = [];
  for (const item of value) {
    if (!item || typeof item !== "object") {
      throw new Error(`LLM debate response.${field} items must be objects`);
    }
    const r = item as Record<string, unknown>;
    if (r.severity !== "low" && r.severity !== "medium" && r.severity !== "high") {
      throw new Error(`LLM debate response.${field}[].severity must be "low"|"medium"|"high", got ${JSON.stringify(r.severity)}`);
    }
    if (typeof r.description !== "string") {
      throw new Error(`LLM debate response.${field}[].description must be string`);
    }
    result.push({ severity: r.severity, description: r.description });
  }
  return result;
}
