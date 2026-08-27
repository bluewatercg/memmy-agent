import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFreebuffSourceAdapter } from "../../App/backend/src/adapters/outbound/agent-source/freebuff/index.js";

async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const value of values) result.push(value);
  return result;
}

describe("convergence: agent sources", () => {
  it("discovers a complete FreeBuff conversation and preserves source identity", async () => {
    const root = mkdtempSync(join(tmpdir(), "memmy-convergence-freebuff-"));
    try {
      const workspace = join(root, "workspace");
      const chatDir = join(root, "projects", "project-a", "chats", "chat-1");
      mkdirSync(join(workspace, ".git"), { recursive: true });
      mkdirSync(chatDir, { recursive: true });
      writeFileSync(join(chatDir, "chat-messages.json"), JSON.stringify([
        { id: "u1", variant: "user", content: "Remember this source", timestamp: "2026-08-10T00:00:00.000Z" },
        { id: "a1", variant: "ai", blocks: [{ type: "text", textType: "text", content: "Recorded" }], timestamp: "2026-08-10T00:00:01.000Z", metadata: { runState: { sessionState: { fileContext: { projectRoot: workspace, cwd: workspace } } } } }
      ]));
      const messages = await collect(createFreebuffSourceAdapter({ rootDirectory: root }).scan({}));
      expect(messages).toHaveLength(2);
      expect(messages[0]).toMatchObject({ sourceId: "freebuff", conversationId: "project-a/chat-1", workspacePath: workspace, gitRoot: workspace });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
