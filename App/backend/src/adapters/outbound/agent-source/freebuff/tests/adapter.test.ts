/** FreeBuff source adapter tests. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFreebuffSourceAdapter } from "../index.js";
import { readFreebuffChat } from "../history-reader.js";

let tempDirectory: string | undefined;
afterEach(() => { if (tempDirectory) { rmSync(tempDirectory, { recursive: true, force: true }); tempDirectory = undefined; } });

describe("FreeBuff source adapter", () => {
  it("normalizes visible text and tool blocks while skipping UI-only content", async () => {
    const fixture = createFixture();
    const messages = await collect(readFreebuffChat(fixture.chatPath, fixture.projectId, fixture.chatId));
    expect(messages).toEqual([
      expect.objectContaining({ messageId: "project-a/chat-1/user-1", conversationId: "project-a/chat-1", role: "user", content: "Remember OPENAI_API_KEY=[REDACTED:openai_api_key]" }),
      expect.objectContaining({ messageId: "project-a/chat-1/ai-1:block-1", role: "assistant", content: "Before tool" }),
      expect.objectContaining({ messageId: "project-a/chat-1/ai-1:tool-call-1", role: "tool", content: expect.stringContaining("Tool: search") }),
      expect.objectContaining({ messageId: "project-a/chat-1/ai-1:block-4", role: "assistant", content: "Done" })
    ]);
    expect(messages.map((message) => message.content).join("\n")).not.toContain("private reasoning");
    expect(messages.map((message) => message.content).join("\n")).not.toContain("image payload");
  });

  it("discovers valid chats and ignores malformed files", async () => {
    const fixture = createFixture();
    mkdirSync(join(fixture.projectsRoot, "project-b", "chats", "broken"), { recursive: true });
    writeFileSync(join(fixture.projectsRoot, "project-b", "chats", "broken", "chat-messages.json"), "not-json", "utf8");
    mkdirSync(join(fixture.projectsRoot, "project-c", "chats", "wrong-shape"), { recursive: true });
    writeFileSync(join(fixture.projectsRoot, "project-c", "chats", "wrong-shape", "chat-messages.json"), "{}", "utf8");
    const errors: Array<{ conversationId: string; reason: string }> = [];
    const messages = await collect(createFreebuffSourceAdapter({ rootDirectory: fixture.rootDirectory }).scan({ onError: (error) => errors.push(error) }));
    expect(messages).toHaveLength(4);
    expect(messages[0]).toMatchObject({ sourceId: "freebuff", workspacePath: fixture.workspacePath, gitRoot: fixture.workspacePath, conversationId: "project-a/chat-1" });
    expect(errors).toEqual([
      expect.objectContaining({ conversationId: "project-b/broken" }),
      expect.objectContaining({ conversationId: "project-c/wrong-shape" })
    ]);
  });

  it("treats missing FreeBuff home and incomplete chats as empty", async () => {
    const rootDirectory = join(tmpdir(), `memmy-missing-freebuff-${crypto.randomUUID()}`);
    await expect(collect(createFreebuffSourceAdapter({ rootDirectory }).scan({}))).resolves.toEqual([]);
  });
});

function createFixture() {
  tempDirectory = mkdtempSync(join(tmpdir(), "memmy-freebuff-source-"));
  const rootDirectory = join(tempDirectory, ".config", "manicode");
  const projectsRoot = join(rootDirectory, "projects");
  const projectId = "project-a";
  const chatId = "chat-1";
  const projectPath = join(projectsRoot, projectId);
  const workspacePath = join(tempDirectory, "workspace");
  const chatPath = join(projectPath, "chats", chatId, "chat-messages.json");
  mkdirSync(join(projectPath, "chats", chatId), { recursive: true });
  mkdirSync(join(workspacePath, ".git"), { recursive: true });
  writeFileSync(chatPath, JSON.stringify([
    { id: "user-1", variant: "user", content: "Remember OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN", timestamp: "2026-08-10T00:00:00.000Z" },
    { id: "ui-1", variant: "start-task" },
    { id: "ai-1", variant: "ai", blocks: [
      { type: "text", textType: "reasoning", content: "private reasoning" },
      { type: "text", textType: "text", content: "Before tool" },
      { type: "tool", toolCallId: "tool-call-1", toolName: "search", input: { query: "laws" } },
      { type: "image", content: "image payload" },
      { type: "text", textType: "text", content: "Done" }
    ], timestamp: "2026-08-10T00:00:02.000Z", metadata: { runState: { sessionState: { fileContext: { projectRoot: workspacePath, cwd: workspacePath } } } } }
  ]), "utf8");
  return { rootDirectory, projectsRoot, projectId, chatId, chatPath, projectPath, workspacePath };
}

async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const value of values) result.push(value);
  return result;
}
