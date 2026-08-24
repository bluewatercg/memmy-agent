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
  let repos: Repositories;
  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-state-test-"));
    db = new MemoryDb({ path: join(dir, "mem.sqlite") });
    repos = new Repositories(db.db);
    state = new DshImportState(repos);
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

  it("rejects a stale runtime KV conditional update", () => {
    const { runtime } = new Repositories(db.db);
    runtime.setKv("cas:key", { owner: "first" }, "2026-08-16T00:00:00.000Z");
    const observed = runtime.getKv("cas:key");
    runtime.setKv("cas:key", { owner: "winner" }, "2026-08-16T00:00:01.000Z");

    expect(runtime.setKvIfValue("cas:key", observed?.value, { owner: "stale" })).toBe(false);
    expect(runtime.getKv("cas:key")?.value).toEqual({ owner: "winner" });
  });

  it("allows only one contender to replace the same expired claim value", () => {
    state.claim("sess-race", "realtime", "original");
    const { runtime } = new Repositories(db.db);
    const key = state.claimKey("sess-race");
    const existing = runtime.getKv(key);
    const expired = { ...(existing?.value as object), expiresAt: "2026-08-15T00:00:00.000Z" };
    runtime.setKv(key, expired, "2026-08-15T00:00:00.000Z");

    const first = runtime.setKvIfValue(key, expired, { channel: "historical", owner: "first" });
    const second = runtime.setKvIfValue(key, expired, { channel: "historical", owner: "second" });

    expect([first, second]).toEqual([true, false]);
    expect(runtime.getKv(key)?.value).toEqual({ channel: "historical", owner: "first" });
  });

  it("reports existing when an expired replacement loses its CAS", () => {
    state.claim("sess-expired-race", "realtime", "original");
    const { runtime } = repos;
    const key = state.claimKey("sess-expired-race");
    const original = runtime.getKv(key)?.value as object;
    runtime.setKv(key, { ...original, expiresAt: "2026-08-15T00:00:00.000Z" });
    const setKvIfValue = runtime.setKvIfValue.bind(runtime);
    runtime.setKvIfValue = (casKey, expected, value, at) => {
      runtime.setKv(casKey, { channel: "historical", claimedAt: at, owner: "winner", expiresAt: "2099-01-01T00:00:00.000Z" }, at);
      return setKvIfValue(casKey, expected, value, at);
    };

    expect(state.claim("sess-expired-race", "historical", "loser")).toBe("existing");
    expect(state.getClaim("sess-expired-race")?.owner).toBe("winner");
  });

  it("does not renew after the observed claim changes owner", () => {
    state.claim("sess-renew-race", "realtime", "original");
    const { runtime } = repos;
    const setKvIfValue = runtime.setKvIfValue.bind(runtime);
    runtime.setKvIfValue = (key, expected, value, at) => {
      runtime.setKv(key, { ...(expected as object), owner: "winner" }, at);
      return setKvIfValue(key, expected, value, at);
    };

    expect(state.renew("sess-renew-race", "original")).toBe(false);
    expect(state.getClaim("sess-renew-race")?.owner).toBe("winner");
  });

  it("does not release after the observed claim changes owner", () => {
    state.claim("sess-release-race", "realtime", "original");
    const { runtime } = repos;
    const setKvIfValue = runtime.setKvIfValue.bind(runtime);
    runtime.setKvIfValue = (key, expected, value, at) => {
      runtime.setKv(key, { ...(expected as object), owner: "winner" }, at);
      return setKvIfValue(key, expected, value, at);
    };

    expect(state.release("sess-release-race", "original")).toBe(false);
    expect(state.getClaim("sess-release-race")?.owner).toBe("winner");
  });

  it("release marks the claim released", () => {
    state.claim("sess-1", "realtime", "plugin");
    expect(state.release("sess-1", "plugin")).toBe(true);
    expect(state.release("sess-1", "wrong-owner")).toBe(false);
  });
  it("allows a released claim to be acquired by another channel", () => {
    state.claim("sess-1", "realtime", "plugin");
    state.release("sess-1", "plugin");
    expect(state.claim("sess-1", "historical", "importer")).toBe("expired-replaced");
    expect(state.getClaim("sess-1")?.owner).toBe("importer");
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
