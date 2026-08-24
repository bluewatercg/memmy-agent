import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

async function loadPlugin(stateDir) {
  process.env.MEMMY_PLUGIN_STATE_DIR = stateDir;
  process.env.MEMMY_RETRY_BASE_MS = "20";
  process.env.MEMMY_RETRY_MAX_MS = "40";
  process.env.MEMMY_RETRY_FLUSH_MS = "5";
  process.env.MEMMY_REQUEST_TIMEOUT_MS = "20";
  return import(`./index.mjs?test=${Date.now()}-${Math.random()}`);
}

function harness(apply, config = {}, currentInitiator = () => undefined) {
  const handlers = new Map();
  const cleanup = apply({
    on: (name, handler) => handlers.set(name, handler),
    agents: { currentInitiator },
  }, { url: "http://memmy.test", token: "test", workspacePath: "/tmp", ...config });
  return { handlers, cleanup };
}

async function retryEntries(stateDir) {
  const text = await readFile(join(stateDir, "retry.jsonl"), "utf8").catch(() => "");
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}
async function pendingTurns(stateDir) {
  return JSON.parse(await readFile(join(stateDir, "pending-turns.json"), "utf8").catch(() => "{}"));
}

test("queued failures record attempt and nextAttemptAt", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "memmy-plugin-retry-"));
  globalThis.fetch = async () => new Response("down", { status: 503 });
  const { apply } = await loadPlugin(stateDir);
  const { handlers, cleanup } = harness(apply);

  await handlers.get("agent/created")({ agent: { id: "retry-meta", session: { id: "retry-meta", events: [] } } });
  await new Promise((resolve) => setTimeout(resolve, 5));

  const [entry] = await retryEntries(stateDir);
  assert.ok(entry.attempt >= 1);
  assert.match(entry.nextAttemptAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(Date.parse(entry.nextAttemptAt) >= Date.parse(entry.queuedAt) + 20);
  await cleanup();
});

test("periodic flush retries due work and clears it after recovery", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "memmy-plugin-recover-"));
  let available = false;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return available
      ? new Response(JSON.stringify({ outcome: "acquired", sessionId: "memmy-session" }), { status: 200 })
      : new Response("down", { status: 503 });
  };
  const { apply } = await loadPlugin(stateDir);
  const { handlers, cleanup } = harness(apply);

  await handlers.get("agent/created")({ agent: { id: "retry-recover", session: { id: "retry-recover", events: [] } } });
  available = true;
  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.ok(calls >= 2);
  assert.deepEqual(await retryEntries(stateDir), []);
  await cleanup();
});

test("failed retries use capped exponential backoff", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "memmy-plugin-backoff-"));
  globalThis.fetch = async () => new Response("down", { status: 503 });
  const { apply } = await loadPlugin(stateDir);
  const { handlers, cleanup } = harness(apply);

  await handlers.get("agent/created")({ agent: { id: "retry-backoff", session: { id: "retry-backoff", events: [] } } });
  await new Promise((resolve) => setTimeout(resolve, 75));
  await cleanup();

  const [entry] = await retryEntries(stateDir);
  assert.ok(entry.attempt >= 2);
  const delay = Date.parse(entry.nextAttemptAt) - Date.parse(entry.lastAttemptAt);
  assert.ok(delay <= 40);
  assert.ok(delay >= 20);
  assert.ok(entry.attempt >= 2);
});

test("aborts a hanging Memmy request within the configured timeout", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "memmy-plugin-timeout-"));
  const { apply } = await loadPlugin(stateDir);
  globalThis.fetch = async (_url, options) => await new Promise((_, reject) => {
    assert.ok(options.signal);
    options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
  const { handlers, cleanup } = harness(apply);
  const started = Date.now();
  await handlers.get("agent/created")({ agent: { id: "timeout", session: { id: "timeout", events: [] } } });
  assert.ok(Date.now() - started < 500);
  await cleanup();
});

test("writes a DSH turn with real tool-result message content", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "memmy-plugin-turn-"));
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    const request = { url: String(url), method: options.method ?? "GET", body: options.body ? JSON.parse(options.body) : undefined };
    requests.push(request);
    const path = new URL(request.url).pathname;
    if (path === "/api/v1/dsh/claims") return Response.json({ outcome: "acquired", claim: { owner: "dsh-plugin:1:session-1" } });
    if (path === "/api/v1/sessions/open") return Response.json({ sessionId: "memmy-session-1" });
    if (path === "/api/v1/asset-recalls") return Response.json({ items: [{ eventId: "offered-1" }] });
    if (path === "/api/v1/turns/start") return Response.json({ injectedContext: "" });
    return Response.json({ ok: true });
  };
  const { apply } = await loadPlugin(stateDir);
  const agent = {
    id: "session-1",
    session: {
      id: "session-1",
      events: [
        { type: "turn/start", data: { turn: 1 } },
        { type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: "inspect deployment" }] } },
        { type: "tool/call", data: { turn: 1, callId: "call-1", name: "shell", arguments: { command: "status" } } },
        { type: "tool/result", data: { turn: 1, message: { callId: "call-1", content: [{ type: "text", text: "clean" }], isError: false } } },
        { type: "assistant/message", data: { turn: 1, message: { content: [{ type: "text", text: "deployment is clean" }] } } }
      ]
    }
  };
  const { handlers, cleanup } = harness(apply);

  await handlers.get("agent/created")({ agent });
  await handlers.get("agent/pre-step")({ agent, messages: [{ role: "user", content: "inspect deployment" }], turn: 1 }, async () => ({ kind: "enter", messages: [] }));
  await handlers.get("agent/turn-stopping")({ agent, turn: 1 });

  const completed = requests.find((request) => new URL(request.url).pathname.endsWith("/turns/deepseek_harness%3Asession-1%3Aturn%3A1/complete"));
  assert.ok(completed);
  assert.deepEqual(completed.body.toolResults, [{ id: "call-1", output: "clean", success: true }]);
  await cleanup();
});

test("injects recall, records asset outcome, and releases its session claim", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "memmy-plugin-lifecycle-"));
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    const request = { url: String(url), method: options.method ?? "GET", body: options.body ? JSON.parse(options.body) : undefined };
    requests.push(request);
    const path = new URL(request.url).pathname;
    if (path === "/api/v1/dsh/claims") return Response.json({ outcome: "acquired" });
    if (path === "/api/v1/sessions/open") return Response.json({ sessionId: "memmy-session-lifecycle" });
    if (path === "/api/v1/asset-recalls") return Response.json({ items: [{ eventId: "offered-lifecycle" }] });
    if (path === "/api/v1/turns/start") return Response.json({ injectedContext: "use the deployment runbook" });
    return Response.json({ ok: true });
  };
  const { apply } = await loadPlugin(stateDir);
  const agent = {
    id: "session-lifecycle",
    session: {
      id: "session-lifecycle",
      events: [
        { type: "turn/start", data: { turn: 2 } },
        { type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: "deploy safely" }] } },
        { type: "tool/call", data: { turn: 2, callId: "call-lifecycle", name: "shell", arguments: {} } },
        { type: "tool/result", data: { turn: 2, message: { callId: "call-lifecycle", content: [{ type: "text", text: "ok" }] } } },
        { type: "assistant/message", data: { turn: 2, message: { content: [{ type: "text", text: "deployed" }] } } }
      ]
    }
  };
  const { handlers, cleanup } = harness(apply);

  await handlers.get("agent/created")({ agent });
  const decision = await handlers.get("agent/pre-step")({ agent, messages: [{ role: "user", content: [{ type: "text", text: "deploy safely" }] }], turn: 2 }, async () => ({ kind: "enter", messages: [{ role: "user", content: [{ type: "text", text: "deploy safely" }] }] }));
  const turnStarted = requests.find((request) => new URL(request.url).pathname === "/api/v1/turns/start");
  assert.equal(turnStarted.body.query, "deploy safely");
  assert.equal(decision.messages[0].content[0].text, "[memmy recall]\nuse the deployment runbook\n\n");
  await handlers.get("agent/turn-stopping")({ agent, turn: 2 });
  await handlers.get("agent/disposed")({ agent });

  const paths = requests.map((request) => new URL(request.url).pathname);
  assert.ok(paths.includes("/api/v1/asset-recalls/offered-lifecycle/outcome"));
  const outcome = requests.find((request) => new URL(request.url).pathname === "/api/v1/asset-recalls/offered-lifecycle/outcome");
  assert.deepEqual(outcome.body, {
    eventKey: "deepseek_harness:session-lifecycle:turn:2:assets:outcome",
    outcome: "used",
    evidenceIds: []
  });
  assert.ok(paths.includes("/api/v1/sessions/memmy-session-lifecycle/close"));
  assert.ok(requests.some((request) => request.method === "DELETE" && new URL(request.url).pathname === "/api/v1/dsh/claims/session-lifecycle"));
  await cleanup();
  assert.deepEqual(await pendingTurns(stateDir), {});
  assert.deepEqual(await retryEntries(stateDir), []);
});
test("cleanup waits for an in-flight retry flush before returning", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "memmy-plugin-cleanup-boundary-"));
  const retry = {
    path: "/api/v1/retry-target",
    request: { method: "POST", body: { value: "queued" } },
    attempt: 1,
    queuedAt: new Date(0).toISOString(),
    lastAttemptAt: new Date(0).toISOString(),
    nextAttemptAt: new Date(0).toISOString(),
  };
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(stateDir, "retry.jsonl"), `${JSON.stringify(retry)}\n`);
  let retryStarted;
  const retryRequestStarted = new Promise((resolve) => { retryStarted = resolve; });
  let releaseRetry;
  const retryResponse = new Promise((resolve) => { releaseRetry = resolve; });
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === "/api/v1/retry-target") {
      retryStarted();
      await retryResponse;
    }
    return Response.json({ ok: true });
  };
  const { apply } = await loadPlugin(stateDir);
  const { cleanup } = harness(apply);
  await retryRequestStarted;
  let cleaned = false;
  const cleanupPromise = cleanup().then(() => { cleaned = true; });
  await Promise.resolve();
  assert.equal(cleaned, false);
  assert.deepEqual(await retryEntries(stateDir), [retry]);
  releaseRetry();
  await cleanupPromise;
  assert.deepEqual(await retryEntries(stateDir), []);
});

test("isolates config and sessions between plugin instances", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "memmy-plugin-instances-"));
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    const parsed = new URL(String(url));
    requests.push({ host: parsed.host, path: parsed.pathname, method: options.method ?? "GET" });
    if (parsed.pathname === "/api/v1/dsh/claims") return Response.json({ outcome: "acquired" });
    if (parsed.pathname === "/api/v1/sessions/open") return Response.json({ sessionId: `${parsed.host}-session` });
    return Response.json({ ok: true });
  };
  const { apply } = await loadPlugin(stateDir);
  const first = harness(apply, { url: "http://first.test" });
  const second = harness(apply, { url: "http://second.test" });
  await first.handlers.get("agent/created")({ agent: { id: "first", session: { id: "first", events: [] } } });
  await second.handlers.get("agent/created")({ agent: { id: "second", session: { id: "second", events: [] } } });

  await first.cleanup();
  assert.ok(requests.some((request) => request.host === "first.test" && request.path.includes("first.test-session/close")));
  assert.ok(!requests.some((request) => request.host === "first.test" && request.path.includes("second.test-session/close")));
  await second.cleanup();
  assert.ok(requests.some((request) => request.host === "second.test" && request.path.includes("second.test-session/close")));
});

test("serializes concurrent pending turn updates", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "memmy-plugin-pending-concurrency-"));
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === "/api/v1/dsh/claims") return Response.json({ outcome: "acquired" });
    if (path === "/api/v1/sessions/open") return Response.json({ sessionId: `memmy-${Math.random()}` });
    if (path === "/api/v1/turns/start") return Response.json({ injectedContext: "" });
    return Response.json({ ok: true });
  };
  const { apply } = await loadPlugin(stateDir);
  const { handlers, cleanup } = harness(apply);
  const agents = [1, 2].map((turn) => ({ id: `parallel-${turn}`, session: { id: `parallel-${turn}`, events: [] } }));
  await Promise.all(agents.map((agent) => handlers.get("agent/created")({ agent })));
  await Promise.all(agents.map((agent, index) => handlers.get("agent/pre-step")(
    { agent, messages: [{ role: "user", content: `query-${index + 1}` }], turn: index + 1 },
    async () => ({ kind: "enter", messages: [] }),
  )));

  assert.deepEqual(Object.keys(await pendingTurns(stateDir)).sort(), [
    "deepseek_harness:parallel-1:turn:1",
    "deepseek_harness:parallel-2:turn:2",
  ]);
  await cleanup();
});

test("quarantines malformed retry lines without blocking valid retries", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "memmy-plugin-malformed-retry-"));
  const retry = {
    path: "/api/v1/retry-valid",
    request: { method: "POST" },
    attempt: 1,
    queuedAt: new Date(0).toISOString(),
    lastAttemptAt: new Date(0).toISOString(),
    nextAttemptAt: new Date(0).toISOString(),
  };
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(stateDir, "retry.jsonl"), `{broken\n${JSON.stringify(retry)}\n`);
  const paths = [];
  globalThis.fetch = async (url) => {
    paths.push(new URL(String(url)).pathname);
    return Response.json({ ok: true });
  };
  const { apply } = await loadPlugin(stateDir);
  const { cleanup } = harness(apply);
  await cleanup();

  assert.ok(paths.includes("/api/v1/retry-valid"));
  assert.deepEqual(await retryEntries(stateDir), []);
  assert.equal(await readFile(join(stateDir, "retry.invalid.jsonl"), "utf8"), "{broken\n");
});

test("periodic pending recovery clears a successfully replayed completion", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "memmy-plugin-pending-recovery-"));
  let completionAttempts = 0;
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === "/api/v1/dsh/claims") return Response.json({ outcome: "acquired" });
    if (path === "/api/v1/sessions/open") return Response.json({ sessionId: "memmy-pending" });
    if (path.endsWith("/complete")) {
      completionAttempts += 1;
      if (completionAttempts === 1) return new Response("down", { status: 503 });
    }
    return Response.json({ ok: true });
  };
  const { apply } = await loadPlugin(stateDir);
  const agent = {
    id: "pending-recovery",
    session: {
      id: "pending-recovery",
      events: [
        { type: "turn/start", data: { turn: 1 } },
        { type: "user/message", data: { source: { kind: "user" }, content: "persist me" } },
        { type: "assistant/message", data: { turn: 1, message: { content: "persisted" } } },
      ],
    },
  };
  const { handlers, cleanup } = harness(apply);
  await handlers.get("agent/created")({ agent });
  await handlers.get("agent/turn-stopping")({ agent, turn: 1 });
  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.ok(completionAttempts >= 2);
  assert.deepEqual(await pendingTurns(stateDir), {});
  assert.deepEqual(await retryEntries(stateDir), []);
  await cleanup();
});

test("cleanup waits for an in-flight heartbeat", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "memmy-plugin-heartbeat-cleanup-"));
  process.env.MEMMY_HEARTBEAT_MS = "10";
  let heartbeatStarted;
  const heartbeatRequestStarted = new Promise((resolve) => { heartbeatStarted = resolve; });
  let releaseHeartbeat;
  const heartbeatResponse = new Promise((resolve) => { releaseHeartbeat = resolve; });
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === "/api/v1/dsh/claims") return Response.json({ outcome: "acquired" });
    if (path === "/api/v1/sessions/open") return Response.json({ sessionId: "memmy-heartbeat" });
    if (path.endsWith("/heartbeat")) {
      heartbeatStarted();
      await heartbeatResponse;
    }
    return Response.json({ ok: true });
  };
  const { apply } = await loadPlugin(stateDir);
  const { handlers, cleanup } = harness(apply);
  await handlers.get("agent/created")({ agent: { id: "heartbeat", session: { id: "heartbeat", events: [] } } });
  await heartbeatRequestStarted;
  let cleaned = false;
  const cleanupPromise = cleanup().then(() => { cleaned = true; });
  await Promise.resolve();
  assert.equal(cleaned, false);
  releaseHeartbeat();
  await cleanupPromise;
});

test("keeps concurrent session turn write-backs bound to their originating agents", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "memmy-plugin-turn-owner-"));
  const completions = [];
  globalThis.fetch = async (url, options = {}) => {
    const path = new URL(String(url)).pathname;
    const body = options.body ? JSON.parse(options.body) : undefined;
    if (path === "/api/v1/dsh/claims") return Response.json({ outcome: "acquired" });
    if (path === "/api/v1/sessions/open") return Response.json({ sessionId: body.sessionKey });
    if (path.endsWith("/complete")) completions.push({ path, body });
    if (path === "/api/v1/turns/start") return Response.json({ injectedContext: "" });
    return Response.json({ ok: true });
  };
  const { apply } = await loadPlugin(stateDir);
  const agents = Array.from({ length: 24 }, (_, index) => {
    const ordinal = String(index + 1).padStart(2, "0");
    const id = `concurrent-${ordinal}`;
    return {
      id,
      session: { id, events: [
        { type: "turn/start", data: { turn: 1 } },
        { type: "user/message", data: { source: { kind: "user" }, content: `query-${ordinal}` } },
        { type: "assistant/message", data: { turn: 1, message: { content: `answer-${ordinal}` } } },
      ] },
    };
  });
  const initiators = new AsyncLocalStorage();
  const { handlers, cleanup } = harness(apply, {}, () => initiators.getStore());
  await Promise.all(agents.map((agent) => handlers.get("agent/created")({ agent })));
  await Promise.all(agents.map((agent) => handlers.get("agent/pre-step")(
    { agent, messages: [{ role: "user", content: agent.id }], turn: 1 },
    async () => ({ kind: "enter", messages: [] }),
  )));
  await Promise.all(agents.map((agent) => initiators.run(
    agent,
    () => handlers.get("agent/turn-stopping")({ turn: 1 }),
  )));

  const actual = completions
    .map(({ path, body }) => ({ path, sessionId: body.sessionId, query: body.query, answer: body.answer }))
    .sort((left, right) => left.sessionId.localeCompare(right.sessionId));
  const expected = agents.map((agent, index) => {
    const ordinal = String(index + 1).padStart(2, "0");
    return {
      path: `/api/v1/turns/deepseek_harness%3A${agent.id}%3Aturn%3A1/complete`,
      sessionId: agent.id,
      query: `query-${ordinal}`,
      answer: `answer-${ordinal}`,
    };
  });
  assert.deepEqual(actual, expected);
  await cleanup();
});
