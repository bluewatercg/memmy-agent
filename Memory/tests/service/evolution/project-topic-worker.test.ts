import { describe, expect, it } from "vitest";
import { evaluateTopicAutoApproval } from "../../../src/service/topic-inbox/auto-approval-policy.js";
import { evolutionJobDedupeKey } from "../../../src/service/worker/job-handlers.js";
import type { MemoryRow } from "../../../src/index.js";
import type { TopicCandidateAnalysis } from "../../../src/service/topic-inbox/topic-inbox-types.js";

const eligible: TopicCandidateAnalysis = {
  title: "Verified formatting practice",
  conclusion: "Run the focused formatter check after changes.",
  proposedLayer: "L2", risk: "low", confidence: "high", verificationStatus: "verified",
  verificationEvidence: "model says passed", sourceEvidenceIds: ["trace_verified"], conflicts: [], sensitiveCategories: []
};

function evidence(value = "formatter check completed", overrides: Partial<MemoryRow> = {}): MemoryRow {
  return {
    id: "trace_verified", timeline: "2026-08-11T00:00:00.000Z", userId: "u", memoryType: "LongTermMemory",
    status: "activated", visibility: "private", memoryValue: value, tags: ["formatter"], info: { verification_status: "verified", verification_passed: true },
    properties: { internal_info: { memory_layer: "L1", memory_kind: "trace", trace: { summary: value, tool_calls: [{ name: "npm-test", success: true, output: "1 passed" }] } } },
    memoryLayer: "L1", version: 1, createdAt: "2026-08-11T00:00:00.000Z", updatedAt: "2026-08-11T00:00:00.000Z", ...overrides
  };
}

describe("project topic worker policy", () => {
  it.each([
    ["eligible", eligible, [evidence()], true],
    ["L3", { ...eligible, proposedLayer: "L3" as const }, [evidence()], false],
    ["risk", { ...eligible, risk: "medium" as const }, [evidence()], false],
    ["confidence", { ...eligible, confidence: "medium" as const }, [evidence()], false],
    ["uncited", { ...eligible, sourceEvidenceIds: [] }, [evidence()], false],
    ["unverified", { ...eligible, verificationStatus: "unverified" as const }, [evidence()], false],
    ["verification failed", { ...eligible, verificationStatus: "failed" as const }, [evidence()], false],
    ["failed", eligible, [evidence("formatter check did not pass")], false],
    ["migration", eligible, [evidence("migration check passed")], false],
    ["conflict", { ...eligible, conflicts: ["contradiction"] }, [evidence()], false],
    ["sensitive", { ...eligible, sensitiveCategories: ["credential"] }, [evidence()], false]
  ])("enforces %s boundary", (_name, candidate, source, approved) => {
    expect(evaluateTopicAutoApproval(candidate, source).approved).toBe(approved);
  });

  it("builds stable content and namespace cursor dedupe keys", () => {
    expect(evolutionJobDedupeKey({ jobType: "topic_ingest", targetMemoryId: "trace_1", payload: { contentHash: "abc" } })).toBe("topic_ingest:trace_1:abc");
    expect(evolutionJobDedupeKey({ jobType: "topic_refresh", payload: { namespaceId: "local:project", evidenceCursor: "cursor" } })).toBe("topic_refresh:local:project:cursor");
  });
});
