import type { Repositories } from "../../storage/repositories.js";
import type {
  RuntimeNamespace,
  TopicActionEffect,
  TopicActionProposalRecord,
  TopicAgentPositionRecord,
  TopicDecisionSnapshotPayload
} from "../../types.js";
import { newId, stableHash } from "../../utils/id.js";
import { nowIso } from "../../utils/time.js";
import type { LlmClient, LlmCompletionOptions, LlmMessage } from "../../model/types.js";
import type { TopicConflict } from "./debate-orchestrator.js";

export interface ProposalActionContract {
  effectClass: TopicActionEffect;
  permission: string;
  artifact: string;
  acceptanceCondition: string;
  recoveryPoint: string;
}

export interface SynthesizedProposal {
  title: string;
  benefit: string;
  risk: string;
  dependencies: string[];
  reversible: boolean;
  rollbackPlan?: string;
  verificationPlan: string;
  evidenceIds: string[];
  effectClass: TopicActionEffect;
  permission: string;
  artifact: string;
  acceptanceCondition: string;
  recoveryPoint: string;
  agentContributions: string[];
  recommended?: boolean;
}

export interface ProposalSynthesisOptions {
  repos: Repositories;
  createLlmClient: (model: string) => LlmClient;
}

const VALID_EFFECTS: Set<TopicActionEffect> = new Set([
  "read", "analyze", "draft", "create_candidate_task",
  "authoritative_write", "external_write", "delete",
  "topic_mutation", "memory_promotion"
]);

export class ProposalSynthesis {
  constructor(private readonly options: ProposalSynthesisOptions) {}

  async synthesizeProposals(
    namespace: RuntimeNamespace,
    sessionId: string
  ): Promise<{ proposals: TopicActionProposalRecord[]; finalState: string }> {
    const namespaceId = stableHash(namespace);
    const session = this.options.repos.topicDecisions.getSession(namespaceId, sessionId);
    if (!session) throw new Error(`session not found: ${sessionId}`);

    const snapshots = this.options.repos.topicDecisions.getSnapshotsForSession(namespaceId, sessionId);
    if (snapshots.length === 0) throw new Error(`no snapshot found for session: ${sessionId}`);

    const snapshot = snapshots[snapshots.length - 1]!;
    const positions = this.options.repos.topicDecisions.listPositions(namespaceId, sessionId, snapshot.id);
    const validEvidenceIds = new Set(snapshot.payload.evidenceIds);
    const roster = snapshot.payload.roster;

    // Check for blocking gaps
    const blockingGaps = this.detectBlockingGaps(positions);
    if (blockingGaps.length > 0) {
      // Zero proposals when blocking gap exists
      return { proposals: [], finalState: "blocked_by_evidence" };
    }

    // Get unresolved conflicts from debate rounds
    const rounds = this.options.repos.topicDecisions.listRounds(namespaceId, sessionId);
    const unresolvedConflicts = this.getUnresolvedConflicts(rounds);

    // Call LLM synthesizer
    const synthesizerModel = snapshot.payload.roster[0]?.model || "MiniMax-M2.5";
    const llm = this.options.createLlmClient(synthesizerModel);

    const operation = "topic.decision.synthesize";
    const messages: LlmMessage[] = [
      { role: "system", content: this.buildSynthesisSystemPrompt() },
      { role: "user", content: this.buildSynthesisUserPrompt(snapshot.payload, positions, unresolvedConflicts) }
    ];

    const llmOptions: LlmCompletionOptions = {
      operation,
      temperature: 0,
      jsonMode: true
    };

    const response = await llm.completeJson(messages, llmOptions);

    // Strict schema validation before business logic
    const parsed = parseSynthesisResponse(response);

    // Validate proposals (business rules)
    const validatedProposals = this.validateProposals(parsed.proposals, validEvidenceIds, unresolvedConflicts);

    // Check majority-wrong scenario using structured assumptions and roster role lookup
    const majorityWrong = this.detectMajorityWrong(positions, roster, rounds);
    if (majorityWrong && validatedProposals.length > 0) {
      // Proposals must explicitly depend on resolving the assumption
      const allAddressAssumption = validatedProposals.every(p => {
        const deps = p.dependencies;
        return deps.some(d => d.toLowerCase().includes("assumption") || d.toLowerCase().includes("resolve"));
      });
      if (!allAddressAssumption) {
        throw new Error("majority-wrong scenario: proposals must explicitly depend on resolving the unsupported assumption identified by risk_challenger");
      }
    }

    // Persist proposals
    const now = nowIso();
    const proposalRecords: TopicActionProposalRecord[] = [];

    for (let i = 0; i < validatedProposals.length; i++) {
      const proposal = validatedProposals[i]!;
      const record = this.options.repos.topicDecisions.insertProposal({
        id: newId("tdprop"),
        namespaceId,
        sessionId,
        round: snapshot.round,
        rank: i + 1,
        effect: proposal.effectClass,
        title: proposal.title,
        payload: {
          benefit: proposal.benefit,
          risk: proposal.risk,
          dependencies: proposal.dependencies,
          reversible: proposal.reversible,
          rollbackPlan: proposal.rollbackPlan,
          verificationPlan: proposal.verificationPlan,
          evidenceIds: proposal.evidenceIds,
          agentContributions: proposal.agentContributions
        },
        status: "draft",
        version: 1,
        metadata: {
          recommended: proposal.recommended || false,
          acceptanceCondition: proposal.acceptanceCondition,
          recoveryPoint: proposal.recoveryPoint,
          artifact: proposal.artifact,
          permission: proposal.permission
        },
        createdAt: now,
        updatedAt: now
      });
      proposalRecords.push(record);
    }

    // Update session to ready_for_decision
    const currentSession = this.options.repos.topicDecisions.getSession(namespaceId, sessionId)!;
    this.options.repos.topicDecisions.updateSession(
      { ...currentSession, state: "ready_for_decision", version: currentSession.version + 1, updatedAt: nowIso() },
      currentSession.version
    );

    return { proposals: proposalRecords, finalState: "ready_for_decision" };
  }

  private detectBlockingGaps(positions: TopicAgentPositionRecord[]): string[] {
    const gaps: string[] = [];
    for (const pos of positions) {
      if (pos.stance === "unknown") {
        gaps.push(`Agent ${pos.agentId} unable to form position: ${pos.rationale}`);
      }
    }
    return gaps;
  }

  private getUnresolvedConflicts(
    rounds: Array<{ metadata: Record<string, unknown> }>
  ): TopicConflict[] {
    const allConflicts: TopicConflict[] = [];
    for (const round of rounds) {
      const conflicts = round.metadata.conflicts as TopicConflict[] | undefined;
      if (conflicts) {
        allConflicts.push(...conflicts);
      }
    }
    return allConflicts.filter(c => !c.resolved);
  }

  private validateProposals(
    rawProposals: Array<Record<string, unknown>>,
    validEvidenceIds: Set<string>,
    unresolvedConflicts: TopicConflict[]
  ): SynthesizedProposal[] {
    // Reject rank 4+ (max 3 proposals)
    if (rawProposals.length > 3) {
      throw new Error(`max 3 proposals allowed, got ${rawProposals.length}`);
    }

    const validated: SynthesizedProposal[] = [];
    let recommendedCount = 0;

    for (const p of rawProposals) {
      // All fields already validated by parseSynthesisResponse
      const title = p.title as string;
      const benefit = p.benefit as string;
      const risk = p.risk as string;
      const dependencies = p.dependencies as string[];
      const reversible = p.reversible as boolean;
      const verificationPlan = p.verificationPlan as string;
      const evidenceIds = p.evidenceIds as string[];
      const effectClass = p.effectClass as TopicActionEffect;
      const permission = p.permission as string;
      const artifact = p.artifact as string;
      const acceptanceCondition = p.acceptanceCondition as string;
      const recoveryPoint = p.recoveryPoint as string;
      const agentContributions = p.agentContributions as string[];
      const recommended = p.recommended as boolean | undefined;

      // Validate evidence citations
      for (const evId of evidenceIds) {
        if (!validEvidenceIds.has(evId)) {
          throw new Error(`unknown evidence citation: ${evId}`);
        }
      }

      // Check recommended count
      if (recommended === true) {
        recommendedCount++;
        if (recommendedCount > 1) {
          throw new Error("only one proposal can be recommended");
        }
      }

      validated.push({
        title,
        benefit,
        risk,
        dependencies,
        reversible,
        rollbackPlan: p.rollbackPlan as string | undefined,
        verificationPlan,
        evidenceIds,
        effectClass,
        permission,
        artifact,
        acceptanceCondition,
        recoveryPoint,
        agentContributions,
        recommended: recommended === true
      });
    }

    // Check unresolved high-risk conflicts
    const unresolvedHigh = unresolvedConflicts.filter(c => c.severity === "high");
    if (unresolvedHigh.length > 0 && validated.length > 0) {
      // Proposals must address unresolved high-risk conflicts
      const allAddressConflicts = validated.every(p => {
        const deps = p.dependencies;
        const mentionsConflict = deps.some(d =>
          unresolvedHigh.some(c => d.toLowerCase().includes(c.claim.toLowerCase().slice(0, 20)))
        );
        // Or the proposal explicitly notes the conflict in risk
        const riskMentionsConflict = unresolvedHigh.some(c =>
          p.risk.toLowerCase().includes(c.claim.toLowerCase().slice(0, 20))
        );
        return mentionsConflict || riskMentionsConflict;
      });

      if (!allAddressConflicts) {
        throw new Error("proposals must address unresolved high-risk conflicts");
      }
    }

    return validated;
  }

  private detectMajorityWrong(
    positions: TopicAgentPositionRecord[],
    roster: Array<{ id: string; role: string; model: string }>,
    rounds: Array<{ metadata: Record<string, unknown> }>
  ): boolean {
    // Check if 3+ agents share one assumption and risk_challenger opposes
    const supportPositions = positions.filter(p => p.stance === "support");
    const opposePositions = positions.filter(p => p.stance === "oppose");

    if (supportPositions.length >= 3 && opposePositions.length >= 1) {
      // Use roster role lookup instead of agentId substring
      const riskChallengerOpposes = opposePositions.some(p => {
        const agent = roster.find(a => a.id === p.agentId);
        return agent?.role === "risk_challenger";
      });

      if (riskChallengerOpposes) {
        // Use structured assumptions from positions (fallback to LLM round deltas)
        const supportAssumptions = supportPositions.flatMap(p => p.assumptions ?? []);
        const challengerAssumptions = opposePositions
          .filter(p => {
            const agent = roster.find(a => a.id === p.agentId);
            return agent?.role === "risk_challenger";
          })
          .flatMap(p => p.assumptions ?? []);

        // If structured assumptions available, check for overlap
        if (supportAssumptions.length > 0 && challengerAssumptions.length > 0) {
          const supportSet = new Set(supportAssumptions.map(a => a.toLowerCase()));
          const hasChallengedAssumption = challengerAssumptions.some(a => supportSet.has(a.toLowerCase()));
          return hasChallengedAssumption;
        }

        // Fallback: check LLM round deltas for structured assumptions
        for (const round of rounds) {
          const llmResponses = (round.metadata.deltas as Record<string, unknown>)?.llmResponses as Array<{ agentId: string; response: { assumptions?: string[] } }> | undefined;
          if (llmResponses) {
            const supportAssumptionsFromLlm = llmResponses
              .filter(r => supportPositions.some(p => p.agentId === r.agentId))
              .flatMap(r => r.response.assumptions ?? []);
            const challengerAssumptionsFromLlm = llmResponses
              .filter(r => {
                const agent = roster.find(a => a.id === r.agentId);
                return agent?.role === "risk_challenger";
              })
              .flatMap(r => r.response.assumptions ?? []);

            if (supportAssumptionsFromLlm.length > 0 && challengerAssumptionsFromLlm.length > 0) {
              const supportSet = new Set(supportAssumptionsFromLlm.map(a => a.toLowerCase()));
              const hasChallengedAssumption = challengerAssumptionsFromLlm.some(a => supportSet.has(a.toLowerCase()));
              return hasChallengedAssumption;
            }
          }
        }
      }
    }

    return false;
  }

  private buildSynthesisSystemPrompt(): string {
    return `You are a proposal synthesizer. Given the current evidence, agent positions, and unresolved conflicts, synthesize 1-3 materially distinct action proposals. Each proposal must include benefit, risk, dependencies, reversible flag, rollback plan (where relevant), verification plan, cited evidence IDs, and agent contribution summary. Malformed or uncited outputs will be rejected.`;
  }

  private buildSynthesisUserPrompt(
    payload: TopicDecisionSnapshotPayload,
    positions: TopicAgentPositionRecord[],
    unresolvedConflicts: TopicConflict[]
  ): string {
    let prompt = `# Proposal Synthesis Context\n\n`;

    prompt += `## Evidence\n`;
    for (const evId of payload.evidenceIds) {
      const content = payload.evidenceContent[evId] || "[no content]";
      prompt += `- ${evId}: ${content}\n`;
    }

    prompt += `\n## Agent Positions\n`;
    for (const pos of positions) {
      prompt += `- ${pos.agentId}: ${pos.stance} — ${pos.rationale}\n`;
    }

    if (unresolvedConflicts.length > 0) {
      prompt += `\n## Unresolved Conflicts\n`;
      for (const conflict of unresolvedConflicts) {
        prompt += `- [${conflict.severity}] ${conflict.claim}\n`;
      }
    }

    prompt += `\n## Response Format\n`;
    prompt += `{\n  "proposals": [\n    {\n      "title": "...",\n      "benefit": "...",\n      "risk": "...",\n      "dependencies": [...],\n      "reversible": true/false,\n      "rollbackPlan": "...",\n      "verificationPlan": "...",\n      "evidenceIds": [...],\n      "effectClass": "read"|"analyze"|"draft"|...,\n      "permission": "...",\n      "artifact": "...",\n      "acceptanceCondition": "...",\n      "recoveryPoint": "...",\n      "agentContributions": [...],\n      "recommended": true/false\n    }\n  ]\n}`;

    return prompt;
  }
}

/**
 * Strict parser/type guard for LLM synthesis responses.
 * Validates the full nested schema before business validation.
 * Malformed nested fields fail with actionable domain errors.
 */
function parseSynthesisResponse(raw: unknown): { proposals: Array<Record<string, unknown>> } {
  if (!raw || typeof raw !== "object") {
    throw new Error("synthesis response must be an object");
  }

  const r = raw as Record<string, unknown>;
  const rawProposals = r.proposals;

  if (!Array.isArray(rawProposals)) {
    throw new Error("synthesis response must contain proposals array");
  }

  // Reject rank 4+ (max 3 proposals)
  if (rawProposals.length > 3) {
    throw new Error(`max 3 proposal allowed, got ${rawProposals.length}`);
  }

  const validated: Array<Record<string, unknown>> = [];

  for (let i = 0; i < rawProposals.length; i++) {
    const raw = rawProposals[i];
    if (!raw || typeof raw !== "object") {
      throw new Error(`proposal[${i}] must be an object`);
    }

    const p = raw as Record<string, unknown>;

    // Validate all required fields with actionable errors
    const title = p.title;
    if (typeof title !== "string" || !title) throw new Error(`proposal[${i}].title must be non-empty string`);

    const benefit = p.benefit;
    if (typeof benefit !== "string" || !benefit) throw new Error(`proposal[${i}].benefit must be non-empty string`);

    const risk = p.risk;
    if (typeof risk !== "string" || !risk) throw new Error(`proposal[${i}].risk must be non-empty string`);

    const dependencies = p.dependencies;
    if (!Array.isArray(dependencies)) throw new Error(`proposal[${i}].dependencies must be array`);
    for (const dep of dependencies) {
      if (typeof dep !== "string") throw new Error(`proposal[${i}].dependencies items must be strings`);
    }

    const reversible = p.reversible;
    if (typeof reversible !== "boolean") throw new Error(`proposal[${i}].reversible must be boolean`);

    const rollbackPlan = p.rollbackPlan;
    if (rollbackPlan !== undefined && typeof rollbackPlan !== "string") {
      throw new Error(`proposal[${i}].rollbackPlan must be string if present`);
    }

    const verificationPlan = p.verificationPlan;
    if (typeof verificationPlan !== "string" || !verificationPlan) throw new Error(`proposal[${i}].verificationPlan must be non-empty string`);

    const evidenceIds = p.evidenceIds;
    if (!Array.isArray(evidenceIds)) throw new Error(`proposal[${i}].evidenceIds must be array`);
    for (const evId of evidenceIds) {
      if (typeof evId !== "string") throw new Error(`proposal[${i}].evidenceIds items must be strings`);
    }

    const effectClass = p.effectClass;
    if (typeof effectClass !== "string" || !VALID_EFFECTS.has(effectClass as TopicActionEffect)) {
      throw new Error(`proposal[${i}].effectClass invalid: ${JSON.stringify(effectClass)}`);
    }

    const permission = p.permission;
    if (typeof permission !== "string" || !permission) throw new Error(`proposal[${i}].permission must be non-empty string`);

    const artifact = p.artifact;
    if (typeof artifact !== "string" || !artifact) throw new Error(`proposal[${i}].artifact must be non-empty string`);

    const acceptanceCondition = p.acceptanceCondition;
    if (typeof acceptanceCondition !== "string" || !acceptanceCondition) {
      throw new Error(`proposal[${i}].acceptanceCondition must be non-empty string`);
    }

    const recoveryPoint = p.recoveryPoint;
    if (typeof recoveryPoint !== "string" || !recoveryPoint) {
      throw new Error(`proposal[${i}].recoveryPoint must be non-empty string`);
    }

    const agentContributions = p.agentContributions;
    if (!Array.isArray(agentContributions)) throw new Error(`proposal[${i}].agentContributions must be array`);
    for (const ac of agentContributions) {
      if (typeof ac !== "string") throw new Error(`proposal[${i}].agentContributions items must be strings`);
    }

    const recommended = p.recommended;
    if (recommended !== undefined && typeof recommended !== "boolean") {
      throw new Error(`proposal[${i}].recommended must be boolean if present`);
    }

    validated.push(p);
  }

  return { proposals: validated };
}
