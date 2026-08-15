// DSH session discovery: scan $DSH_HOME/sessions/** (or ~/.dsh/sessions/**)
// for session.jsonl(.zstd) artifacts. Layout (verified against DSH):
//   <root>/--<normalized-cwd>--/<encoded-session-id>/session.jsonl[.zstd]
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve, basename } from "node:path";
import { homedir } from "node:os";
import { parseDshSessionLines } from "./session-parser.js";

export const DSH_SESSION_FILE = "session.jsonl.zstd";
export const DSH_SESSION_FILE_PLAIN = "session.jsonl";

export interface DshSessionFile {
  sessionId: string; // directory name (encoded session id)
  cwdDir: string; // project directory name (--<normalized-cwd>--)
  path: string; // absolute artifact path
  compression: "zstd" | "none";
  size: number;
  mtimeMs: number;
}

export function dshSessionsRoot(override?: string): string {
  if (override) return resolve(override);
  return process.env.DSH_HOME
    ? resolve(process.env.DSH_HOME, "sessions")
    : join(homedir(), ".dsh", "sessions");
}

export async function discoverDshSessions(root: string): Promise<DshSessionFile[]> {
  const out: DshSessionFile[] = [];
  let cwdDirs: string[];
  try {
    cwdDirs = await readdir(root);
  } catch {
    return []; // root missing/unreadable -> no sessions
  }
  for (const cwdDir of cwdDirs) {
    if (!cwdDir.startsWith("--")) continue; // only project dirs
    const cwdPath = join(root, cwdDir);
    let sessionDirs: string[];
    try {
      sessionDirs = await readdir(cwdPath);
    } catch {
      continue;
    }
    for (const sessionDir of sessionDirs) {
      const sessionPath = join(cwdPath, sessionDir);
      // try zstd first, then plain
      for (const [name, compression] of [
        [DSH_SESSION_FILE, "zstd"],
        [DSH_SESSION_FILE_PLAIN, "none"],
      ] as const) {
        const artifactPath = join(sessionPath, name);
        try {
          const info = await stat(artifactPath);
          if (info.isFile()) {
            out.push({
              sessionId: sessionDir,
              cwdDir,
              path: artifactPath,
              compression,
              size: info.size,
              mtimeMs: info.mtimeMs,
            });
            break; // one artifact per session
          }
        } catch {
          // artifact missing -> try next name
        }
      }
    }
  }
  return out;
}

export async function readDshSessionFile(file: DshSessionFile): Promise<ParsedDshSessionResult> {
  const buffer = await readFile(file.path);
  const { parseDshSessionBuffer } = await import("./session-parser.js");
  const parsed = parseDshSessionBuffer(buffer);
  return { file, parsed };
}

export interface ParsedDshSessionResult {
  file: DshSessionFile;
  parsed: ReturnType<typeof parseDshSessionLines>;
}
