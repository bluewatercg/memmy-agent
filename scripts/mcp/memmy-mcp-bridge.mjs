#!/usr/bin/env node
// Memmy Memory MCP bridge — exposes the memmy memory REST service (default
// http://127.0.0.1:18960) as Model Context Protocol tools for DeepSeek
// Harness / Claude / Codex style clients.
//
// Env:
//   MEMMY_URL    memmy memory service base URL (default http://127.0.0.1:18960)
//   MEMMY_TOKEN  memmy memory service token (default from MEMMY_MEMORY_TOKEN)
//   MEMMY_USER_ID   x-memmy-user-id header (default "deepseek-harness")
//   MEMMY_PROJECT_ID x-memmy-project-id header (default undefined)
//
// Run: node scripts/mcp/memmy-mcp-bridge.mjs
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE_URL = (process.env.MEMMY_URL ?? "http://127.0.0.1:18960").replace(/\/$/, "");
const TOKEN = process.env.MEMMY_TOKEN ?? process.env.MEMMY_MEMORY_TOKEN ?? "";
const USER_ID = process.env.MEMMY_USER_ID ?? "deepseek-harness";
const PROJECT_ID = process.env.MEMMY_PROJECT_ID ?? undefined;
const SOURCE = process.env.MEMMY_SOURCE ?? "deepseek-harness";
const WORKSPACE_PATH = process.env.MEMMY_WORKSPACE_PATH ?? process.cwd();

if (!TOKEN) {
  console.error("memmy-mcp-bridge: MEMMY_TOKEN/MEMMY_MEMORY_TOKEN is required");
  process.exit(1);
}

async function call(path, { method = "GET", body } = {}) {
  const headers = {
    "x-memmy-user-id": USER_ID,
    "x-memmy-workspace-path": WORKSPACE_PATH,
    ...(PROJECT_ID ? { "x-memmy-project-id": PROJECT_ID } : {}),
  };
  if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
  let payload;
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const separator = path.includes("?") ? "&" : "?";
  const res = await fetch(`${BASE_URL}${path}${separator}source=${encodeURIComponent(SOURCE)}`, { method, headers, body: payload });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  if (!res.ok) {
    throw new Error(`memmy ${method} ${path} -> ${res.status}: ${json?.error?.message ?? text}`);
  }
  return json;
}

// A shared session carries the workspace scope (x-memmy-workspace-path)
// into stored memories: memory rows inherit app_id (workspace id) and
// session_id from the session they are written under. Opened lazily and
// reused across calls; closed on exit.
let sharedSessionId;

async function ensureSession() {
  if (sharedSessionId) return sharedSessionId;
  const opened = await call("/api/v1/sessions/open", {
    method: "POST",
    body: { source: SOURCE },
  });
  sharedSessionId = opened.sessionId;
  return sharedSessionId;
}

const server = new McpServer({
  name: "memmy-memory",
  version: "1.0.0",
});

server.tool(
  "memmy_health",
  "Check memmy memory service health and schema version",
  {},
  async () => {
    const h = await call("/api/v1/health");
    return {
      content: [{ type: "text", text: JSON.stringify({
        ok: h.ok,
        version: h.version,
        schemaVersion: h.storage?.schemaVersion,
        lastMigration: h.storage?.lastMigrationId,
        backend: h.storage?.backendId,
      }, null, 2) }],
    };
  },
);

server.tool(
  "memmy_search",
  "Search the memmy memory store. Returns matching memories with their layer, title, content and provenance.",
  {
    query: z.string().describe("Search query text"),
    limit: z.number().int().min(1).max(50).optional().describe("Max results (default 10)"),
    layers: z.array(z.enum(["L1", "L2", "L3", "Skill"])).optional().describe("Filter by memory layer"),
    sessionId: z.string().optional(),
    includeInjectedContext: z.boolean().optional().describe("Include injected context summary"),
  },
  async ({ query, limit, layers, sessionId, includeInjectedContext }) => {
    const result = await call("/api/v1/memory/search", {
      method: "POST",
      body: {
        query,
        ...(limit ? { limit } : {}),
        ...(layers ? { layers } : {}),
        ...(sessionId ? { sessionId } : {}),
        ...(includeInjectedContext !== undefined ? { includeInjectedContext } : {}),
      },
    });
    const items = result.results ?? result.memories ?? [];
    const text = items.length === 0
      ? "No matching memories."
      : items.map((m, i) => {
          const layer = m.memoryLayer ?? m.layer ?? "?";
          const title = m.title ?? m.memoryKey ?? m.id ?? "(untitled)";
          const content = m.memoryValue ?? m.content ?? "";
          return `[${i + 1}] (${layer}) ${title}\n${content}`;
        }).join("\n\n");
    return { content: [{ type: "text", text }] };
  },
);

server.tool(
  "memmy_add",
  "Add a memory to the memmy memory store",
  {
    content: z.string().describe("The memory content to store"),
    title: z.string().optional(),
    layer: z.enum(["L1", "L2", "L3", "Skill"]).optional().describe("Memory layer (default L1)"),
    tags: z.array(z.string()).optional(),
    sessionId: z.string().optional(),
    deferProcessing: z.boolean().optional().describe("Skip async evolution processing"),
  },
  async ({ content, title, layer, tags, sessionId, deferProcessing }) => {
    const effectiveSessionId = sessionId ?? (await ensureSession());
    const result = await call("/api/v1/memory/add", {
      method: "POST",
      body: {
        content,
        source: SOURCE,
        sessionId: effectiveSessionId,
        ...(title ? { title } : {}),
        ...(layer ? { layer } : {}),
        ...(tags ? { tags } : {}),
        ...(deferProcessing !== undefined ? { deferProcessing } : {}),
      },
    });
    const id = result.memory?.id ?? result.id ?? result.memoryId;
    return {
      content: [{ type: "text", text: `Memory stored: ${id ?? JSON.stringify(result)}` }],
    };
  },
);

server.tool(
  "memmy_status",
  "Show memmy memory store panel overview (counts per layer, activity)",
  {},
  async () => {
    const s = await call("/api/v1/panel/overview");
    return { content: [{ type: "text", text: JSON.stringify(s, null, 2) }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
