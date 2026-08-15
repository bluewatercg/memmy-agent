import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryDb } from "../../src/index.js";
import { Repositories } from "../../src/storage/repositories.js";
import { DshImportState, CLAIM_TTL_MS } from "../../src/service/import/dsh/import-state.js";

describe("dsh import state (claims + checkpoints)", () => {
  let db: MemoryDb;
  let state: DshImportState;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-state-test-"));
    db = new MemoryDb({ path: join(dir, "mem.sqlite") });
    state = new DshImportState(new Repositories(db.db));
  });

  it("acquires a claim when absent", () => {
    expect(state.claim("sess-1", "realtime", "plugin")).toBe("acquired");
    const claim = state.getClaim("sess-1");
    expect(claim?.channel).toBe("realtime");
    expect(claim?.owner).toBe("plugin");
  });

  it("returns existing for a live claim", () => {
    state.claim("sess-1", "realtime", "plugin");
    expect(state.claim("sess-1", "historical", "importer")).toBe("existing");
  });

  it("replaces an expired claim", () => {
    state.claim("sess-1", "realtime", "plugin");
    // manually backdate the expiry
    const at = new Date(Date.now() - CLAIM_TTL_MS - 1000).toISOString();
    const { runtime } = new Repositories(db.db);
    const key = state.claimKey("sess-1");
    const existing = runtime.getKv(key);
    runtime.setKv(key, { ...(existing?.value as object), expiresAt: at }, at);
    expect(state.claim("sess-1", "historical", "importer")).toBe("expired-replaced");
  });

  it("release marks the claim released", () => {
    state.claim("sess-1", "realtime", "plugin");
    expect(state.release("sess-1", "plugin")).toBe(true);
    expect(state.release("sess-1", "wrong-owner")).toBe(false);
  });

  it("reaps expired claims", () => {
    state.claim("sess-1", "realtime", "plugin");
    state.claim("sess-2", "realtime", "plugin");
    const at = new Date(Date.now() + CLAIM_TTL_MS + 5000).toISOString();
    expect(state.reapExpired(at)).toBe(2);
  });

  it("persists and reads checkpoints", () => {
    state.saveCheckpoint({
      sourcePath: "/tmp/session.jsonl.zstd",
      frameEndOffset: 1234,
      lastFrameIndex: 5,
      mtimeMs: 111,
      lastSeq: 42,
      lastEventId: "e42",
      status: "complete",
      updatedAt: "2026-08-15T00:00:00.000Z",
    });
    const cp = state.getCheckpoint("/tmp/session.jsonl.zstd");
    expect(cp?.lastSeq).toBe(42);
    expect(cp?.status).toBe("complete");
  });
});
