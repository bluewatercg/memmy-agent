import type { Repositories } from "../../storage/repositories.js";
import type { RuntimeNamespace, TopicAgentSpec, TopicDecisionSnapshotPayload } from "../../types.js";
import { newId } from "../../utils/id.js";
import { nowIso } from "../../utils/time.js";
import { namespaceIdFromContext } from "../namespace/namespace-scope.js";
import type { LlmClient, LlmMessage, LlmCompletionOptions } from "../../model/types.js";
import type { TopicAgentPositionRecord, TopicDecisionSessionRecord, TopicDecisionSnapshotRecord } from "../../types.js";

export interface AgentPositionResult {
  judgment: string;
  confidence: number;
  evidenceIds: string[];
  facts: Array<{ claim: string; evidenceIds: string[] }>;
  assumptions: string[];
  missingInformation: string[];
  risks: Array<{ severity: "low" | "medium" | "high"; description: string }>;
  counterarguments: string[];
  suggestedActions: string[];
}

export interface PositionParseError {
  code: "INVALID_JSON" | "UNKNOWN_JUDGMENT" | "INVALID_CONFIDENCE" | "UNKNOWN_EVIDENCE_CITATION" | "MISSING_FIELD" | "EMPTY_POSITION";
  message: string;
}

function isValidJudgment(judgment: unknown): boolean {
  return typeof judgment === "string" && ["support", "oppose", "neutral", "unknown"].includes(judgment);
}

function isValidConfidence(confidence: unknown): confidence is number {
  return typeof confidence === "number" && confidence >= 0 && confidence <= 1;
}

function isValidSeverity(severity: unknown): severity is "low" | "medium" | "high" {
  return typeof severity === "string" && ["low", "medium", "high"].includes(severity);
}

export function parseAgentPosition(
  raw: unknown,
  validEvidenceIds: Set<string>
): AgentPositionResult | PositionParseError {
  if (!raw || typeof raw !== "object") {
    return { code: "MISSING_FIELD", message: "position must be an object" };
  }

  const obj = raw as Record<string, unknown>;

  // Parse judgment
  const judgment = obj.judgment;
  if (!isValidJudgment(judgment)) {
    return { code: "UNKNOWN_JUDGMENT", message: `invalid judgment: ${judgment}` };
  }

  // Parse confidence
  const confidence = obj.confidence;
  if (!isValidConfidence(confidence)) {
    return { code: "INVALID_CONFIDENCE", message: `confidence must be between 0 and 1, got: ${confidence}` };
  }

  // Parse evidence IDs
  const evidenceIds = obj.evidenceIds;
  if (!Array.isArray(evidenceIds)) {
    return { code: "MISSING_FIELD", message: "evidenceIds must be an array" };
  }

  // Validate evidence citations
  for (const evId of evidenceIds) {
    if (typeof evId !== "string" || !validEvidenceIds.has(evId)) {
      return { code: "UNKNOWN_EVIDENCE_CITATION", message: `unknown evidence citation: ${evId}` };
    }
  }

  // Parse facts
  const facts = obj.facts;
  if (!Array.isArray(facts)) {
    return { code: "MISSING_FIELD", message: "facts must be an array" };
  }

  for (const fact of facts) {
    if (!fact || typeof fact !== "object") return { code: "MISSING_FIELD", message: "fact must be an object" };
    const f = fact as Record<string, unknown>;
    if (typeof f.claim !== "string") return { code: "MISSING_FIELD", message: "fact.claim must be a string" };
    if (!Array.isArray(f.evidenceIds)) return { code: "MISSING_FIELD", message: "fact.evidenceIds must be an array" };
    for (const evId of f.evidenceIds as unknown[]) {
      if (typeof evId !== "string" || !validEvidenceIds.has(evId as string)) {
        return { code: "UNKNOWN_EVIDENCE_CITATION", message: `unknown evidence in fact: ${evId}` };
      }
    }
  }

  // Parse assumptions
  const assumptions = obj.assumptions;
  if (!Array.isArray(assumptions)) {
    return { code: "MISSING_FIELD", message: "assumptions must be an array" };
  }

  if (!assumptions.every(assumption => typeof assumption === "string")) {
    return { code: "MISSING_FIELD", message: "assumptions must contain only strings" };
  }

  // Parse missingInformation
  const missingInformation = obj.missingInformation;
  if (!Array.isArray(missingInformation)) {
    return { code: "MISSING_FIELD", message: "missingInformation must be an array" };
  }

  const normalizedMissingInformation: string[] = [];
  for (const mi of missingInformation) {
    if (typeof mi === "string") {
      normalizedMissingInformation.push(mi);
    } else if (mi && typeof mi === "object") {
      const m = mi as Record<string, unknown>;
      if (typeof m.question === "string") {
        normalizedMissingInformation.push(m.question);
      } else if (typeof m.key === "string") {
        normalizedMissingInformation.push(m.key);
      }
    }
  }

  // Parse risks
  const risks = obj.risks;
  if (!Array.isArray(risks)) {
    return { code: "MISSING_FIELD", message: "risks must be an array" };
  }

  for (const risk of risks) {
    if (!risk || typeof risk !== "object") return { code: "MISSING_FIELD", message: "risk must be an object" };
    const r = risk as Record<string, unknown>;
    if (!isValidSeverity(r.severity)) return { code: "MISSING_FIELD", message: "risk.severity must be low|medium|high" };
    if (typeof r.description !== "string") return { code: "MISSING_FIELD", message: "risk.description must be a string" };
  }

  // Parse counterarguments and suggestedActions
  const counterarguments = obj.counterarguments;
  if (!Array.isArray(counterarguments)) {
    return { code: "MISSING_FIELD", message: "counterarguments must be an array" };
  }

  if (!counterarguments.every(counterargument => typeof counterargument === "string")) {
    return { code: "MISSING_FIELD", message: "counterarguments must contain only strings" };
  }

  const suggestedActions = obj.suggestedActions;
  if (!Array.isArray(suggestedActions)) {
    return { code: "MISSING_FIELD", message: "suggestedActions must be an array" };
  }

  if (!suggestedActions.every(action => typeof action === "string")) {
    return { code: "MISSING_FIELD", message: "suggestedActions must contain only strings" };
  }

  const hasMeaningfulContent = evidenceIds.length > 0
    || facts.some(fact => fact.claim.trim().length > 0)
    || assumptions.some(assumption => typeof assumption === "string" && assumption.trim().length > 0)
    || normalizedMissingInformation.some(missing => missing.trim().length > 0)
    || risks.some(risk => risk.description.trim().length > 0)
    || counterarguments.some(counterargument => typeof counterargument === "string" && counterargument.trim().length > 0)
    || suggestedActions.some(action => typeof action === "string" && action.trim().length > 0);
  if (!hasMeaningfulContent) {
    return { code: "EMPTY_POSITION", message: "position must contain evidence or substantive analysis" };
  }

  return {
    judgment: judgment as string,
    confidence,
    evidenceIds,
    facts: facts as AgentPositionResult["facts"],
    assumptions: assumptions as string[],
    missingInformation: normalizedMissingInformation,
    risks: risks as AgentPositionResult["risks"],
    counterarguments: counterarguments as string[],
    suggestedActions: suggestedActions as string[]
  };
}

export class PositionAnalysisError extends Error {
  constructor(
    readonly cause: unknown,
    readonly createdPositions: TopicAgentPositionRecord[]
  ) {
    super(cause instanceof Error ? cause.message : "position analysis failed");
    this.name = "PositionAnalysisError";
  }
}

export interface AgentPositionOptions {
  repos: Repositories;
  createLlmClient: (model: string) => LlmClient;
}

export class AgentPositionService {
  constructor(private readonly options: AgentPositionOptions) {}

  async runIndependentPositions(
    namespace: RuntimeNamespace,
    sessionId: string
  ): Promise<TopicAgentPositionRecord[]> {
    const namespaceId = namespaceIdFromContext(namespace)

    // Get session
    const session = this.options.repos.topicDecisions.getSession(namespaceId, sessionId);
    if (!session) {
      throw new Error(`session not found: ${sessionId}`);
    }

    // Get latest snapshot
    const snapshots = this.options.repos.topicDecisions.getSnapshotsForSession(namespaceId, sessionId);
    if (snapshots.length === 0) {
      throw new Error(`no snapshot found for session: ${sessionId}`);
    }

    const snapshot = snapshots[snapshots.length - 1]!;
    const roster = snapshot.payload.roster;

    // Get existing positions - must filter to ensure they belong to active snapshot
    // and revalidate all cited evidence IDs against current snapshot
    const allPositions = this.options.repos.topicDecisions.listPositions(
      namespaceId,
      sessionId,
      snapshot.id
    );

    const validEvidenceIds = new Set(snapshot.payload.evidenceIds);

    // Reuse only successful positions from the active snapshot with valid citations.
    const validPositions = allPositions.filter(p => {
      if (p.snapshotId !== snapshot.id) return false;
      if (p.stance === "unknown" && (
        p.rationale.startsWith("error:")
        || (p.rationale.trim().length === 0
          && p.evidenceIds.length === 0
          && p.confidence === 0
          && (p.missingInformation ?? []).length === 0
          && (p.risks ?? []).length === 0
          && (p.assumptions ?? []).length === 0)
      )) return false;
      return p.evidenceIds.every(evId => validEvidenceIds.has(evId));
    });

    const existingPositionMap = new Map(validPositions.map(p => [p.agentId, p]));

    // Build prompt with snapshot
    const snapshotPrompt = this.buildSnapshotPrompt(snapshot.payload);

    // Run all agents in parallel
    const positionPromises = roster.map(async (agent) => {
      // Check for reusable position
      const existing = existingPositionMap.get(agent.id);
      if (existing) {
        return existing;
      }

      // Create LLM client for this agent
      const llm = this.options.createLlmClient(agent.model);

      const operation = `topic.decision.position.${agent.role}`;
      const messages: LlmMessage[] = [
        { role: "system", content: this.buildSystemPrompt(agent.role) },
        { role: "user", content: snapshotPrompt }
      ];

      const options: LlmCompletionOptions = {
        operation,
        temperature: 0,
        jsonMode: true
      };

      try {
        let response = await llm.completeJson(messages, options);
        let parsed = parseAgentPosition(response, validEvidenceIds);

        if ("code" in parsed) {
          const repairMessages: LlmMessage[] = [
            ...messages,
            { role: "assistant", content: JSON.stringify(response) },
            { role: "user", content: this.buildPositionRepairPrompt(parsed, validEvidenceIds) }
          ];
          response = await llm.completeJson(repairMessages, options);
          parsed = parseAgentPosition(response, validEvidenceIds);
        }

        if ("code" in parsed) {
          throw new Error(`position parse error: ${parsed.code} - ${parsed.message}`);
        }

        // Store position
        const position: TopicAgentPositionRecord = {
          id: newId("tdpos"),
          namespaceId,
          sessionId,
          snapshotId: snapshot.id,
          round: snapshot.round,
          agentId: agent.id,
          stance: parsed.judgment,
          rationale: [
            ...parsed.facts.map(fact => fact.claim),
            ...parsed.assumptions,
            ...parsed.missingInformation,
            ...parsed.risks.map(risk => risk.description),
            ...parsed.counterarguments,
            ...parsed.suggestedActions
          ].filter(value => value.trim().length > 0).join("; "),
          evidenceIds: parsed.evidenceIds,
          confidence: parsed.confidence,
          missingInformation: parsed.missingInformation,
          risks: parsed.risks,
          assumptions: parsed.assumptions,
          createdAt: nowIso()
        };

        return this.options.repos.topicDecisions.insertPositionReplacingFailure(position);
      } catch (error) {
        const failedPosition: TopicAgentPositionRecord = {
          id: newId("tdpos"),
          namespaceId,
          sessionId,
          snapshotId: snapshot.id,
          round: snapshot.round,
          agentId: agent.id,
          stance: "unknown",
          rationale: `error: ${error instanceof Error ? error.message : "unknown error"}`,
          evidenceIds: [],
          createdAt: nowIso()
        };

        this.options.repos.topicDecisions.insertPositionReplacingFailure(failedPosition);
        throw error;
      }
    });

    const settled = await Promise.allSettled(positionPromises);
    const createdPositions: TopicAgentPositionRecord[] = [];
    let failure: unknown;
    for (const result of settled) {
      if (result.status === "fulfilled") {
        if (!existingPositionMap.has(result.value.agentId)) createdPositions.push(result.value);
      } else if (failure === undefined) {
        failure = result.reason;
      }
    }
    if (failure !== undefined) {
      throw new PositionAnalysisError(failure, createdPositions);
    }
    return createdPositions;
  }

  private buildSystemPrompt(role: string): string {
    const rolePrompts: Record<string, string> = {
      evidence_analyst: "You are an evidence analyst. Analyze the provided evidence and determine if it supports or opposes the topic. Provide your judgment, confidence level, and identify any missing information needed.",
      domain_analyst: "You are a domain expert. Analyze the topic from your domain perspective. Identify facts, assumptions, and any gaps in knowledge that prevent a clear decision.",
      risk_challenger: "You are a risk challenger. Identify potential risks, counterarguments, and downsides to the topic. Be adversarial in your analysis.",
      action_planner: "You are an action planner. Based on the evidence and analysis, suggest concrete actions and their expected outcomes.",
      specialist: "You are a specialist. Provide expert analysis specific to your domain expertise."
    };

    return rolePrompts[role] || rolePrompts.specialist || "You are a specialist.";
  }

  private buildPositionRepairPrompt(
    error: PositionParseError,
    validEvidenceIds: ReadonlySet<string>
  ): string {
    const evidenceRule = error.code === "UNKNOWN_EVIDENCE_CITATION"
      ? ` Evidence citations must be copied exactly from this whitelist: ${JSON.stringify([...validEvidenceIds])}. Use only these values in both evidenceIds and facts[].evidenceIds. If no listed evidence supports a claim, use an empty array. Do not invent, transform, or infer evidence IDs.`
      : "";
    return `Your previous JSON failed validation with ${error.code}: ${error.message}. Return the complete JSON object again with every field in the requested type.${evidenceRule}`;
  }

  private buildSnapshotPrompt(payload: TopicDecisionSnapshotPayload): string {
    let prompt = `# Topic Decision Snapshot\n\n`;

    prompt += `## Evidence (${payload.evidenceIds.length} items)\n`;
    for (const evId of payload.evidenceIds) {
      const content = payload.evidenceContent[evId] || "[no content]";
      prompt += `\n### ${evId}\n${content}\n`;
    }

    if (payload.projectConstraints.length > 0) {
      prompt += `\n## Project Constraints\n`;
      for (const constraint of payload.projectConstraints) {
        prompt += `- ${JSON.stringify(constraint)}\n`;
      }
    }

    prompt += `\n## Roster\n`;
    for (const agent of payload.roster) {
      prompt += `- ${agent.id}: ${agent.role} (${agent.model})\n`;
    }

    prompt += `\n## Response Format\nProvide your analysis as JSON with the following structure:\n`;
    prompt += `Evidence citations are a strict whitelist. Copy IDs exactly from the Evidence headings above in both evidenceIds and facts[].evidenceIds. If no listed evidence supports a claim, use an empty array. Never invent, transform, or infer an evidence ID.\n`;
    prompt += `{
  "judgment": "support" | "oppose" | "neutral" | "unknown",
  "confidence": 0.0-1.0,
  "evidenceIds": [],
  "facts": [{"claim": "...", "evidenceIds": []}],
  "assumptions": ["..."],
  "missingInformation": [{"key": "...", "question": "...", "blocking": true/false, "decisionImpact": "..."}],
  "risks": [{"severity": "low"|"medium"|"high", "description": "..."}],
  "counterarguments": ["..."],
  "suggestedActions": ["..."]
}`;

    return prompt;
  }
}
