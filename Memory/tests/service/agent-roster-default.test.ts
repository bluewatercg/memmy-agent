import { describe, expect, it } from "vitest";
import { recommendAgents, DEFAULT_TOPIC_DECISION_MODELS } from "../../src/service/topic-decision/agent-roster.js";

describe("agent-roster default model fallback", () => {
  it("returns default four-model roster when models array is empty", () => {
    const agents = recommendAgents([]);
    expect(agents).toHaveLength(4);
    expect(agents.map((a) => a.model)).toEqual([...DEFAULT_TOPIC_DECISION_MODELS]);
    expect(agents[0]!.role).toBe("evidence_analyst");
    expect(agents[1]!.role).toBe("domain_analyst");
    expect(agents[2]!.role).toBe("risk_challenger");
    expect(agents[3]!.role).toBe("action_planner");
  });

  it("uses provided models when non-empty", () => {
    const agents = recommendAgents(["model-a", "model-b"]);
    expect(agents).toHaveLength(4);
    expect(agents[0]!.model).toBe("model-a");
    expect(agents[1]!.model).toBe("model-b");
    expect(agents[2]!.model).toBe("model-a"); // cycles
    expect(agents[3]!.model).toBe("model-b");
  });

  it("adds specialist agent when metadata requests it", () => {
    const agents = recommendAgents(["model-x"], { specialist: "rust-expert" });
    expect(agents.length).toBe(5); // 4 default + 1 specialist
    const specialist = agents.find((a) => a.role === "specialist");
    expect(specialist).toBeDefined();
    expect(specialist?.reason).toContain("rust-expert");
  });

  it("default models match environment contract default", () => {
    expect(DEFAULT_TOPIC_DECISION_MODELS).toEqual([
      "MiniMax-M2.5",
      "qwen3.7-plus",
      "kimi-k2.5",
      "glm-5"
    ]);
  });
});