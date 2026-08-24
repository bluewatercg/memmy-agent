import { describe, it, expect } from "vitest";
import { zstdCompressSync } from "node:zlib";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryDb, MemoryService } from "../../src/index.js";
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

describe("MemoryService DSH import composition", () => {
  it("imports DSH history through the production service write path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-service-import-"));
    const db = new MemoryDb({ path: join(dir, "mem.sqlite") });
    try {
      const service = new MemoryService({ db, mode: "dev" });
      const result = await service.importDshHistory({
        root: REAL_ROOT,
        maxSessionsPerRun: 1,
        maxTurnsPerSession: 1,
      });

      expect(result.sessionsSeen).toBeGreaterThan(0);
      expect(result.sessionsImported + result.sessionsSkipped).toBe(1);
      expect(result.errors).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("writes a complete historical turn through MemoryService", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-service-import-fixture-"));
    const sessionDir = join(dir, "--workspace--", "session-production");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "session.jsonl"), [
      JSON.stringify({ type: "session", version: 1, id: "session-production", createdAt: 1, cwd: "/workspace" }),
      JSON.stringify({ type: "turn/start", seq: 1, time: 1, data: { turn: 1 } }),
      JSON.stringify({ type: "user/message", seq: 2, time: 2, data: { id: "message-1", content: "remember production import" } }),
      JSON.stringify({ type: "turn/end", seq: 3, time: 3, data: { turn: 1 } }),
      "",
    ].join("\n"));
    const db = new MemoryDb({ path: join(dir, "mem.sqlite") });
    try {
      const service = new MemoryService({ db, mode: "dev" });
      const result = await service.importDshHistory({ root: dir });

      expect(result.errors).toEqual([]);
      expect(result.memoriesWritten).toBe(1);
      expect(result.turnsImported).toBe(1);
      expect(db.db.prepare("SELECT memory_value FROM memories").all()).toEqual([
        expect.objectContaining({ memory_value: expect.stringContaining("remember production import") }),
      ]);
    } finally {
      db.close();
    }
  });

  it("reconstructs a turn whose start and end arrive in separate frames", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-incremental-frame-"));
    const sessionDir = join(dir, "--workspace--", "session-frame");
    mkdirSync(sessionDir, { recursive: true });
    const sessionPath = join(sessionDir, "session.jsonl");
    writeFileSync(sessionPath, [
      JSON.stringify({ type: "session", version: 1, id: "session-frame", createdAt: 1 }),
      JSON.stringify({ type: "turn/start", seq: 1, time: 1, data: { turn: 1 } }),
      JSON.stringify({ type: "user/message", seq: 2, time: 2, data: { id: "frame-message", content: "cross frame prompt" } }),
      "",
    ].join("\n"));
    const db = new MemoryDb({ path: join(dir, "mem.sqlite") });
    try {
      const repos = new Repositories(db.db);
      const written: string[] = [];
      const service = new DshImportService({ repos, root: dir, writeMemory: (request) => {
        written.push(request.content);
        return "memory-frame";
      } });
      const first = await service.importAll();
      expect(first.turnsImported).toBe(0);
      writeFileSync(sessionPath, [
        JSON.stringify({ type: "session", version: 1, id: "session-frame", createdAt: 1 }),
        JSON.stringify({ type: "turn/start", seq: 1, time: 1, data: { turn: 1 } }),
        JSON.stringify({ type: "user/message", seq: 2, time: 2, data: { id: "frame-message", content: "cross frame prompt" } }),
        JSON.stringify({ type: "turn/end", seq: 3, time: 3, data: { turn: 1 } }),
        "",
      ].join("\n"));
      const second = await service.importAll();
      expect(second.turnsImported).toBe(1);
      expect(written).toEqual(["cross frame prompt"]);
    } finally {
      db.close();
    }
  });
  it("applies bounded defaults when import options are omitted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-default-budget-"));
    const sessionDir = join(dir, "--workspace--", "session-budget");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "session.jsonl"), [
      JSON.stringify({ type: "session", version: 1, id: "session-budget", createdAt: 1 }),
      JSON.stringify({ type: "turn/start", seq: 1, data: { turn: 1 } }),
      JSON.stringify({ type: "user/message", seq: 2, data: { content: "bounded" } }),
      JSON.stringify({ type: "turn/end", seq: 3, data: { turn: 1 } }),
      "",
    ].join("\n"));
    const db = new MemoryDb({ path: join(dir, "mem.sqlite") });
    try {
      const service = new DshImportService({ repos: new Repositories(db.db), root: dir, writeMemory: () => "memory-budget" });
      const result = await service.importAll();
      expect(result.sessionsSeen).toBe(1);
      expect(result.turnsImported).toBe(1);
    } finally {
      db.close();
    }
  });
  it("reconstructs an incomplete turn across appended zstd frames", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-zstd-incremental-"));
    const sessionDir = join(dir, "--workspace--", "session-zstd");
    mkdirSync(sessionDir, { recursive: true });
    const sessionPath = join(sessionDir, "session.jsonl.zstd");
    const frame = (lines: object[]) => zstdCompressSync(Buffer.from(lines.map((line) => JSON.stringify(line)).join("\n") + "\n"));
    writeFileSync(sessionPath, frame([
      { type: "session", version: 1, id: "session-zstd", createdAt: 1 },
      { type: "turn/start", seq: 1, data: { turn: 1 } },
      { type: "user/message", seq: 2, data: { content: "zstd cross frame" } },
    ]));
    const db = new MemoryDb({ path: join(dir, "mem.sqlite") });
    try {
      const written: string[] = [];
      const service = new DshImportService({ repos: new Repositories(db.db), root: dir, writeMemory: (request) => {
        written.push(request.content);
        return "memory-zstd";
      } });
      expect((await service.importAll()).turnsImported).toBe(0);
      writeFileSync(sessionPath, Buffer.concat([
        readFileSync(sessionPath),
        frame([{ type: "turn/end", seq: 3, data: { turn: 1 } }]),
      ]));
      expect((await service.importAll()).turnsImported).toBe(1);
      expect(written).toEqual(["zstd cross frame"]);
    } finally {
      db.close();
    }
  });
  it("imports an atomic zstd frame larger than the byte budget", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-zstd-budget-"));
    const sessionDir = join(dir, "--workspace--", "session-zstd-budget");
    mkdirSync(sessionDir, { recursive: true });
    const payload = "incompressible-" + Array.from({ length: 128 }, (_, index) => `${index}-${Math.random()}`).join("|");
    writeFileSync(join(sessionDir, "session.jsonl.zstd"), zstdCompressSync(Buffer.from([
      JSON.stringify({ type: "session", version: 1, id: "session-zstd-budget", createdAt: 1 }),
      JSON.stringify({ type: "turn/start", seq: 1, data: { turn: 1 } }),
      JSON.stringify({ type: "user/message", seq: 2, data: { content: payload } }),
      JSON.stringify({ type: "turn/end", seq: 3, data: { turn: 1 } }),
      "",
    ].join("\n"))));
    const db = new MemoryDb({ path: join(dir, "mem.sqlite") });
    try {
      const written: string[] = [];
      const service = new DshImportService({ repos: new Repositories(db.db), root: dir, writeMemory: (request) => {
        written.push(request.content);
        return "memory-zstd-budget";
      } });
      const result = await service.importAll({ maxSessionBytes: 32 });
      expect(result.turnsImported).toBe(1);
      expect(written).toEqual([payload]);
    } finally {
      db.close();
    }
  });
  it("retains the chunk when a turn budget leaves complete turns pending", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-turn-budget-"));
    const sessionDir = join(dir, "--workspace--", "session-turn-budget");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "session.jsonl"), [
      JSON.stringify({ type: "session", version: 1, id: "session-turn-budget", createdAt: 1 }),
      JSON.stringify({ type: "turn/start", seq: 1, data: { turn: 1 } }),
      JSON.stringify({ type: "user/message", seq: 2, data: { content: "first budget turn" } }),
      JSON.stringify({ type: "turn/end", seq: 3, data: { turn: 1 } }),
      JSON.stringify({ type: "turn/start", seq: 4, data: { turn: 2 } }),
      JSON.stringify({ type: "user/message", seq: 5, data: { content: "second budget turn" } }),
      JSON.stringify({ type: "turn/end", seq: 6, data: { turn: 2 } }),
      "",
    ].join("\n"));
    const db = new MemoryDb({ path: join(dir, "mem.sqlite") });
    try {
      const service = new MemoryService({ db, mode: "dev" });
      const first = await service.importDshHistory({ root: dir, maxTurnsPerSession: 1 });
      const second = await service.importDshHistory({ root: dir, maxTurnsPerSession: 1 });
      expect(first.turnsImported).toBe(1);
      expect(second.turnsImported).toBe(1);
      expect(db.db.prepare("SELECT memory_value FROM memories WHERE memory_value LIKE '%budget turn%'").all()).toHaveLength(2);
    } finally {
      db.close();
    }
  });
});


function requireNewId(): { newId: (prefix: string) => string } {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return { newId: (prefix: string) => prefix + "-" + Math.random().toString(36).slice(2) };
}
