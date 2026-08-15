import { createHash } from "node:crypto";
import type { LlmClient } from "../../model/types.js";
import type { Repositories } from "../../storage/repositories.js";
import type { ProjectTopicCandidateRecord, RuntimeNamespace } from "../../types.js";
import { isRecord } from "../../utils/json.js";
import { nowIso } from "../../utils/time.js";
import { namespaceIdFromContext } from "../namespace/namespace-scope.js";

export type CandidateReviewRecommendation = "approve" | "edit_and_approve" | "defer" | "reject";

export interface CandidateReviewEdits {
  title?: string;
  conclusion?: string;
  proposedLayer?: "L2" | "L3" | "Skill";
}

export interface CandidateModelReview {
  model: string;
  recommendation: CandidateReviewRecommendation;
  confidence: number;
  reasoning: string;
  concerns: string[];
  evidenceGaps: string[];
  suggestedEdits?: CandidateReviewEdits;
  error?: string;
}

export interface CandidateReviewSummary {
  recommendation: CandidateReviewRecommendation;
  confidence: number;
  summary: string;
  suggestedEdits?: CandidateReviewEdits;
  reviews: CandidateModelReview[];
}

export interface CandidateReviewInput {
  candidate: {
    id: string;
    title: string;
    conclusion: string;
    proposedLayer: "L2" | "L3" | "Skill";
  };
  evidence: Array<{ id: string; role: string | string[]; summary: string }>;
  reviewers: LlmClient[];
}

const REVIEW_SCHEMA = `Return exactly one JSON object:
{
  "recommendation": "approve | edit_and_approve | defer | reject",
  "confidence": 0.0,
  "reasoning": "specific evidence-bound reason",
  "concerns": ["concrete concern"],
  "evidenceGaps": ["missing evidence"],
  "suggestedEdits": { "title": "optional", "conclusion": "optional", "proposedLayer": "L2 | L3 | Skill" }
}
Approve only when the conclusion is reusable, scoped, supported by cited evidence, and safe at the proposed layer. Use edit_and_approve only with concrete edits. Defer when evidence is insufficient or conflicting. Reject when the conclusion is wrong, unsafe, noise, or not reusable.`;

export function aggregateCandidateReviews(reviews: CandidateModelReview[]): CandidateReviewSummary {
  const valid = reviews.filter((review) => !review.error);
  const counts: Record<CandidateReviewRecommendation, number> = { approve: 0, edit_and_approve: 0, defer: 0, reject: 0 };
  for (const review of valid) counts[review.recommendation] += 1;

  let recommendation: CandidateReviewRecommendation = "defer";
  const rejectionCount = counts.reject;
  const approvalCount = counts.approve + counts.edit_and_approve;
  if (valid.length >= 2 && rejectionCount >= 2) recommendation = "reject";
  else if (valid.length >= 2 && approvalCount >= 2 && rejectionCount === 0) {
    recommendation = counts.edit_and_approve > 0 ? "edit_and_approve" : "approve";
  }

  const relevant = valid.filter((review) => recommendation === "edit_and_approve"
    ? review.recommendation === "edit_and_approve" || review.recommendation === "approve"
    : review.recommendation === recommendation);
  const confidence = relevant.length
    ? relevant.reduce((sum, review) => sum + review.confidence, 0) / relevant.length
    : 0;
  const editReview = valid
    .filter((review) => review.recommendation === "edit_and_approve" && review.suggestedEdits)
    .sort((left, right) => right.confidence - left.confidence)[0];
  const summary = valid.length < 2
    ? "有效评审不足两份，建议延后。"
    : valid.map((review) => `${review.model}: ${review.reasoning}`).join("\n");

  return {
    recommendation,
    confidence,
    summary,
    ...(recommendation === "edit_and_approve" && editReview?.suggestedEdits ? { suggestedEdits: editReview.suggestedEdits } : {}),
    reviews
  };
}

export async function reviewCandidateWithModels(input: CandidateReviewInput): Promise<CandidateReviewSummary> {
  const settled = await Promise.all(input.reviewers.map(async (reviewer): Promise<CandidateModelReview> => {
    const model = reviewer.config.model || reviewer.config.provider || "unknown";
    try {
      const value = await reviewer.completeJson<Record<string, unknown>>([
        { role: "system", content: `You are one independent reviewer in a multi-model memory governance panel. ${REVIEW_SCHEMA}` },
        { role: "user", content: JSON.stringify({ candidate: input.candidate, evidence: input.evidence }) }
      ], {
        operation: `topic.inbox.candidate.review.${model}`,
        temperature: 0,
        jsonMode: true,
        thinkingMode: "enabled"
      });
      return parseModelReview(model, value);
    } catch (error) {
      return {
        model,
        recommendation: "defer",
        confidence: 0,
        reasoning: "评审模型调用失败。",
        concerns: [],
        evidenceGaps: [],
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }));
  return aggregateCandidateReviews(settled);
}

export class CandidateReviewService {
  constructor(private readonly deps: {
    repos: Repositories;
    reviewers: () => LlmClient[];
    now?: () => string;
  }) {}

  async review(namespace: RuntimeNamespace, candidateId: string, force = false): Promise<{ candidate: ProjectTopicCandidateRecord; summary: CandidateReviewSummary; cached: boolean }> {
    const namespaceId = namespaceIdFromContext(namespace);
    const candidate = this.deps.repos.topics.getCandidate(candidateId, namespaceId);
    if (!candidate) throw new Error(`topic candidate not found in namespace: ${candidateId}`);

    const evidenceById = new Map(this.deps.repos.topics.listEvidence(candidate.topicId, namespaceId).map((item) => [item.memoryId, item]));
    const evidence = candidate.sourceMemoryIds.flatMap((id) => {
      const item = evidenceById.get(id);
      return item ? [{ id, role: item.role, summary: item.summary }] : [];
    });
    const reviewers = this.deps.reviewers().filter((reviewer) => reviewer.isConfigured());
    const inputFingerprint = candidateReviewFingerprint(candidate, evidence, reviewers);
    const cachedRecord = isRecord(candidate.metadata.aiReview) ? candidate.metadata.aiReview : undefined;
    const cached = candidateReviewFromMetadata(cachedRecord);
    if (cached && cachedRecord?.inputFingerprint === inputFingerprint && !force) return { candidate, summary: cached, cached: true };

    const summary = await reviewCandidateWithModels({
      candidate: { id: candidate.id, title: candidate.title, conclusion: candidate.conclusion, proposedLayer: candidate.proposedLayer },
      evidence,
      reviewers
    });
    const at = this.deps.now?.() ?? nowIso();
    const updated = this.deps.repos.topics.updateCandidate({
      ...candidate,
      version: candidate.version + 1,
      metadata: { ...candidate.metadata, aiReview: { ...summary, reviewedAt: at, inputFingerprint } },
      updatedAt: at
    }, candidate.version);
    return { candidate: updated, summary, cached: false };
  }
}

function parseModelReview(model: string, value: unknown): CandidateModelReview {
  if (!isRecord(value)) throw new Error("invalid candidate review result");
  const recommendation = value.recommendation;
  if (recommendation !== "approve" && recommendation !== "edit_and_approve" && recommendation !== "defer" && recommendation !== "reject") throw new Error("invalid candidate review recommendation");
  if (typeof value.confidence !== "number" || !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1) throw new Error("invalid candidate review confidence");
  if (typeof value.reasoning !== "string" || !value.reasoning.trim()) throw new Error("invalid candidate review reasoning");
  const suggestedEdits = parseEdits(value.suggestedEdits);
  if (recommendation === "edit_and_approve" && !suggestedEdits) throw new Error("edit_and_approve requires suggested edits");
  return {
    model,
    recommendation,
    confidence: value.confidence,
    reasoning: value.reasoning.trim(),
    concerns: stringArray(value.concerns),
    evidenceGaps: stringArray(value.evidenceGaps),
    ...(suggestedEdits ? { suggestedEdits } : {})
  };
}

function parseEdits(value: unknown): CandidateReviewEdits | undefined {
  if (!isRecord(value)) return undefined;
  const edits: CandidateReviewEdits = {};
  if (typeof value.title === "string" && value.title.trim()) edits.title = value.title.trim();
  if (typeof value.conclusion === "string" && value.conclusion.trim()) edits.conclusion = value.conclusion.trim();
  if (value.proposedLayer === "L2" || value.proposedLayer === "L3" || value.proposedLayer === "Skill") edits.proposedLayer = value.proposedLayer;
  return Object.keys(edits).length ? edits : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim()) : [];
}

function candidateReviewFingerprint(
  candidate: ProjectTopicCandidateRecord,
  evidence: CandidateReviewInput["evidence"],
  reviewers: LlmClient[]
): string {
  const input = {
    candidate: { id: candidate.id, title: candidate.title, conclusion: candidate.conclusion, proposedLayer: candidate.proposedLayer },
    evidence,
    reviewers: reviewers.map((reviewer) => ({ provider: reviewer.config.provider, model: reviewer.config.model }))
  };
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function candidateReviewFromMetadata(value: unknown): CandidateReviewSummary | undefined {
  if (!isRecord(value) || !Array.isArray(value.reviews)) return undefined;
  const recommendation = value.recommendation;
  if (recommendation !== "approve" && recommendation !== "edit_and_approve" && recommendation !== "defer" && recommendation !== "reject") return undefined;
  if (typeof value.confidence !== "number" || typeof value.summary !== "string") return undefined;
  return value as unknown as CandidateReviewSummary;
}
