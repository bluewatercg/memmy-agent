import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryDb } from "../../src/index.js";
import { Repositories } from "../../src/storage/repositories.js";
import { DshImportService } from "../../src/service/import/dsh/dsh-import-service.js";
import { discoverDshSessions, dshSessionsRoot } from "../../src/service/import/dsh/session-discovery.js";

const REAL_ROOT = "/root/.dsh/sessions";

describe("dsh import service (integration)", () => {
  it("discovers real DSH sessions", async () => {
    const files = await discoverDshSessions(REAL_ROOT);
    expect(files.length).toBeGreaterThan(0);
    const anyZstd = files.some((f) => f.compression === "zstd");
    expect(anyZstd).toBe(true);
  });

  it("imports a real session through MemoryService write path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-import-e2e-"));
    const db = new MemoryDb({ path: join(dir, "mem.sqlite") });
    try {
      const repos = new Repositories(db.db);
      // Minimal writeMemory adapter: call the repository directly with an id.
      let written = 0;
      const service = new DshImportService({
        repos,
        root: REAL_ROOT,
        writeMemory: (request) => {
          const { newId } = requireNewId();
          const row = repos.memories.insert({
            id: newId("memory"),
            userId: "dsh-e2e",
            agentId: request.source ?? "deepseek_harness",
            sessionId: request.sessionId,
            memoryType: "LongTermMemory",
            memoryLayer: request.layer ?? "L1",
            status: "activated",
            memoryValue: request.content ?? "",
            memoryKey: request.title,
            tags: request.tags ?? [],
            version: 1,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            timeline: new Date().toISOString(),
            appId: undefined,
            conversationId: undefined,
            visibility: "private",
            contentHash: "",
            info: {},
            properties: {},
          } as never);
          written += 1;
          void row;
          return row.id;
        },
      });
      const result = await service.importAll({ maxSessionsPerRun: 2, maxTurnsPerSession: 5 });
      expect(result.sessionsSeen).toBeGreaterThan(0);
      expect(result.sessionsImported + result.sessionsSkipped).toBe(2); // capped by maxSessionsPerRun
      expect(result.errors).toEqual([]);
      void written;
    } finally {
      db.close();
    }
  });
});

function requireNewId(): { newId: (prefix: string) => string } {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return { newId: (prefix: string) => prefix + "-" + Math.random().toString(36).slice(2) };
}
