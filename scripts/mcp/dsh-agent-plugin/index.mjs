// Memmy agent-plane plugin for DeepSeek Harness.
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
// Mounted as an agent preset; lifecycle failures must not block DSH.
const DEFAULT_URL = "http://127.0.0.1:18960";
const DEFAULT_TOKEN = process.env.MEMMY_TOKEN ?? process.env.MEMMY_MEMORY_TOKEN ?? "";
const DEFAULT_WORKSPACE = process.env.MEMMY_WORKSPACE_PATH ?? process.cwd();
const SOURCE = "deepseek_harness";
const ADAPTER_ID = "agent-source:deepseek_harness";
const RETRY_ROOT = process.env.MEMMY_PLUGIN_STATE_DIR ?? join(DEFAULT_WORKSPACE, ".memmy", "deepseek-harness");
const RETRY_FILE = join(RETRY_ROOT, "retry.jsonl");
const PENDING_FILE = join(RETRY_ROOT, "pending-turns.json");
const INVALID_RETRY_FILE = join(RETRY_ROOT, "retry.invalid.jsonl");
const RETRY_BASE_MS = Math.max(10, Number(process.env.MEMMY_RETRY_BASE_MS ?? 5000));
const RETRY_MAX_MS = Math.max(RETRY_BASE_MS, Number(process.env.MEMMY_RETRY_MAX_MS ?? 300000));
const RETRY_FLUSH_MS = Math.max(10, Number(process.env.MEMMY_RETRY_FLUSH_MS ?? 10000));
const HEARTBEAT_MS = Math.max(10, Number(process.env.MEMMY_HEARTBEAT_MS ?? 60000));
const REQUEST_TIMEOUT_MS = Math.max(10, Number(process.env.MEMMY_REQUEST_TIMEOUT_MS ?? 10000));

let pendingQueueTail = Promise.resolve();
let retryQueueTail = Promise.resolve();
const completionTails = new Map();

function sessionKey(sessionId) { return `${SOURCE}:${sessionId}`; }
function turnKey(sessionId, turn) { return `${sessionKey(sessionId)}:turn:${turn}`; }

function createRuntime(config) {
async function savePendingTurn(key, value) {
  const run = pendingQueueTail.then(async () => {
    await mkdir(dirname(PENDING_FILE), { recursive: true });
    let pending = {};
    try { pending = JSON.parse(await readFile(PENDING_FILE, "utf8")); } catch {}
    if (value === undefined) delete pending[key]; else pending[key] = value;
    const temporary = `${PENDING_FILE}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    await writeFile(temporary, JSON.stringify(pending), "utf8");
    await rename(temporary, PENDING_FILE);
  });
  pendingQueueTail = run.then(() => undefined, () => undefined);
  return run;
}

function withCompletionLock(key, operation) {
  const previous = completionTails.get(key) ?? Promise.resolve();
  const run = previous.then(operation, operation);
  const tail = run.then(() => undefined, () => undefined);
  completionTails.set(key, tail);
  void tail.finally(() => {
    if (completionTails.get(key) === tail) completionTails.delete(key);
  });
  return run;
}

async function pendingTurns() {
  await pendingQueueTail;
  try { return JSON.parse(await readFile(PENDING_FILE, "utf8")); } catch { return {}; }
}

async function pendingTurn(key) {
  return (await pendingTurns())[key];
}

async function recoverPendingTurns() {
  const pending = await pendingTurns();
  for (const key of Object.keys(pending)) {
    await withCompletionLock(key, async () => {
      const value = await pendingTurn(key);
      if (typeof value?.answer !== "string") return;
      try {
        await memmy(`/api/v1/turns/${encodeURIComponent(key)}/complete`, { method: "POST", body: value });
        await savePendingTurn(key, undefined);
      } catch {}
    });
  }
}

const backgroundTasks = new Set();

function withRetryQueue(operation) {
  const run = retryQueueTail.then(operation, operation);
  retryQueueTail = run.then(() => undefined, () => undefined);
  return run;
}

function trackBackground(task) {
  const tracked = task.catch((error) => {
    console.error("[memmy-agent-plugin] background retry task degraded:", String(error));
  });
  backgroundTasks.add(tracked);
  void tracked.then(() => backgroundTasks.delete(tracked));
  return tracked;
}

async function waitForBackgroundTasks() {
  while (backgroundTasks.size > 0) await Promise.all([...backgroundTasks]);
  await retryQueueTail;
}

async function enqueueRetry(path, request, previous) {
  return withRetryQueue(async () => {
    await mkdir(dirname(RETRY_FILE), { recursive: true });
    const queuedAt = previous?.queuedAt ?? new Date().toISOString();
    const attempt = (previous?.attempt ?? 0) + 1;
    const now = Date.now();
    const lastAttemptAt = new Date(now).toISOString();
    const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1));
    const nextAttemptAt = new Date(now + delay).toISOString();
    await appendFile(RETRY_FILE, `${JSON.stringify({ path, request, attempt, queuedAt, lastAttemptAt, nextAttemptAt })}\n`, "utf8");
  });
}

async function replaceRetryEntries(entries) {
  await writeFile(RETRY_FILE, entries.length ? `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n` : "", "utf8");
}

async function flushRetries() {
  return withRetryQueue(async () => {
    let raw;
    try { raw = await readFile(RETRY_FILE, "utf8"); } catch { return; }
    const entries = [];
    const invalid = [];
    for (const line of raw.split("\n").filter(Boolean)) {
      try { entries.push(JSON.parse(line)); } catch { invalid.push(line); }
    }
    if (invalid.length > 0) await appendFile(INVALID_RETRY_FILE, `${invalid.join("\n")}\n`, "utf8");
    const remaining = [];
    for (const entry of entries) {
      if (Date.parse(entry.nextAttemptAt) > Date.now()) { remaining.push(entry); continue; }
      try {
        await memmy(entry.path, { ...entry.request, queueOnFailure: false });
      } catch {
        const attempt = entry.attempt + 1;
        const now = Date.now();
        const lastAttemptAt = new Date(now).toISOString();
        const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1));
        remaining.push({ ...entry, attempt, lastAttemptAt, nextAttemptAt: new Date(now + delay).toISOString() });
      }
    }
    await replaceRetryEntries(remaining);
  });
}

  const runtimeConfig = {
    url: (config?.url ?? process.env.MEMMY_URL ?? DEFAULT_URL).replace(/\/$/, ""),
    token: config?.token ?? DEFAULT_TOKEN,
    workspacePath: config?.workspacePath ?? DEFAULT_WORKSPACE,
    userId: config?.userId ?? "deepseek-harness",
  };

// ── helpers ─────────────────────────────────────────────────────────────────

async function memmy(path, { method = "GET", body, queueOnFailure = true } = {}) {
  const headers = {
    "x-memmy-user-id": runtimeConfig.userId,
    "x-memmy-workspace-path": runtimeConfig.workspacePath,
    authorization: `Bearer ${runtimeConfig.token}`,
  };
  let payload;
  if (body !== undefined) { headers["content-type"] = "application/json"; payload = JSON.stringify(body); }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${runtimeConfig.url}${path}?source=${SOURCE}`, { method, headers, body: payload, signal: controller.signal });
    const text = await res.text();
    let json;
    try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
    if (!res.ok) throw new Error(`memmy ${path} -> ${res.status}: ${json?.error?.message ?? text}`);
    return json;
  } catch (error) {
    if (queueOnFailure) await enqueueRetry(path, { method, body });
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function claimOwner(sessionId) { return `dsh-plugin:${process.pid}:${sessionId}`; }
async function claimSession(sessionId) {
  const result = await memmy("/api/v1/dsh/claims", {
    method: "POST",
    body: { sessionId, channel: "realtime", owner: claimOwner(sessionId) },
  });
  if (result?.outcome === "existing" && result.claim?.owner !== claimOwner(sessionId)) {
    throw new Error(`dsh session claim is owned by ${result.claim?.owner ?? "another process"}`);
  }
  return result;
}

async function heartbeatClaim(sessionId) {
  return memmy(`/api/v1/dsh/claims/${encodeURIComponent(sessionId)}/heartbeat`, {
    method: "POST",
    body: { owner: claimOwner(sessionId) },
  });
}
async function releaseClaim(sessionId) {
  return memmy(`/api/v1/dsh/claims/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
    body: { owner: claimOwner(sessionId) },
  });
}
const sessions = new Map(); // sessionId -> memmy sessionId
const offeredAssets = new Map();

async function recallAssets(sessionId, turn, query) {
  const eventKey = `${turnKey(sessionId, turn)}:assets`;
  const result = await memmy("/api/v1/asset-recalls", {
    method: "POST",
    body: { eventKey, mode: "recall", risk: "low", signals: [], taskType: "deepseek_harness", episodeId: sessionKey(sessionId) },
  });
  const items = Array.isArray(result?.items) ? result.items : [];
  offeredAssets.set(eventKey, items.map((item) => item?.eventId ?? item?.offeredEventId).filter(Boolean));
  return items;
}

async function recordAssetOutcomes(sessionId, turn, tools) {
  const eventKey = `${turnKey(sessionId, turn)}:assets`;
  const outcome = tools.some((tool) => tool.success === false)
    ? "failed"
    : tools.length > 0
      ? "used"
      : "ignored";
  for (const offeredEventId of offeredAssets.get(eventKey) ?? []) {
    await memmy(`/api/v1/asset-recalls/${encodeURIComponent(offeredEventId)}/outcome`, {
      method: "POST",
      body: { eventKey: `${eventKey}:outcome`, outcome, evidenceIds: [] },
    });
  }
  offeredAssets.delete(eventKey);
}

async function openSession(sessionId) {
  if (sessions.has(sessionId)) return sessions.get(sessionId);
  await claimSession(sessionId);
  try {
    const opened = await memmy("/api/v1/sessions/open", {
      method: "POST",
      body: { source: SOURCE, adapterId: ADAPTER_ID, requestId: sessionKey(sessionId), sessionKey: sessionId },
    });
    sessions.set(sessionId, opened.sessionId);
    return opened.sessionId;
  } catch (error) {
    await safeReleaseClaim(sessionId);
    throw error;
  }
}

async function safeReleaseClaim(sessionId) {
  try { await releaseClaim(sessionId); } catch (error) { console.error("[memmy-agent-plugin] claim release failed (queued):", String(error)); }
}

async function closeSession(sessionId) {
  const sid = sessions.get(sessionId);
  if (!sid) {
    await safeReleaseClaim(sessionId);
    return;
  }
  sessions.delete(sessionId);
  try {
    await memmy(`/api/v1/sessions/${sid}/close`, {
      method: "POST",
      body: { source: SOURCE, adapterId: ADAPTER_ID, requestId: sessionKey(sessionId) },
    });
  } catch (error) {
    console.error("[memmy-agent-plugin] session close failed (queued):", String(error));
  } finally {
    await safeReleaseClaim(sessionId);
  }
}
  return {
    runtimeConfig,
    sessions,
    trackBackground,
    waitForBackgroundTasks,
    savePendingTurn,
    recoverPendingTurns,
    flushRetries,
    heartbeatClaim,
    openSession,
    closeSession,
    recallAssets,
    recordAssetOutcomes,
    memmy,
    withCompletionLock,
  };
}


// ── turn content extraction ─────────────────────────────────────────────────
function blockText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === "object" && b.type === "text" && typeof b.text === "string" ? b.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

// Extract the real query/answer/tool activity for a turn from the DSH session
// event log. `user/message` events carry no turn number, so we track the
// current turn from `turn/start` boundaries; only direct human prompts
// (source.kind === "user") count as the query, excluding synthetic injections
// (plugin recall, agent.inject context, skill content).
function extractTurn(agent, turn) {
  const events = agent?.session?.events ?? [];
  let query = "";
  let answer = "";
  const tools = new Map();
  let currentTurn = -1;
  for (const ev of events) {
    const type = ev?.type;
    const data = ev?.data;
    if (type === "turn/start" && typeof data?.turn === "number") { currentTurn = data.turn; continue; }
    if (type === "user/message") {
      if (data?.source?.kind === "user" && (currentTurn === turn || currentTurn === -1)) query = blockText(data.content) || query;
      continue;
    }
    if (type === "assistant/message" && data?.turn === turn) {
      const text = blockText(data?.message?.content);
      if (text) answer = answer ? `${answer}\n${text}` : text;
      continue;
    }
    if (type === "tool/call" && data?.turn === turn && typeof data?.name === "string") {
      const id = data.callId ?? data.id ?? `tool-${data.seq ?? tools.size}`;
      tools.set(id, { id, name: data.name, input: data.arguments ?? data.input, startedAt: data.at });
      continue;
    }
    if (type === "tool/result" && data?.turn === turn) {
      const message = data.message;
      const id = data.callId ?? data.id ?? message?.callId;
      if (!id) continue;
      const output = data.result ?? data.output ?? blockText(message?.content);
      const error = data.error ?? (message?.isError ? blockText(message?.content) : undefined);
      const call = tools.get(id) ?? { id, name: data.name ?? "unknown" };
      tools.set(id, { ...call, output, error, success: data.success ?? !error, endedAt: data.at });
    }
  }
  return { query: query.trim(), answer: answer.trim(), tools: [...tools.values()] };
}

function currentInitiator(ctx) {
  try { return ctx.agents.currentInitiator(); } catch { return undefined; }
}

function currentAgent(ctx, candidate, activeAgents) {
  if (candidate) return candidate;
  const initiator = currentInitiator(ctx);
  if (initiator) return initiator;
  if (activeAgents.size === 1) return activeAgents.values().next().value;
  return undefined;
}

export function apply(ctx, config) {
  const activeAgents = new Map();
  const runtime = createRuntime(config ?? {});
  const {
    runtimeConfig, sessions, trackBackground, waitForBackgroundTasks, savePendingTurn,
    recoverPendingTurns, flushRetries, heartbeatClaim, openSession, closeSession,
    recallAssets, recordAssetOutcomes, memmy, withCompletionLock,
  } = runtime;
  if (!runtimeConfig.token) {
    console.error("[memmy-agent-plugin] no token configured (set config.token or MEMMY_TOKEN); plugin disabled");
    return () => {};
  }
  trackBackground(recoverPendingTurns());
  trackBackground(flushRetries());
  const retryTimer = setInterval(() => {
    trackBackground(flushRetries());
    trackBackground(recoverPendingTurns());
  }, RETRY_FLUSH_MS);
  retryTimer.unref?.();
  const safeRecall = async (fn) => {
    try { return await fn(); } catch (error) { return undefined; }
  };
  const heartbeatTimer = setInterval(() => {
    for (const sessionId of sessions.keys()) trackBackground(safeRecall(() => heartbeatClaim(sessionId)));
  }, HEARTBEAT_MS);
  heartbeatTimer.unref?.();

  // session boot: open + claim
  ctx.on("agent/created", async ({ agent }) => {
    const sessionId = agent?.session?.id ?? agent?.id;
    if (!sessionId) return;
    activeAgents.set(sessionId, agent);
    await safeRecall(() => openSession(sessionId));
  });

  ctx.on("agent/pre-step", async (payload, next) => {
    const agent = currentAgent(ctx, payload.agent, activeAgents);
    const decision = await next();
    if (!decision || decision.kind !== "enter") return decision;
    if (!agent) return decision;
    const sessionId = agent.session?.id ?? agent.id;
    if (!sessionId) return decision;
    try {
      await heartbeatClaim(sessionId);
      const sid = await openSession(sessionId);
      const lastUser = [...(payload.messages ?? [])].reverse().find((m) => m && m.role === "user");
      const query = blockText(lastUser?.content).trim();
      await safeRecall(() => recallAssets(sessionId, payload.turn, query));
      if (!query) return decision;
      const recall = await memmy("/api/v1/turns/start", {
        method: "POST",
        body: { sessionId: sid, query, turnId: turnKey(sessionId, payload.turn), requestId: turnKey(sessionId, payload.turn), adapterId: ADAPTER_ID },
      });
      await savePendingTurn(turnKey(sessionId, payload.turn), {
        sessionId: sid,
        query,
        requestId: `${turnKey(sessionId, payload.turn)}:complete`,
        adapterId: ADAPTER_ID,
      });
      const injected = recall?.injectedContext ?? "";
      if (!injected) return decision;
      return {
        kind: "enter",
        messages: [
          { role: "user", content: [{ type: "text", text: `[memmy recall]\n${typeof injected === "string" ? injected : JSON.stringify(injected)}\n\n` }] },
          ...(decision.messages ?? []),
        ],
      };
    } catch (error) {
      console.error("[memmy-agent-plugin] pre-step recall degraded:", String(error));
      return decision;
    }
  });

  // turn stopping: write the turn back with the real query/answer.
  ctx.on("agent/turn-stopping", async (payload) => {
    const { turn } = payload;
    const agent = currentAgent(ctx, payload.agent, activeAgents);
    const sessionId = agent?.session?.id ?? agent?.id;
    if (!sessionId) return;
    try {
      await withCompletionLock(turnKey(sessionId, turn), async () => {
        await heartbeatClaim(sessionId);
        const { query, answer, tools } = extractTurn(agent, turn);
        await safeRecall(() => recordAssetOutcomes(sessionId, turn, tools));
        if (!query && !answer) return;
        const sid = await openSession(sessionId);
        const answerText = answer || (tools.length ? `[tool calls: ${tools.map((tool) => tool.name).join(", ")}]` : "");
        const completion = {
          sessionId: sid,
          query,
          answer: answerText,
          toolCalls: tools.map((tool) => ({ id: tool.id, name: tool.name, input: tool.input, startedAt: tool.startedAt })),
          toolResults: tools.filter((tool) => tool.output !== undefined || tool.error).map((tool) => ({ id: tool.id, output: tool.output, error: tool.error, success: tool.success, endedAt: tool.endedAt })),
          requestId: `${turnKey(sessionId, turn)}:complete`,
          adapterId: ADAPTER_ID,
        };
        await savePendingTurn(turnKey(sessionId, turn), completion);
        await memmy(`/api/v1/turns/${encodeURIComponent(turnKey(sessionId, turn))}/complete`, {
          method: "POST",
          body: completion,
          queueOnFailure: false,
        });
        await savePendingTurn(turnKey(sessionId, turn), undefined);
      });
    } catch (error) {
      console.error("[memmy-agent-plugin] turn write-back degraded:", String(error));
    }
  });

  // session close
  ctx.on("agent/disposed", async ({ agent }) => {
    const sessionId = agent?.session?.id ?? agent?.id;
    if (!sessionId) return;
    activeAgents.delete(sessionId);
    await closeSession(sessionId);
  });

  return async () => {
    clearInterval(retryTimer);
    clearInterval(heartbeatTimer);
    await waitForBackgroundTasks();
    for (const sessionId of [...sessions.keys()]) await closeSession(sessionId);
    await waitForBackgroundTasks();
    sessions.clear();
    activeAgents.clear();
  };
}

export default { apply, name: "memmy-agent-plugin" };
