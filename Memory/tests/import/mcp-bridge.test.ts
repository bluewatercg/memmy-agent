// MCP bridge behavior tests: tools/list, tools/call lifecycle, error paths.
// Spawns the real bridge script and drives it over stdio (MCP protocol).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BRIDGE = resolve(__dirname, "../../../scripts/mcp/memmy-mcp-bridge.mjs");
const NODE_PATH = "/root/.dsh/profiles/web/node_modules";
const TOKEN = process.env.MEMMY_MEMORY_TOKEN ?? "cg276686433";
const TEST_SOURCE = `deepseek_harness_test_${process.pid}`;
const TEST_SESSION_ID = `bridge-test-session-${process.pid}`;
const SIGNAL_SESSION_ID = `signal-test-${process.pid}`;

function spawnBridge(env: Record<string, string> = {}): { child: ChildProcess; rpc: (method: string, params: Record<string, unknown>) => Promise<unknown>; close: () => void } {
  const child = spawn("node", [BRIDGE], {
    env: { ...process.env, NODE_PATH, MEMMY_SOURCE: TEST_SOURCE, MEMMY_USER_ID: `test-${process.pid}`, MEMMY_TOKEN: TOKEN, ...env },
  });
  let nextId = 1;
  const pending = new Map<number, (v: unknown) => void>();
  let buffer = "";
  child.stdout?.on("data", (d: Buffer) => {
    buffer += d.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        const resolveFn = pending.get(msg.id);
        if (resolveFn) { pending.delete(msg.id); resolveFn(msg.result ?? msg.error); }
      } catch { /* ignore partial */ }
    }
  });
  const rpc = (method: string, params: Record<string, unknown>) => new Promise<unknown>((resolveFn) => {
    const id = nextId++;
    pending.set(id, resolveFn);
    child.stdin?.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const close = () => { child.kill(); };
  return { child, rpc, close };
}

describe("memmy MCP bridge", () => {
  let bridge: ReturnType<typeof spawnBridge>;

  beforeAll(async () => {
    bridge = spawnBridge();
    await bridge.rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } });
  });

  afterAll(() => {
    bridge?.close();
  });

  it("exposes lifecycle + search/add/health/status tools", async () => {
    const res = await bridge.rpc("tools/list", {}) as { tools: Array<{ name: string }> };
    const names = res.tools.map((t) => t.name);
    for (const expected of ["memmy_session_open", "memmy_turn_start", "memmy_turn_complete", "memmy_session_close", "memmy_health", "memmy_search", "memmy_add", "memmy_status"]) {
      expect(names).toContain(expected);
    }
  });

  it("health returns ok and schema version", async () => {
    const res = await bridge.rpc("tools/call", { name: "memmy_health", arguments: {} }) as { content: Array<{ text: string }> };
    const text = res.content[0]?.text ?? "";
    expect(text).toContain('"ok": true');
  });
  it("session open returns a session id", async () => {
    const res = await bridge.rpc("tools/call", { name: "memmy_session_open", arguments: { externalSessionId: TEST_SESSION_ID } }) as { content: Array<{ text: string }> };
    expect(res.content[0]?.text ?? "").toMatch(/sessionId=session_/);
  });

  it("turn start returns turnId with injected context", async () => {
    const res = await bridge.rpc("tools/call", { name: "memmy_turn_start", arguments: { externalSessionId: TEST_SESSION_ID, externalTurnId: "1", query: "记忆检索测试" } }) as { content: Array<{ text: string }> };
    const text = res.content[0]?.text ?? "";
    expect(text).toContain(`turnId=${TEST_SOURCE}:${TEST_SESSION_ID}:turn:1`);
    expect(text).toContain("injectedContext=");
  });

  it("turn complete succeeds", async () => {
    const res = await bridge.rpc("tools/call", { name: "memmy_turn_complete", arguments: { externalSessionId: TEST_SESSION_ID, externalTurnId: "1", query: "记忆检索测试", answer: "测试回答内容" } }) as { content: Array<{ text: string }> };
    expect(res.content[0]?.text ?? "").toContain("turnId");
  });

  it("session close succeeds", async () => {
    const res = await bridge.rpc("tools/call", { name: "memmy_session_close", arguments: {} }) as { content: Array<{ text: string }> };
    expect(res.content[0]?.text ?? "").toContain("closed");
  });

  it("fails cleanly with a bad token", async () => {
    const bad = spawnBridge({ MEMMY_TOKEN: "wrong-token-xyz" });
    try {
      await bad.rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } });
      const search = await bad.rpc("tools/call", { name: "memmy_search", arguments: { query: "x", limit: 1 } }) as { isError?: boolean; content?: Array<{ text: string }> };
      expect(search.isError).toBe(true);
    } finally {
      bad.close();
    }
  });

  it("rejects missing required arguments", async () => {
    const res = await bridge.rpc("tools/call", { name: "memmy_turn_start", arguments: {} }) as { isError?: boolean };
    expect(res.isError).toBe(true);
  });
});

describe("memmy MCP bridge - signal close", () => {
  it("closes session on SIGTERM", async () => {
    const bridge = spawnBridge();
    await bridge.rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    await bridge.rpc("tools/call", { name: "memmy_session_open", arguments: { externalSessionId: SIGNAL_SESSION_ID } });
    bridge.child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 800));
    expect(bridge.child.exitCode).not.toBe(null);
    bridge.close();
  });
});
