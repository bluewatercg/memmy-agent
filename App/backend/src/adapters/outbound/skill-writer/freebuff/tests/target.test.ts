import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renderMemmyDefaultSkillManifest } from "../../templates/memmy-default.js";
import { createFreebuffSkillTarget } from "../index.js";

let tempDirectory: string | undefined;
afterEach(() => { if (tempDirectory) rmSync(tempDirectory, { recursive: true, force: true }); });

describe("FreeBuff skill target", () => {
  it("installs the complete Memmy skill under .agents/skills", async () => {
    const rootDirectory = createRoot();
    const target = createFreebuffSkillTarget({ rootDirectory });
    await target.install(renderMemmyDefaultSkillManifest("freebuff"));
    const skillPath = join(rootDirectory, "skills", "memmy-memory", "SKILL.md");
    const content = readFileSync(skillPath, "utf8");
    expect(content).toContain("## Agent Loop");
    expect(content).toContain("--source freebuff");
    await expect(target.isInstalled("freebuff")).resolves.toBe(true);
  });

  it("removes only the Memmy skill and does not create a missing FreeBuff root", async () => {
    const rootDirectory = createRoot();
    const target = createFreebuffSkillTarget({ rootDirectory });
    writeFileSync(join(rootDirectory, "keep.txt"), "keep", "utf8");
    await target.install(renderMemmyDefaultSkillManifest("freebuff"));
    await target.uninstall("freebuff");
    expect(existsSync(join(rootDirectory, "skills", "memmy-memory"))).toBe(false);
    expect(readFileSync(join(rootDirectory, "keep.txt"), "utf8")).toBe("keep");

    const missingRoot = join(tempDirectory!, "missing");
    await expect(createFreebuffSkillTarget({ rootDirectory: missingRoot }).install(renderMemmyDefaultSkillManifest("freebuff"))).rejects.toThrow("FreeBuff is not installed");
    expect(existsSync(missingRoot)).toBe(false);
  });
});

function createRoot(): string { tempDirectory = mkdtempSync(join(tmpdir(), "memmy-freebuff-skill-")); const root = join(tempDirectory, ".agents"); mkdirSync(root, { recursive: true }); return root; }
