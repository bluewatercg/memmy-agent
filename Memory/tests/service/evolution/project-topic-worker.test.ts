import { describe, expect, it } from "vitest";
import { evaluateTopicAutoApproval } from "../../../src/service/topic-inbox/auto-approval-policy.js";
import { evolutionJobDedupeKey } from "../../../src/service/worker/job-handlers.js";
import type { TopicCandidateAnalysis } from "../../../src/service/topic-inbox/topic-inbox-types.js";

const eligible: TopicCandidateAnalysis = {
  title: "Verified migration practice",
  conclusion: "Run the focused migration test after schema changes.",
  proposedLayer: "L2",
  risk: "low",
  confidence: "high",
  verificationStatus: "verified",
  verificationEvidence: "focused migration test passed",
  conflicts: [],
  sensitiveCategories: []
};

describe("project topic worker policy", () => {
  it.each([
    ["eligible", eligible, true],
    ["L3", { ...eligible, proposedLayer: "L3" as const }, false],
    ["risk", { ...eligible, risk: "medium" as const }, false],
    ["confidence", { ...eligible, confidence: "medium" as const }, false],
    ["unverified", { ...eligible, verificationStatus: "unverified" as const }, false],
    ["no success marker", { ...eligible, verificationEvidence: "ran a command" }, false],
    ["conflict", { ...eligible, conflicts: ["contradiction"] }, false],
    ["sensitive", { ...eligible, sensitiveCategories: ["credential"] }, false]
  ])("enforces %s boundary", (_name, candidate, approved) => {
    expect(evaluateTopicAutoApproval(candidate).approved).toBe(approved);
  });

  it("builds stable content and namespace cursor dedupe keys", () => {
    expect(evolutionJobDedupeKey({ jobType: "topic_ingest", targetMemoryId: "trace_1", payload: { contentHash: "abc" } })).toBe("topic_ingest:trace_1:abc");
    expect(evolutionJobDedupeKey({ jobType: "topic_refresh", payload: { namespaceId: "local:project", evidenceCursor: "cursor" } })).toBe("topic_refresh:local:project:cursor");
  });
});
