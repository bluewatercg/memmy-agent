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
    const rawProposals = (response as { proposals?: unknown[] }).proposals;

    if (!Array.isArray(rawProposals)) {
      throw new Error("synthesis response must contain proposals array");
    }

    // Validate proposals
    const validatedProposals = this.validateProposals(rawProposals, validEvidenceIds, unresolvedConflicts);

    // Check majority-wrong scenario
    const majorityWrong = this.detectMajorityWrong(positions);
    if (majorityWrong && validatedProposals.length > 0) {
      // Proposals must explicitly depend on resolving the assumption
      const allAddressAssumption = validatedProposals.every(p => {
        const deps = p.dependencies;
        return deps.some(d => d.toLowerCase().includes("assumption"));
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
    rawProposals: unknown[],
    validEvidenceIds: Set<string>,
    unresolvedConflicts: TopicConflict[]
  ): SynthesizedProposal[] {
    // Reject rank 4+ (max 3 proposals)
    if (rawProposals.length > 3) {
      throw new Error(`max 3 proposals allowed, got ${rawProposals.length}`);
    }

    const validated: SynthesizedProposal[] = [];
    let recommendedCount = 0;

    for (const raw of rawProposals) {
      if (!raw || typeof raw !== "object") {
        throw new Error("proposal must be an object");
      }

      const p = raw as Record<string, unknown>;

      // Validate required fields
      const title = p.title;
      if (typeof title !== "string" || !title) throw new Error("proposal.title required");

      const benefit = p.benefit;
      if (typeof benefit !== "string" || !benefit) throw new Error("proposal.benefit required");

      const risk = p.risk;
      if (typeof risk !== "string" || !risk) throw new Error("proposal.risk required");

      const dependencies = p.dependencies;
      if (!Array.isArray(dependencies)) throw new Error("proposal.dependencies must be array");

      const reversible = p.reversible;
      if (typeof reversible !== "boolean") throw new Error("proposal.reversible must be boolean");

      const verificationPlan = p.verificationPlan;
      if (typeof verificationPlan !== "string" || !verificationPlan) throw new Error("proposal.verificationPlan required");

      // Validate action contract
      const effectClass = p.effectClass;
      if (typeof effectClass !== "string" || !VALID_EFFECTS.has(effectClass as TopicActionEffect)) {
        throw new Error(`proposal.effectClass invalid: ${effectClass}`);
      }

      const permission = p.permission;
      if (typeof permission !== "string" || !permission) throw new Error("proposal.permission required");

      const artifact = p.artifact;
      if (typeof artifact !== "string" || !artifact) throw new Error("proposal.artifact required");

      const acceptanceCondition = p.acceptanceCondition;
      if (typeof acceptanceCondition !== "string" || !acceptanceCondition) {
        throw new Error("proposal.acceptanceCondition required");
      }

      const recoveryPoint = p.recoveryPoint;
      if (typeof recoveryPoint !== "string" || !recoveryPoint) {
        throw new Error("proposal.recoveryPoint required");
      }

      // Validate evidence citations
      const evidenceIds = p.evidenceIds;
      if (!Array.isArray(evidenceIds)) throw new Error("proposal.evidenceIds must be array");

      for (const evId of evidenceIds) {
        if (typeof evId !== "string" || !validEvidenceIds.has(evId)) {
          throw new Error(`unknown evidence citation: ${evId}`);
        }
      }

      // Validate agent contributions
      const agentContributions = p.agentContributions;
      if (!Array.isArray(agentContributions)) throw new Error("proposal.agentContributions must be array");

      // Check recommended count
      const recommended = p.recommended;
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
        dependencies: dependencies as string[],
        reversible,
        rollbackPlan: p.rollbackPlan as string | undefined,
        verificationPlan,
        evidenceIds: evidenceIds as string[],
        effectClass: effectClass as TopicActionEffect,
        permission,
        artifact,
        acceptanceCondition,
        recoveryPoint,
        agentContributions: agentContributions as string[],
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

  private detectMajorityWrong(positions: TopicAgentPositionRecord[]): boolean {
    // Check if 3+ agents share one assumption and risk_challenger opposes
    const supportPositions = positions.filter(p => p.stance === "support");
    const opposePositions = positions.filter(p => p.stance === "oppose");

    if (supportPositions.length >= 3 && opposePositions.length >= 1) {
      // Check if risk_challenger is among opposers
      const riskChallengerOpposes = opposePositions.some(p =>
        p.agentId.includes("risk_challenger")
      );
      if (riskChallengerOpposes) {
        // Check if supporters share a common assumption
        const supportRationales = supportPositions.map(p => p.rationale.toLowerCase());
        const hasCommonAssumption = supportRationales.some(r => r.includes("assum"));
        const challengerIdentifiesIt = opposePositions.some(p =>
          p.agentId.includes("risk_challenger") &&
          (p.rationale.toLowerCase().includes("assum") || p.rationale.toLowerCase().includes("unsupported"))
        );
        return hasCommonAssumption && challengerIdentifiesIt;
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
