/** FreeBuff serialized chat reader. */
import { readFile } from "node:fs/promises";
import { redactSecrets } from "../secret-redactor.js";

export interface RawFreebuffMessage {
  messageId: string;
  conversationId: string;
  role: "user" | "assistant" | "tool";
  content: string;
  createdAt: string;
  workspacePath?: string;
}

export class FreebuffChatFormatError extends Error {}

export async function* readFreebuffChat(filePath: string, projectId: string, chatId: string, signal?: AbortSignal): AsyncIterable<RawFreebuffMessage> {
  throwIfAborted(signal);
  const parsed: unknown = JSON.parse(await readFile(filePath, "utf8"));
  if (!Array.isArray(parsed)) throw new FreebuffChatFormatError(`FreeBuff chat must be an array: ${filePath}`);
  const workspacePath = findWorkspacePath(parsed);
  for (const value of parsed) {
    throwIfAborted(signal);
    if (!isRecord(value)) continue;
    const id = stringValue(value.id);
    const variant = stringValue(value.variant);
    if (!id || (variant !== "user" && variant !== "ai")) continue;
    const createdAt = normalizeTimestamp(value.timestamp, chatId);
    if (variant === "user") {
      const content = stringValue(value.content);
      if (content) yield message(projectId, chatId, id, "user", redactSecrets(content), createdAt, workspacePath);
      continue;
    }
    const blocks = Array.isArray(value.blocks) ? value.blocks.filter(isRecord) : [];
    for (const [index, block] of blocks.entries()) {
      if (block.type === "text" && block.textType !== "reasoning") {
        const content = stringValue(block.content);
        if (content) yield message(projectId, chatId, `${id}:block-${index}`, "assistant", redactSecrets(content), createdAt, workspacePath);
        continue;
      }
      if (block.type !== "tool") continue;
      const toolName = stringValue(block.toolName) ?? "tool";
      const callId = stringValue(block.toolCallId) ?? `block-${index}`;
      const details = [formatValue(block.input), formatValue(block.output)].filter(Boolean).join("\n");
      yield message(projectId, chatId, `${id}:${callId}`, "tool", redactSecrets(`Tool: ${toolName}${details ? `\n${details}` : ""}`), createdAt, workspacePath);
    }
  }
}

function message(projectId: string, chatId: string, id: string, role: RawFreebuffMessage["role"], content: string, createdAt: string, workspacePath?: string): RawFreebuffMessage {
  return { messageId: `${projectId}/${chatId}/${id}`, conversationId: `${projectId}/${chatId}`, role, content, createdAt, workspacePath };
}
function findWorkspacePath(values: unknown[]): string | undefined {
  for (const value of values) {
    if (!isRecord(value)) continue;
    const metadata = recordValue(value.metadata);
    const runState = recordValue(metadata?.runState);
    const sessionState = recordValue(runState?.sessionState);
    const fileContext = recordValue(sessionState?.fileContext);
    const workspacePath = stringValue(fileContext?.projectRoot) ?? stringValue(fileContext?.cwd);
    if (workspacePath) return workspacePath;
  }
  return undefined;
}

function normalizeTimestamp(value: unknown, chatId: string): string {
  const direct = stringValue(value);
  if (direct) {
    const parsed = new Date(direct);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  const fromChatId = new Date(chatId.replace(/T(\d{2})-(\d{2})-(\d{2})\./u, "T$1:$2:$3."));
  return Number.isNaN(fromChatId.getTime()) ? new Date(0).toISOString() : fromChatId.toISOString();
}

function formatValue(value: unknown): string { if (value === undefined || value === null || value === "") return ""; return typeof value === "string" ? value : JSON.stringify(value); }
function stringValue(value: unknown): string | null { return typeof value === "string" && value.trim() ? value.trim() : null; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function recordValue(value: unknown): Record<string, unknown> | undefined { return isRecord(value) ? value : undefined; }
function throwIfAborted(signal: AbortSignal | undefined): void { if (signal?.aborted) throw new DOMException("FreeBuff source scan aborted", "AbortError"); }
