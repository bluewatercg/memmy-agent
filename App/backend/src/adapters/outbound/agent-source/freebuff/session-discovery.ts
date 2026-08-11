/** FreeBuff chat discovery. */
import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

export interface FreebuffChatFile {
  projectId: string;
  projectPath: string;
  chatId: string;
  chatFilePath: string;
  mtimeMs: number;
}

export async function discoverFreebuffChats(projectsRoot: string, order: "path_asc" | "recent_first", maxChats?: number): Promise<FreebuffChatFile[]> {
  const results: FreebuffChatFile[] = [];
  let projects: import("node:fs").Dirent[];
  try { projects = await readdir(projectsRoot, { withFileTypes: true }); } catch (error) { if (isNodeError(error) && error.code === "ENOENT") return []; throw error; }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const projectPath = join(projectsRoot, project.name);
    const chatsPath = join(projectPath, "chats");
    let chats: import("node:fs").Dirent[];
    try { chats = await readdir(chatsPath, { withFileTypes: true }); } catch (error) { if (isNodeError(error) && error.code === "ENOENT") continue; throw error; }
    for (const chat of chats) {
      if (!chat.isDirectory()) continue;
      const chatFilePath = join(chatsPath, chat.name, "chat-messages.json");
      try { const info = await stat(chatFilePath); if (info.isFile()) results.push({ projectId: project.name, projectPath, chatId: chat.name, chatFilePath, mtimeMs: info.mtimeMs }); } catch (error) { if (!(isNodeError(error) && error.code === "ENOENT")) throw error; }
    }
  }
  return results.sort((left, right) => order === "recent_first" ? right.mtimeMs - left.mtimeMs || right.chatFilePath.localeCompare(left.chatFilePath) : left.chatFilePath.localeCompare(right.chatFilePath)).slice(0, maxChats ?? results.length);
}

export function findFreebuffGitRoot(workspacePath: string): string | null { let current = workspacePath; while (current !== current.replace(/[\\/]$/u, "") && current !== "/") { if (existsSync(join(current, ".git"))) return current; const parent = join(current, ".."); if (parent === current) break; current = parent; } return existsSync(join(current, ".git")) ? current : null; }
function isNodeError(error: unknown): error is NodeJS.ErrnoException { return error instanceof Error && "code" in error; }
