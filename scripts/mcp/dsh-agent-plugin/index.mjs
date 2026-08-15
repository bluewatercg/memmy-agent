// Memmy agent-plane plugin for DeepSeek Harness.
// Mounted as an agent preset (agent.cordis.yml row). Runs inside the DSH
// process with the agent scope context as `ctx`. Registers:
//   - agent/pre-step (waterfall): inject memmy recall into step messages
//   - agent/turn-stopping (serial): write the turn back to memmy
//   - agent/created: open a memmy session + claim
// Design: docs/superpowers/plans/2026-08-15-dsh-realtime-memory-integration-design.md §8 Phase 2
//
// Env:
//   MEMMY_URL     memmy base URL (default http://127.0.0.1:18960)
//   MEMMY_TOKEN   memmy token (required)
//   MEMMY_WORKSPACE_PATH workspace path header (default process.cwd())

const MEMMY_URL = (process.env.MEMMY_URL ?? "http://127.0.0.1:18960").replace(/\/$/, "");
const TOKEN = process.env.MEMMY_TOKEN ?? process.env.MEMMY_MEMORY_TOKEN ?? "";
const WORKSPACE_PATH = process.env.MEMMY_WORKSPACE_PATH ?? process.cwd();
const SOURCE = "deepseek_harness";
const ADAPTER_ID = "agent-source:deepseek_harness";

// ── helpers ─────────────────────────────────────────────────────────────────
async function memmy(path, { method = "GET", body } = {}) {
  const headers = {
    "x-memmy-user-id": "deepseek-harness",
    "x-memmy-workspace-path": WORKSPACE_PATH,
    "authorization": `Bearer ${TOKEN}`,
  };
  let payload;
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${MEMMY_URL}${path}?source=${SOURCE}`, { method, headers, body: payload });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`memmy ${path} -> ${res.status}: ${json?.error?.message ?? text}`);
  return json;
}

function sessionKey(sessionId) { return `${SOURCE}:${sessionId}`; }
function turnKey(sessionId, turn) { return `${sessionKey(sessionId)}:turn:${turn}`; }

const sessions = new Map(); // sessionId -> memmy sessionId

async function openSession(sessionId) {
  if (sessions.has(sessionId)) return sessions.get(sessionId);
  const opened = await memmy("/api/v1/sessions/open", {
    method: "POST",
    body: { source: SOURCE, adapterId: ADAPTER_ID, requestId: sessionKey(sessionId), sessionKey: sessionId },
  });
  sessions.set(sessionId, opened.sessionId);
  return opened.sessionId;
}

async function closeSession(sessionId) {
  const sid = sessions.get(sessionId);
  if (!sid) return;
  sessions.delete(sessionId);
  try {
    await memmy(`/api/v1/sessions/${sid}/close`, {
      method: "POST",
      body: { source: SOURCE, adapterId: ADAPTER_ID, requestId: sessionKey(sessionId) },
    });
  } catch (error) {
    console.error("[memmy-agent-plugin] session close failed (queued):", String(error));
  }
}

// ── plugin ───────────────────────────────────────────────────────────────────
export function apply(ctx) {
  // Hot-path safety: never throw into the loop; degrade on memmy failure.
  const safeRecall = async (fn) => {
    try { return await fn(); } catch (error) { return undefined; }
  };

  // session boot: open + claim
  ctx.on("agent/created", async ({ agent }) => {
    const sessionId = agent?.session?.id ?? agent?.id;
    if (!sessionId) return;
    await safeRecall(() => openSession(sessionId));
  });

  // pre-step recall (waterfall): inject memmy recall into entering messages.
  ctx.on("agent/pre-step", async (payload, next) => {
    const decision = await next();
    if (!decision || decision.kind !== "enter" || !payload.agent) return decision;
    const sessionId = payload.agent.session?.id ?? payload.agent.id;
    if (!sessionId) return decision;
    try {
      const sid = await openSession(sessionId);
      const lastUser = [...(payload.messages ?? [])]
        .reverse()
        .find((m) => m && m.role === "user");
      const query = lastUser?.content
        ? (typeof lastUser.content === "string" ? lastUser.content : JSON.stringify(lastUser.content))
        : "";
      if (!query) return decision;
      const recall = await memmy("/api/v1/turns/start", {
        method: "POST",
        body: {
          sessionId: sid,
          query,
          turnId: turnKey(sessionId, payload.turn),
          requestId: turnKey(sessionId, payload.turn),
          adapterId: ADAPTER_ID,
        },
      });
      const injected = recall?.injectedContext ?? "";
      if (!injected) return decision;
      // Prepend a system message carrying the recall into the entering messages.
      return {
        kind: "enter",
        messages: [
          {
            role: "user",
            content: `[memmy recall]\n${typeof injected === "string" ? injected : JSON.stringify(injected)}\n\n`,
          },
          ...(decision.messages ?? []),
        ],
      };
    } catch (error) {
      // Degrade: proceed without recall; never block the step.
      console.error("[memmy-agent-plugin] pre-step recall degraded:", String(error));
      return decision;
    }
  });

  // turn stopping: write the turn back.
  ctx.on("agent/turn-stopping", async ({ agent, turn }) => {
    const sessionId = agent?.session?.id ?? agent?.id;
    if (!sessionId) return;
    try {
      const sid = await openSession(sessionId);
      await memmy(`/api/v1/turns/${encodeURIComponent(turnKey(sessionId, turn))}/complete`, {
        method: "POST",
        body: {
          sessionId: sid,
          query: "",
          answer: "[turn completed by memmy agent plugin]",
          requestId: `${turnKey(sessionId, turn)}:complete`,
          adapterId: ADAPTER_ID,
        },
      });
    } catch (error) {
      console.error("[memmy-agent-plugin] turn write-back degraded:", String(error));
    }
  });

  // session close
  ctx.on("agent/disposed", async ({ agent }) => {
    const sessionId = agent?.session?.id ?? agent?.id;
    if (!sessionId) return;
    await closeSession(sessionId);
  });

  return () => {
    // dispose: close all open sessions (best effort)
    for (const sessionId of [...sessions.keys()]) {
      void closeSession(sessionId);
    }
    sessions.clear();
  };
}

export default { apply, name: "memmy-agent-plugin" };
