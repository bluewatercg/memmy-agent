import { describe, expect, it } from "vitest";
import { extractProjectEvidence } from "../../../src/service/evolution/project-evidence.js";

describe("project evidence extraction", () => {
  it.each([
    "<codex_internal_context source=\"goal\">continue working</codex_internal_context>",
    "You are a focused child agent spawned by a parent agent.",
    "What is the architecture?",
    "继续"
  ])("rejects %s as non-evidence", (userText) => {
    expect(extractProjectEvidence({ id: "noise", userText }).eligible).toBe(false);
  });

  it("classifies child-agent instructions as rejected noise", () => {
    expect(extractProjectEvidence({
      id: "child-agent-instruction",
      userText: "You are a focused child agent spawned by a parent agent."
    })).toMatchObject({
      candidateType: "noise",
      activation: "rejected",
      eligible: false,
      reasons: ["agent_instruction_noise"]
    });
  });

  it("classifies a tool-backed successful procedure as eligible outcome evidence", () => {
    const evidence = extractProjectEvidence({
      id: "trace-1",
      userText: "Run the migration and verify the schema.",
      agentText: "Migration completed successfully; the schema check passed.",
      toolCalls: [{ name: "shell", output: "exit code 0" }]
    });
    expect(evidence).toMatchObject({ kind: "outcome", eligible: true });
    expect(evidence.stableKey).toMatch(/^evidence:/);
  });

  it("uses the same stable key for equivalent evidence", () => {
    const a = extractProjectEvidence({ id: "a", userText: "Run tests", agentText: "Tests passed" });
    const b = extractProjectEvidence({ id: "b", userText: " Run   tests ", agentText: "Tests passed" });
    expect(a.stableKey).toBe(b.stableKey);
  });

  it("keeps pure process traces out of active memory", () => {
    expect(extractProjectEvidence({
      id: "process-only",
      userText: "Inspect the repository and consider the migration design.",
      agentText: "I read the files and compared the options."
    })).toMatchObject({
      candidateType: "pure_process",
      activation: "rejected",
      eligible: false
    });
  });

  it("activates a low-risk verified policy and preserves its evidence basis", () => {
    expect(extractProjectEvidence({
      id: "verified-policy",
      userText: "When the SQLite schema changes, run the focused migration test.",
      agentText: "Run the migration test after the schema change; the focused test passed.",
      toolCalls: [{ name: "shell", input: "npm test -- migration", output: "1 passed", success: true }]
    })).toMatchObject({
      candidateType: "policy",
      verification: "tool_verified",
      risk: "low",
      activation: "active_memory",
      eligible: true,
      evidenceIds: ["verified-policy"]
    });
  });

  it("routes decisions to review instead of activating them", () => {
    expect(extractProjectEvidence({
      id: "decision",
      userText: "We decided to use SQLite as the canonical store.",
      agentText: "Adopt SQLite for canonical persistence."
    })).toMatchObject({
      candidateType: "decision",
      activation: "review_candidate",
      eligible: false
    });
  });

  it("blocks destructive policy automation even when a tool succeeded", () => {
    expect(extractProjectEvidence({
      id: "destructive",
      userText: "Always delete the database before retrying migrations.",
      agentText: "Run rm -rf data and recreate the database; command completed successfully.",
      toolCalls: [{ name: "shell", input: "rm -rf data", output: "exit code 0", success: true }]
    })).toMatchObject({
      candidateType: "policy",
      risk: "high",
      activation: "rejected",
      eligible: false
    });
  });

  it("activates a verified low-risk avoidance rule", () => {
    expect(extractProjectEvidence({
      id: "avoidance",
      userText: "Do not retry a migration before checking its schema version.",
      agentText: "The retry failed because the schema version was stale; checking it first fixed the failure.",
      toolCalls: [{ name: "shell", input: "npm test -- migration", output: "passed", success: true }]
    })).toMatchObject({
      candidateType: "avoidance",
      verification: "tool_verified",
      risk: "low",
      activation: "active_memory",
      eligible: true
    });
  });
});
