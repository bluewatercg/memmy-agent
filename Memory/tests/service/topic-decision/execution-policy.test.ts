import { describe, expect, it } from "vitest";
import { evaluateExecutionPolicy } from "../../../src/service/topic-decision/execution-policy.js";
import type { TopicActionEffect } from "../../../src/types.js";

describe("execution policy matrix", () => {
  const automaticEffects: TopicActionEffect[] = ["read", "analyze", "draft", "create_candidate_task"];
  const confirmationEffects: TopicActionEffect[] = [
    "authoritative_write", "external_write", "delete", "topic_mutation", "memory_promotion"
  ];

  for (const effect of automaticEffects) {
    it(`${effect} is automatic when recovery point and acceptance condition present`, () => {
      const decision = evaluateExecutionPolicy(effect, {
        recoveryPoint: "pre-execution snapshot",
        acceptanceCondition: "artifact produced"
      });
      expect(decision.mode).toBe("automatic");
    });
  }

  for (const effect of confirmationEffects) {
    it(`${effect} requires confirmation`, () => {
      const decision = evaluateExecutionPolicy(effect, {
        recoveryPoint: "pre-execution snapshot",
        acceptanceCondition: "write verified"
      });
      expect(decision.mode).toBe("confirmation_required");
      if (decision.mode === "confirmation_required") {
        expect(decision.reason).toMatch(/irreversible|confirmation/i);
      }
    });
  }

  it("unknown effect is forbidden", () => {
    const decision = evaluateExecutionPolicy("unknown_effect" as TopicActionEffect, {
      recoveryPoint: "x",
      acceptanceCondition: "y"
    });
    expect(decision.mode).toBe("forbidden");
    if (decision.mode === "forbidden") {
      expect(decision.reason).toMatch(/unknown/i);
    }
  });

  it("automatic effect without recovery point is forbidden", () => {
    const decision = evaluateExecutionPolicy("draft", {
      recoveryPoint: "",
      acceptanceCondition: "artifact produced"
    });
    expect(decision.mode).toBe("forbidden");
    if (decision.mode === "forbidden") {
      expect(decision.reason).toMatch(/recovery/i);
    }
  });

  it("automatic effect without acceptance condition is forbidden", () => {
    const decision = evaluateExecutionPolicy("read", {
      recoveryPoint: "snapshot",
      acceptanceCondition: ""
    });
    expect(decision.mode).toBe("forbidden");
    if (decision.mode === "forbidden") {
      expect(decision.reason).toMatch(/acceptance/i);
    }
  });

  it("draft is automatic (proposed patch = draft)", () => {
    const decision = evaluateExecutionPolicy("draft", {
      recoveryPoint: "pre-draft",
      acceptanceCondition: "artifact stored"
    });
    expect(decision.mode).toBe("automatic");
  });

  it("applying a draft is authoritative_write (confirmation required)", () => {
    const decision = evaluateExecutionPolicy("authoritative_write", {
      recoveryPoint: "pre-apply",
      acceptanceCondition: "applied"
    });
    expect(decision.mode).toBe("confirmation_required");
  });
});
