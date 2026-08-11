import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { removeMemmySkillDirectory, replaceMemmySkillDirectory } from "../skill-directory.js";
import type { SkillTarget } from "../types.js";

const FREEBUFF_TARGET_ID = "freebuff";
export interface CreateFreebuffSkillTargetDeps { rootDirectory?: string; }

export function createFreebuffSkillTarget(deps: CreateFreebuffSkillTargetDeps = {}): SkillTarget {
  const agentsRoot = deps.rootDirectory ?? join(homedir(), ".agents");
  return {
    targetId: FREEBUFF_TARGET_ID,
    displayName: "FreeBuff",
    async resolveRootDirectory() { return resolveExistingDirectory(agentsRoot); },
    async install(manifest) {
      const root = await requireRoot(agentsRoot);
      await replaceMemmySkillDirectory(root, manifest);
    },
    async uninstall() {
      const root = await resolveExistingDirectory(agentsRoot);
      if (root) await removeMemmySkillDirectory(root);
    },
    async isInstalled() {
      const content = await readTextFile(join(agentsRoot, "skills", "memmy-memory", "SKILL.md"));
      return content.includes("name: memmy-memory") && content.includes("## Agent Loop");
    }
  };
}
async function requireRoot(directory: string): Promise<string> {
  const root = await resolveExistingDirectory(directory);
  if (!root) throw new Error("FreeBuff is not installed or its directory is unavailable");
  return root;
}
async function resolveExistingDirectory(directory: string): Promise<string | null> {
  try {
    return (await stat(directory)).isDirectory() ? directory : null;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }
}



async function readTextFile(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return "";
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}