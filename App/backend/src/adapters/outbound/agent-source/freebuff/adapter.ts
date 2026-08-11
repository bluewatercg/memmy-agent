/** FreeBuff source adapter. */
import { access } from "node:fs/promises";
import { join } from "node:path";
import { resolveFreebuffHomeDirectory } from "../../agent-paths.js";
import { collectConversationWindow, remainingMessageCapacity } from "../conversation-window.js";
import { redactSecrets } from "../secret-redactor.js";
import type { ConversationMessage, ScanOptions, SourceAdapter, SourceDescriptor } from "../types.js";
import { FreebuffChatFormatError, readFreebuffChat, type RawFreebuffMessage } from "./history-reader.js";
import { discoverFreebuffChats, findFreebuffGitRoot } from "./session-discovery.js";

const FREEBUFF_SOURCE_ID = "freebuff";
export interface CreateFreebuffSourceAdapterDeps { rootDirectory?: string; descriptor?: SourceDescriptor; }

export function createFreebuffSourceAdapter(deps: CreateFreebuffSourceAdapterDeps = {}): SourceAdapter {
  const rootDirectory = deps.rootDirectory ?? resolveFreebuffHomeDirectory();
  const projectsRoot = join(rootDirectory, "projects");
  const descriptor = deps.descriptor ?? Object.freeze({ sourceId: FREEBUFF_SOURCE_ID, displayName: "FreeBuff", builtin: true, dataPath: projectsRoot });
  return {
    descriptor,
    async detect() { try { await access(rootDirectory); return true; } catch (error) { if (isNodeError(error) && error.code === "ENOENT") return false; throw error; } },
    async *scan(options: ScanOptions) {
      throwIfAborted(options.signal);
      const chats = await discoverFreebuffChats(projectsRoot, options.order === "recent_first" ? "recent_first" : "path_asc", options.maxScanTargets);
      let emitted = 0;
      for (const chat of chats) {
        throwIfAborted(options.signal);
        if (options.maxMessages !== undefined && emitted >= options.maxMessages) break;
        let messages: RawFreebuffMessage[];
        try { messages = await collectConversationWindow(readFreebuffChat(chat.chatFilePath, chat.projectId, chat.chatId, options.signal), options.since, options.signal, remainingMessageCapacity(options.maxMessages, emitted)); } catch (error) {
          if (error instanceof SyntaxError || error instanceof FreebuffChatFormatError) {
            options.onError?.({ conversationId: `${chat.projectId}/${chat.chatId}`, reason: error.message });
            continue;
          }
          throw error;
        }
        for (const raw of messages) {
          throwIfAborted(options.signal);
          if (options.maxMessages !== undefined && emitted >= options.maxMessages) break;
          emitted += 1;
          const workspacePath = raw.workspacePath ?? chat.projectPath;
          yield { ...raw, sourceId: descriptor.sourceId, content: redactSecrets(raw.content), workspacePath, gitRoot: findFreebuffGitRoot(workspacePath), rawMeta: Object.freeze({ projectId: chat.projectId, chatId: chat.chatId }) } satisfies ConversationMessage;
        }
      }
    }
  };
}
function throwIfAborted(signal: AbortSignal | undefined): void { if (signal?.aborted) throw new DOMException("FreeBuff source scan aborted", "AbortError"); }
function isNodeError(error: unknown): error is NodeJS.ErrnoException { return error instanceof Error && "code" in error; }
