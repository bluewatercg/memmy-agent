import type { Repositories } from "../../storage/repositories.js";
import type { RuntimeNamespace, TopicAgentSpec, TopicDecisionSnapshotPayload } from "../../types.js";
import { newId, stableHash } from "../../utils/id.js";
import { nowIso } from "../../utils/time.js";
import type { LlmClient, LlmMessage, LlmCompletionOptions } from "../../model/types.js";
import type { TopicAgentPositionRecord, TopicDecisionSessionRecord, TopicDecisionSnapshotRecord } from "../../types.js";

export interface AgentPositionResult {
  judgment: string;
  confidence: number;
  evidenceIds: string[];
  facts: Array<{ claim: string; evidenceIds: string[] }>;
  assumptions: string[];
  missingInformation: Array<{ key: string; question: string; blocking: boolean; decisionImpact: string }>;
  risks: Array<{ severity: "low" | "medium" | "high"; description: string }>;
  counterarguments: string[];
  suggestedActions: string[];
}

export interface PositionParseError {
  code: "INVALID_JSON" | "UNKNOWN_JUDGMENT" | "INVALID_CONFIDENCE" | "UNKNOWN_EVIDENCE_CITATION" | "MISSING_FIELD";
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

  // Parse missingInformation
  const missingInformation = obj.missingInformation;
  if (!Array.isArray(missingInformation)) {
    return { code: "MISSING_FIELD", message: "missingInformation must be an array" };
  }

  for (const mi of missingInformation) {
    if (!mi || typeof mi !== "object") return { code: "MISSING_FIELD", message: "missingInformation item must be an object" };
    const m = mi as Record<string, unknown>;
    if (typeof m.key !== "string") return { code: "MISSING_FIELD", message: "missingInformation.key must be a string" };
    if (typeof m.question !== "string") return { code: "MISSING_FIELD", message: "missingInformation.question must be a string" };
    if (typeof m.blocking !== "boolean") return { code: "MISSING_FIELD", message: "missingInformation.blocking must be a boolean" };
    if (typeof m.decisionImpact !== "string") return { code: "MISSING_FIELD", message: "missingInformation.decisionImpact must be a string" };
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

  const suggestedActions = obj.suggestedActions;
  if (!Array.isArray(suggestedActions)) {
    return { code: "MISSING_FIELD", message: "suggestedActions must be an array" };
  }

  return {
    judgment,
    confidence,
    evidenceIds,
    facts: facts as AgentPositionResult["facts"],
    assumptions: assumptions as string[],
    missingInformation: missingInformation as AgentPositionResult["missingInformation"],
    risks: risks as AgentPositionResult["risks"],
    counterarguments: counterarguments as string[],
    suggestedActions: suggestedActions as string[]
  };
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
  ): Promise<void> {
    const namespaceId = stableHash(namespace);

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

    const snapshot = snapshots[snapshots.length - 1];
    const roster = snapshot.payload.roster;

    // Get existing positions to check for reuse
    const existingPositions = this.options.repos.topicDecisions.listPositions(
      namespaceId,
      sessionId,
      snapshot.id
    );

    const existingPositionMap = new Map(existingPositions.map(p => [p.agentId, p]));

    // Build valid evidence IDs set
    const validEvidenceIds = new Set(snapshot.payload.evidenceIds);

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
        const response = await llm.completeJson(messages, options);
        const parsed = parseAgentPosition(response, validEvidenceIds);

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
          rationale: parsed.facts.map(f => f.claim).join("; ") + " " + parsed.assumptions.join("; "),
          evidenceIds: parsed.evidenceIds,
          createdAt: nowIso()
        };

        return this.options.repos.topicDecisions.insertPosition(position);
      } catch (error) {
        // Store failed position
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

        // Still store the failed position for traceability
        this.options.repos.topicDecisions.insertPosition(failedPosition);
        throw error;
      }
    });

    await Promise.all(positionPromises);
  }

  private buildSystemPrompt(role: string): string {
    const rolePrompts: Record<string, string> = {
      evidence_analyst: "You are an evidence analyst. Analyze the provided evidence and determine if it supports or opposes the topic. Provide your judgment, confidence level, and identify any missing information needed.",
      domain_analyst: "You are a domain expert. Analyze the topic from your domain perspective. Identify facts, assumptions, and any gaps in knowledge that prevent a clear decision.",
      risk_challenger: "You are a risk challenger. Identify potential risks, counterarguments, and downsides to the topic. Be adversarial in your analysis.",
      action_planner: "You are an action planner. Based on the evidence and analysis, suggest concrete actions and their expected outcomes.",
      specialist: "You are a specialist. Provide expert analysis specific to your domain expertise."
    };

    return rolePrompts[role] || rolePrompts.specialist;
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
    prompt += `{
  "judgment": "support" | "oppose" | "neutral" | "unknown",
  "confidence": 0.0-1.0,
  "evidenceIds": ["evidence-id-1", ...],
  "facts": [{"claim": "...", "evidenceIds": [...]}],
  "assumptions": ["..."],
  "missingInformation": [{"key": "...", "question": "...", "blocking": true/false, "decisionImpact": "..."}],
  "risks": [{"severity": "low"|"medium"|"high", "description": "..."}],
  "counterarguments": ["..."],
  "suggestedActions": ["..."]
}`;

    return prompt;
  }
}
