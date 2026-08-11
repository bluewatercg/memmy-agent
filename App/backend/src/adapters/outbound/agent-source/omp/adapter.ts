/** OMP source adapter for the Pi-compatible runtime format. */
import { access } from "node:fs/promises";
import { resolveOmpSessionsDirectory } from "../../agent-paths.js";
import { collectConversationWindow, remainingMessageCapacity } from "../conversation-window.js";
import { redactSecrets } from "../secret-redactor.js";
import type { ConversationMessage, ScanOptions, SourceAdapter, SourceDescriptor } from "../types.js";
import { discoverOmpSessions } from "./session-discovery.js";
import { readOmpSession, type RawOmpMessage } from "./session-reader.js";

const OMP_SOURCE_ID = "omp";

export interface CreateOmpSourceAdapterDeps {
  sessionsRoot?: string;
  descriptor?: SourceDescriptor;
}

export function createOmpSourceAdapter(deps: CreateOmpSourceAdapterDeps = {}): SourceAdapter {
  const sessionsRoot = deps.sessionsRoot ?? resolveOmpSessionsDirectory();
  const descriptor = deps.descriptor ?? Object.freeze({
    sourceId: OMP_SOURCE_ID,
    displayName: "OMP",
    builtin: true,
    dataPath: sessionsRoot
  });

  return {
    descriptor,
    async detect() {
      try {
        await access(sessionsRoot);
        return true;
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") {
          return false;
        }
        throw error;
      }
    },
    async *scan(options: ScanOptions) {
      throwIfAborted(options.signal);
      options.onProgress?.({ sourceId: descriptor.sourceId, phase: "discover", current: 0, total: 1 });
      const sessions = await discoverOmpSessions({
        root: sessionsRoot,
        order: options.order === "recent_first" ? "recent_first" : "path_asc",
        maxSessions: options.maxScanTargets
      });
      options.onProgress?.({ sourceId: descriptor.sourceId, phase: "discover", current: sessions.length, total: sessions.length });

      let emittedMessages = 0;
      for (const [sessionIndex, session] of sessions.entries()) {
        throwIfAborted(options.signal);
        if (options.maxMessages !== undefined && emittedMessages >= options.maxMessages) {
          break;
        }
        options.onProgress?.({
          sourceId: descriptor.sourceId,
          phase: "read",
          current: sessionIndex,
          total: sessions.length,
          message: session.sessionFilePath
        });
        const messages = await collectConversationWindow(
          readOmpSession(session.sessionFilePath, options.signal),
          options.since,
          options.signal,
          remainingMessageCapacity(options.maxMessages, emittedMessages)
        );
        for (const rawMessage of messages) {
          throwIfAborted(options.signal);
          if (options.maxMessages !== undefined && emittedMessages >= options.maxMessages) {
            break;
          }
          emittedMessages += 1;
          yield toConversationMessage(descriptor.sourceId, rawMessage, session.workspacePath, session.gitRoot);
        }
      }
      options.onProgress?.({ sourceId: descriptor.sourceId, phase: "done", current: emittedMessages, total: emittedMessages });
    }
  };
}

function toConversationMessage(
  sourceId: string,
  rawMessage: RawOmpMessage,
  workspacePath: string | null,
  gitRoot: string | null
): ConversationMessage {
  return {
    ...rawMessage,
    sourceId,
    content: redactSecrets(rawMessage.content),
    workspacePath,
    gitRoot,
    rawMeta: Object.freeze({})
  };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException("OMP source scan aborted", "AbortError");
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
