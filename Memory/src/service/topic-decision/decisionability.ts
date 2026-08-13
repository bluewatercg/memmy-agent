import type { Repositories } from "../../storage/repositories.js";
import type { TopicDecisionSnapshotPayload, TopicDecisionSessionRecord, TopicAgentPositionRecord } from "../../types.js";
import { newId, stableHash } from "../../utils/id.js";
import { nowIso } from "../../utils/time.js";
import { EvidenceAcquisitionService } from "./evidence-acquisition.js";

export interface OpenQuestion {
  question: string;
  whyNeeded: string;
  decisionImpact: string;
  key: string;
  agentId: string;
}

export interface DecisionabilityResult {
  status: "gathering_evidence" | "awaiting_user_input" | "blocked_by_evidence" | "ready" | "debating";
  blockingGaps: string[];
  openQuestions?: OpenQuestion[];
  summary?: string;
}

/**
 * Normalize question key for deduplication.
 */
function normalizeQuestionKey(question: string): string {
  // Remove punctuation, lowercase, trim
  return question
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .trim()
    .split(/\s+/)
    .slice(0, 5)
    .join("_");
}

/**
 * Score question by decision impact for prioritization.
 */
function scoreDecisionImpact(impact: string): number {
  const impactLower = impact.toLowerCase();
  if (impactLower.includes("block") || impactLower.includes("critical")) return 100;
  if (impactLower.includes("high") || impactLower.includes("significant")) return 75;
  if (impactLower.includes("medium") || impactLower.includes("moderate")) return 50;
  if (impactLower.includes("low") || impactLower.includes("minor")) return 25;
  return 50; // default
}

export class DecisionabilityService {
  private readonly options: { repos: Repositories };

  constructor(
    options: { repos: Repositories },
    private readonly evidenceAcquisition: EvidenceAcquisitionService
  ) {
    this.options = options;
  }

  /**
   * Check if a decision can be made based on current positions and evidence.
   * Returns the decisionability status and any open questions.
   */
  async checkDecisionability(
    namespaceId: string,
    sessionId: string,
    snapshot: { id: string; payload: TopicDecisionSnapshotPayload }
  ): Promise<DecisionabilityResult> {
    // Get all positions
    const positions = this.options.repos.topicDecisions.listPositions(
      namespaceId,
      sessionId,
      snapshot.id
    );

    if (positions.length === 0) {
      return {
        status: "gathering_evidence",
        blockingGaps: [],
        openQuestions: []
      };
    }

    // Check for contradictions in stances
    const stances = new Set(positions.map(p => p.stance));
    const hasContradictions = stances.has("support") && stances.has("oppose");

    // Extract all missing information
    const allGaps: Array<{
      key: string;
      question: string;
      blocking: boolean;
      decisionImpact: string;
      agentId: string;
    }> = [];

    for (const pos of positions) {
      if (pos.stance === "unknown") {
        // Unknown stance = missing information
        const key = normalizeQuestionKey(pos.rationale || "unknown");
        allGaps.push({
          key,
          question: pos.rationale || "What information is needed?",
          blocking: true,
          decisionImpact: "high",
          agentId: pos.agentId
        });
      }

      // Also check for explicit missing information in rationale
      const rationaleLower = pos.rationale.toLowerCase();
      if (
        rationaleLower.includes("need") ||
        rationaleLower.includes("missing") ||
        rationaleLower.includes("unknown")
      ) {
        const key = normalizeQuestionKey(pos.rationale);
        // Only add if not already present
        if (!allGaps.some(g => g.key === key)) {
          allGaps.push({
            key,
            question: pos.rationale,
            blocking: true,
            decisionImpact: "medium",
            agentId: pos.agentId
          });
        }
      }
    }

    // Deduplicate gaps by normalized key
    const uniqueGaps = allGaps.reduce((acc, gap) => {
      if (!acc.some(g => g.key === gap.key)) {
        acc.push(gap);
      }
      return acc;
    }, [] as typeof allGaps);

    // Sort by decision impact and take top 3
    const topGaps = uniqueGaps
      .sort((a, b) => scoreDecisionImpact(b.decisionImpact) - scoreDecisionImpact(a.decisionImpact))
      .slice(0, 3);

    // Check if any gap is blocking
    const blockingGaps = topGaps.filter(g => g.blocking).map(g => g.key);

    // Try automatic evidence acquisition first
    const autoResult = await this.evidenceAcquisition.attemptAutoAcquisition(
      namespaceId,
      sessionId,
      snapshot
    );

    // Determine final status - contradictions alone block decision
    let status: DecisionabilityResult["status"];

    if (hasContradictions) {
      status = "blocked_by_evidence";
    } else if (autoResult.state === "ready") {
      status = "ready";
    } else if (blockingGaps.length > 0) {
      status = "blocked_by_evidence";
    } else if (topGaps.length > 0) {
      status = "awaiting_user_input";
    } else {
      status = "ready";
    }

    // Build open questions with required fields
    const openQuestions: OpenQuestion[] = topGaps.map(gap => ({
      question: gap.question,
      whyNeeded: `Needed by ${gap.agentId} to form a position`,
      decisionImpact: gap.decisionImpact,
      key: gap.key,
      agentId: gap.agentId
    }));

    return {
      status,
      blockingGaps,
      openQuestions,
      summary: this.buildSummary(status, positions.length, topGaps.length)
    };
  }

  /**
   * Group gaps by normalized key for deduplication.
   */
  groupGapsByKey(
    gaps: Array<{ key: string; question: string; blocking: boolean; decisionImpact: string }>
  ): Map<string, typeof gaps> {
    const groups = new Map<string, typeof gaps>();

    for (const gap of gaps) {
      const normalizedKey = normalizeQuestionKey(gap.key);
      const existing = groups.get(normalizedKey) || [];
      existing.push(gap);
      groups.set(normalizedKey, existing);
    }

    return groups;
  }

  private buildSummary(
    status: DecisionabilityResult["status"],
    positionCount: number,
    gapCount: number
  ): string {
    switch (status) {
      case "ready":
        return `${positionCount} positions analyzed, ready for decision`;
      case "blocked_by_evidence":
        return `${positionCount} positions analyzed, ${gapCount} blocking gaps require evidence`;
      case "awaiting_user_input":
        return `${positionCount} positions analyzed, ${gapCount} questions need user input`;
      case "gathering_evidence":
        return "Gathering evidence for analysis";
      case "debating":
        return "Debate in progress";
      default:
        return "Analyzing positions";
    }
  }
}
