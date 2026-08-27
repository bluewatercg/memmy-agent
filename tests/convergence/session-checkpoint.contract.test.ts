import { describe, expect, it } from "vitest";
import { AgentLoop } from "../../App/memmy-agent/src/core/agent-runtime/loop.js";
import { Session } from "../../App/memmy-agent/src/core/session/manager.js";

describe("convergence: session checkpoint", () => {
  it("restores pending tool state once and clears the checkpoint", () => {
    const loop = new AgentLoop({ provider: { generation: {}, getDefaultModel: () => "model" }, workspace: "/tmp/convergence-checkpoint" });
    const session = new Session({ key: "codex:/work/checkpoint" });
    loop.setRuntimeCheckpoint(session, {
      assistantMessage: { role: "assistant", content: "calling tool" },
      pendingToolCalls: [{ id: "call-1", function: { name: "read_file", arguments: "{}" } }],
      completedToolResults: []
    });
    expect(loop.restoreRuntimeCheckpoint(session)).toBe(true);
    expect(session.messages).toEqual([
      expect.objectContaining({ role: "assistant", content: "calling tool" }),
      expect.objectContaining({ role: "tool", tool_call_id: "call-1", name: "read_file" })
    ]);
    expect(loop.restoreRuntimeCheckpoint(session)).toBe(false);
  });
});
