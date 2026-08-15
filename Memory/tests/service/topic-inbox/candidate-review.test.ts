import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_MEMMY_CONFIG, Repositories } from "../../../src/index.js";
import type { LlmClient, LlmCompletionOptions, LlmMessage } from "../../../src/model/types.js";
import { namespaceIdFromContext } from "../../../src/service/namespace/namespace-scope.js";
import {
  aggregateCandidateReviews,
  CandidateReviewService,
  reviewCandidateWithModels,
  type CandidateModelReview
} from "../../../src/service/topic-inbox/candidate-review.js";
import { createMemoryServiceFixture } from "../../fixtures/memory-service-fixture.js";

const fixture = createMemoryServiceFixture();
afterEach(fixture.cleanup);

function reviewer(model: string, result: Record<string, unknown> | Error, calls: string[]): LlmClient {
  return {
    config: { ...DEFAULT_MEMMY_CONFIG.evolution, provider: "openai_compatible", endpoint: "http://test", model },
    isConfigured: () => true,
    complete: async () => "{}",
    completeJson: async <T extends Record<string, unknown>>(_messages: LlmMessage[], options: LlmCompletionOptions) => {
      calls.push(options.operation);
      if (result instanceof Error) throw result;
      return result as T;
    },
    status: () => ({ provider: "openai_compatible", model, configured: true, remote: true })
  };
}

function review(model: string, recommendation: CandidateModelReview["recommendation"], confidence = 0.8, suggestedEdits?: CandidateModelReview["suggestedEdits"]): CandidateModelReview {
  return { model, recommendation, confidence, reasoning: `${model}: ${recommendation}`, concerns: [], evidenceGaps: [], suggestedEdits };
}

describe("aggregateCandidateReviews", () => {
  it("recommends approval only with at least two approvals and no rejection", () => {
    const result = aggregateCandidateReviews([
      review("qwen3.7-plus", "approve", 0.9),
      review("kimi-k2.5", "approve", 0.8),
      review("glm-5", "defer", 0.7)
    ]);
    expect(result.recommendation).toBe("approve");
    expect(result.confidence).toBeCloseTo(0.85);
  });

  it("prefers a concrete edit when approval and edit recommendations agree on acceptance", () => {
    const edits = { title: "Verify schema migrations", conclusion: "Run the focused migration test after every schema change.", proposedLayer: "L2" as const };
    const result = aggregateCandidateReviews([
      review("qwen3.7-plus", "edit_and_approve", 0.92, edits),
      review("kimi-k2.5", "approve", 0.84),
      review("glm-5", "defer", 0.6)
    ]);
    expect(result.recommendation).toBe("edit_and_approve");
    expect(result.suggestedEdits).toEqual(edits);
  });

  it("recommends rejection when two reviewers reject", () => {
    const result = aggregateCandidateReviews([
      review("qwen3.7-plus", "reject", 0.91),
      review("kimi-k2.5", "reject", 0.82),
      review("glm-5", "approve", 0.7)
    ]);
    expect(result.recommendation).toBe("reject");
  });

  it("defers split decisions and fewer than two successful reviews", () => {
    expect(aggregateCandidateReviews([
      review("qwen3.7-plus", "approve"),
      review("kimi-k2.5", "reject"),
      review("glm-5", "defer")
    ]).recommendation).toBe("defer");
    expect(aggregateCandidateReviews([review("qwen3.7-plus", "approve")]).recommendation).toBe("defer");
  });
});

describe("reviewCandidateWithModels", () => {
  it("calls configured reviewers independently and degrades failed models", async () => {
    const calls: string[] = [];
    const result = await reviewCandidateWithModels({
      candidate: {
        id: "candidate-1",
        title: "Verify migrations",
        conclusion: "Run the focused migration test.",
        proposedLayer: "L2"
      },
      evidence: [{ id: "memory-1", role: "verification", summary: "Focused migration test passed." }],
      reviewers: [
        reviewer("qwen3.7-plus", { recommendation: "approve", confidence: 0.9, reasoning: "Verified", concerns: [], evidenceGaps: [] }, calls),
        reviewer("kimi-k2.5", new Error("rate limited"), calls),
        reviewer("glm-5", { recommendation: "approve", confidence: 0.8, reasoning: "Supported", concerns: [], evidenceGaps: [] }, calls)
      ]
    });

    expect(calls).toEqual([
      "topic.inbox.candidate.review.qwen3.7-plus",
      "topic.inbox.candidate.review.kimi-k2.5",
      "topic.inbox.candidate.review.glm-5"
    ]);
    expect(result.recommendation).toBe("approve");
    expect(result.reviews).toHaveLength(3);
    expect(result.reviews.find((item) => item.model === "kimi-k2.5")?.error).toBe("rate limited");
  });
});

describe("CandidateReviewService", () => {
  it("persists a cached recommendation without deciding the candidate", async () => {
    const { db } = fixture.createTestService();
    const repos = new Repositories(db.db);
    const namespace = { source: "codex", profileId: "p", userId: "u", projectId: "review-project" };
    const namespaceId = namespaceIdFromContext(namespace);
    const at = "2026-08-12T00:00:00.000Z";
    const calls: string[] = [];
    repos.topics.insertTopic({ id: "topic-1", namespaceId, projectId: "review-project", title: "Migrations", summary: "Migration checks", status: "active", version: 1, sourceMemoryIds: [], metadata: {}, createdAt: at, updatedAt: at });
    repos.topics.insertCandidate({ id: "candidate-1", topicId: "topic-1", namespaceId, title: "Verify migrations", conclusion: "Run the focused test.", proposedLayer: "L2", status: "pending", version: 1, sourceMemoryIds: [], metadata: {}, createdAt: at, updatedAt: at });
    let reviewers = [
      reviewer("qwen3.7-plus", { recommendation: "approve", confidence: 0.9, reasoning: "Supported", concerns: [], evidenceGaps: [] }, calls),
      reviewer("kimi-k2.5", { recommendation: "approve", confidence: 0.8, reasoning: "Reusable", concerns: [], evidenceGaps: [] }, calls)
    ];
    const reviews = new CandidateReviewService({ repos, reviewers: () => reviewers, now: () => at });

    const first = await reviews.review(namespace, "candidate-1");
    const second = await reviews.review(namespace, "candidate-1");

    expect(first.summary.recommendation).toBe("approve");
    expect(first.candidate.status).toBe("pending");
    expect(first.candidate.version).toBe(2);
    expect(second.cached).toBe(true);
    expect(calls).toHaveLength(2);
    expect(repos.topics.getCandidate("candidate-1", namespaceId)?.metadata.aiReview).toMatchObject({ recommendation: "approve" });
    reviewers = [...reviewers, reviewer("glm-5", { recommendation: "defer", confidence: 0.7, reasoning: "Needs detail", concerns: [], evidenceGaps: ["scope"] }, calls)];
    const afterModelChange = await reviews.review(namespace, "candidate-1");
    expect(afterModelChange.cached).toBe(false);
    expect(calls).toHaveLength(5);
  });

  it("fails closed for candidates outside the requested namespace", async () => {
    const { db } = fixture.createTestService();
    const reviews = new CandidateReviewService({ repos: new Repositories(db.db), reviewers: () => [] });
    await expect(reviews.review({ source: "codex", profileId: "p", projectId: "other" }, "missing")).rejects.toThrow("not found in namespace");
  });
});
