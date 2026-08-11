/** OMP session discovery for the Pi-compatible JSONL format. */
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readJsonlObjects } from "../jsonl-lines.js";
import { readDirectoryIfExists } from "../read-directory.js";

export interface OmpSessionFile {
  sessionFilePath: string;
  workspacePath: string | null;
  gitRoot: string | null;
}

export interface DiscoverOmpSessionsOptions {
  root: string;
  order?: "path_asc" | "recent_first";
  maxSessions?: number;
}

export async function discoverOmpSessions(options: DiscoverOmpSessionsOptions): Promise<OmpSessionFile[]> {
  const files = await listSessionFiles(options.root, options.order ?? "path_asc", options.maxSessions);
  const sessions: OmpSessionFile[] = [];

  for (const sessionFilePath of files) {
    const workspacePath = await readSessionCwd(sessionFilePath);
    sessions.push({
      sessionFilePath,
      workspacePath,
      gitRoot: workspacePath ? findGitRoot(workspacePath) : null
    });
  }

  return sessions;
}

async function listSessionFiles(
  root: string,
  order: "path_asc" | "recent_first",
  maxSessions: number | undefined
): Promise<string[]> {
  const files: Array<{ path: string; mtimeMs: number }> = [];
  const directories = [root];

  for (let directoryIndex = 0; directoryIndex < directories.length; directoryIndex += 1) {
    const currentDirectory = directories[directoryIndex]!;
    for (const entry of await readDirectoryIfExists(currentDirectory)) {
      const path = join(currentDirectory, entry.name);
      if (entry.isDirectory()) {
        directories.push(path);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        const fileStat = await stat(path);
        files.push({ path, mtimeMs: fileStat.mtimeMs });
      }
    }
  }

  return files
    .sort((left, right) => order === "recent_first"
      ? right.mtimeMs - left.mtimeMs || right.path.localeCompare(left.path)
      : left.path.localeCompare(right.path))
    .slice(0, maxSessions ?? files.length)
    .map((file) => file.path);
}

async function readSessionCwd(filePath: string): Promise<string | null> {
  try {
    for await (const record of readJsonlObjects(filePath)) {
      if (record.type === "session") {
        return typeof record.cwd === "string" ? record.cwd : null;
      }
    }
  } catch {
    return null;
  }
  return null;
}

function findGitRoot(workspacePath: string): string | null {
  let current = workspacePath;
  while (current !== dirname(current)) {
    if (existsSync(join(current, ".git"))) {
      return current;
    }
    current = dirname(current);
  }
  return existsSync(join(current, ".git")) ? current : null;
}
