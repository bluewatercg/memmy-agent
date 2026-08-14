import { Script, createContext, type Context } from "node:vm";
import { describe, expect, it } from "vitest";
import { memoryPanelHtml } from "../src/viewer/static.js";

describe("memoryPanelHtml", () => {
  it("uses an inline favicon so the protected server does not receive browser favicon requests", () => {
    expect(memoryPanelHtml()).toContain('<link rel="icon" href="data:,">');
  });

  it("offers a Markdown download for the generated context pack", () => {
    const html = memoryPanelHtml();
    expect(html).toContain('id="exportContextPack"');
    expect(html).toContain('link.download = "memmy-context-pack-" + name + ".md"');
  });
  it("exposes the action-first decision console surface", () => {
    const html = memoryPanelHtml();
    expect(html).toContain('id="topicDecisionDetail"');
    expect(html).toContain("Start analysis");
    expect(html).toContain("Agent roster");
    expect(html).toContain("Decision summary");
    expect(html).toContain("Approve proposal");
    expect(html).toContain("Missing information");
    expect(html).toContain("Awaiting confirmation");
    expect(html.indexOf("Decision summary")).toBeLessThan(html.indexOf("Debate details"));
  });

  it("reveals the decision detail after analysis starts", () => {
    const html = memoryPanelHtml();
    expect(html).toContain('$("topicDecisionDetail").classList.remove("hidden")');
  });

  it("runs the full topic decision pipeline using refreshed session versions", () => {
    const html = memoryPanelHtml();
    expect(html).toContain("async function runTopicDecisionPipeline(sessionId, namespace, requestPrefix)");
    expect(html).toContain('await topicDecisionMutationStep(sessionId, "run", detail.session.version');
    expect(html).toContain('detail = await readTopicDecisionDetail(sessionId, namespace)');
    expect(html).toContain('await topicDecisionMutationStep(sessionId, "debate", detail.session.version');
    expect(html).toContain('await topicDecisionMutationStep(sessionId, "proposals", detail.session.version');
    expect(html).toContain("runTopicDecisionPipeline(started.session.id, namespace, requestPrefix)");
  });

  it("shows progress and stops automatic analysis on blocked decision states", () => {
    const html = memoryPanelHtml();
    expect(html).toContain("Analyzing topic");
    expect(html).toContain("Gathering positions");
    expect(html).toContain("Running debate");
    expect(html).toContain("Generating proposals");
    expect(html).toContain('const topicDecisionStopStates = new Set(["gathering_evidence", "awaiting_user_input", "blocked_by_evidence", "blocked", "executing", "completed", "stale", "failed", "cancelled"])');
  });

  it.each(["blocked_by_evidence", "completed", "executing"])("does not mutate a reusable %s decision session", async (state) => {
    const harness = createViewerHarness();
    const context = runViewerScript(harness) as Record<string, unknown> & {
      runTopicDecisionPipeline: (sessionId: string, namespace: object, requestPrefix: string) => Promise<DecisionDetailFixture>;
      readTopicDecisionDetail: () => Promise<DecisionDetailFixture>;
      topicDecisionMutationStep: () => Promise<void>;
    };
    let mutations = 0;
    context.readTopicDecisionDetail = async () => ({ session: { state, version: 4 } });
    context.topicDecisionMutationStep = async () => { mutations += 1; };

    const detail = await context.runTopicDecisionPipeline("session-1", {}, "request-1");

    expect(detail.session.state).toBe(state);
    expect(mutations).toBe(0);
  });

  it.each([
    { detail: { session: { state: "ready_for_decision", version: 4 }, snapshots: [], positions: [], debateRounds: [], proposals: [{ id: "proposal-1" }] }, expectedActions: [] },
    { detail: { session: { state: "ready_for_decision", version: 4 }, snapshots: [], positions: [], debateRounds: [{ id: "round-1" }], proposals: [] }, expectedActions: ["proposals"] },
    { detail: { session: { state: "ready_for_decision", version: 4 }, snapshots: [], positions: [], debateRounds: [], proposals: [] }, expectedActions: ["debate", "proposals"] },
    { detail: { session: { state: "draft", version: 4 }, snapshots: [{ id: "snapshot-1", payload: { roster: [{ id: "agent-1" }] } }], positions: [{ agentId: "agent-1", snapshotId: "snapshot-1" }], debateRounds: [], proposals: [] }, expectedActions: ["run", "debate", "proposals"] },
    { detail: { session: { state: "debating", version: 4 }, snapshots: [], positions: [], debateRounds: [{ id: "round-1" }], proposals: [] }, expectedActions: ["debate", "proposals"] }
  ])("resumes a reusable session from its authoritative state", async ({ detail, expectedActions }) => {
    const harness = createViewerHarness();
    const context = runViewerScript(harness) as Record<string, unknown> & {
      runTopicDecisionPipeline: (sessionId: string, namespace: object, requestPrefix: string) => Promise<DecisionDetailFixture>;
      readTopicDecisionDetail: () => Promise<DecisionDetailFixture>;
      topicDecisionMutationStep: (_sessionId: string, action: string) => Promise<void>;
    };
    const actions: string[] = [];
    context.readTopicDecisionDetail = async () => detail;
    context.topicDecisionMutationStep = async (_sessionId, action) => {
      actions.push(action);
      if (action === "run") detail.session.state = "ready_for_decision";
      if (action === "debate") {
        detail.session.state = "ready_for_decision";
        detail.debateRounds = [{ id: "round-complete" }];
      }
    };

    await context.runTopicDecisionPipeline("session-1", {}, "request-1");

    expect(actions).toEqual(expectedActions);
  });

  it("disables the initiating analysis control and renders failures until the request settles", async () => {
    const harness = createViewerHarness();
    const context = runViewerScript(harness) as Record<string, unknown> & {
      openTopicDecision: (topicId: string, button: FakeElement) => Promise<void>;
      api: () => Promise<never>;
      selectedTopicNamespace: () => object;
    };
    let rejectStart!: (error: Error) => void;
    context.selectedTopicNamespace = () => ({});
    context.api = () => new Promise<never>((_resolve, reject) => { rejectStart = reject; });
    const button = new FakeElement();

    const analysis = context.openTopicDecision("topic-1", button);
    expect(button.disabled).toBe(true);
    rejectStart(new Error("model unavailable"));
    await expect(analysis).rejects.toThrow("model unavailable");
    expect(button.disabled).toBe(false);
    expect(harness.element("topicDecisionBody").innerHTML).toContain("Analysis failed");
  });

  it("renders a failure when stale-version recovery cannot reload the session", async () => {
    const harness = createViewerHarness();
    const context = runViewerScript(harness) as Record<string, unknown> & {
      openTopicDecision: (topicId: string, button: FakeElement) => Promise<void>;
      api: () => Promise<{ session: { id: string } }>;
      readTopicDecisionDetail: () => Promise<never>;
      runTopicDecisionPipeline: () => Promise<never>;
      selectedTopicNamespace: () => object;
    };
    context.selectedTopicNamespace = () => ({});
    context.api = async () => ({ session: { id: "session-1" } });
    let reads = 0;
    context.readTopicDecisionDetail = async () => {
      reads += 1;
      if (reads === 1) return { session: { state: "draft", version: 1 } } as never;
      throw new Error("reload unavailable");
    };
    context.runTopicDecisionPipeline = async () => { throw Object.assign(new Error("stale"), { status: 409 }); };

    await expect(context.openTopicDecision("topic-1", new FakeElement())).rejects.toThrow("reload unavailable");
    expect(harness.element("topicDecisionBody").innerHTML).toContain("Analysis failed");
  });

  it("keeps topic cards linked to a full-width decision surface", () => {
    const html = memoryPanelHtml();
    expect(html).toContain('data-topic-action="decision"');
    expect(html).toContain('id="topicDecisionSummary"');
    expect(html).toContain('id="topicDecisionProposals"');
  });

  it("renders the decision surface before any production implementation exists", () => {
    expect(memoryPanelHtml()).toContain("Approve proposal");
  });


  it("strips generated Summary prefixes from displayed memory titles", async () => {
    const harness = createViewerHarness();
    runViewerScript(harness);
    await flushPromises();

    expect(harness.rowHtml()).toContain('<div class="memory-title">First memory</div>');
    expect(harness.rowHtml()).toContain('<div class="memory-title">Second memory</div>');
    expect(harness.rowHtml()).not.toContain('<div class="memory-title">Summary:');
  });

  it("shows layer counts in the memory layer filter", async () => {
    const harness = createViewerHarness();
    runViewerScript(harness);
    await flushPromises();

    const layerHtml = harness.element("layer").innerHTML;
    expect(layerHtml).toContain("L1 (1,297)");
    expect(layerHtml).toContain("L2 (2)");
  });

  it("shows only the selected workspace context pack", async () => {
    const harness = createViewerHarness();
    runViewerScript(harness);
    await flushPromises();

    harness.element("contextPackScope").value = "workspace:workspace_1";
    const change = harness.element("contextPackScope").onchange as () => void;
    change();

    expect(harness.element("contextPackMarkdown").textContent).toBe("# Project Memory Pack: demo");
    expect(harness.element("contextPackMarkdown").textContent).not.toContain("other");
  });

  it("keeps the right JSON panel on the latest clicked memory detail", async () => {
    const harness = createViewerHarness();
    runViewerScript(harness);
    await flushPromises();

    const rows = harness.rows();
    expect(rows).toHaveLength(2);
    const firstRow = rows[0];
    const secondRow = rows[1];
    if (!firstRow || !secondRow) {
      throw new Error("expected two rendered memory rows");
    }
    const firstClick = firstRow.onclick();
    const secondClick = secondRow.onclick();

    harness.resolveDetail("memory-2", {
      item: { id: "memory-2", title: "Summary: Second memory", metadata: { source: "second" } }
    });
    await secondClick;

    expect(harness.element("detailId").textContent).toBe("memory-2");
    expect(harness.element("detailTitle").textContent).toBe("Second memory");
    expect(harness.element("detailJson").textContent).toContain('"source": "second"');

    harness.resolveDetail("memory-1", {
      item: { id: "memory-1", title: "First memory", metadata: { source: "first" } }
    });
    await firstClick;

    expect(harness.element("detailId").textContent).toBe("memory-2");
    expect(harness.element("detailJson").textContent).toContain('"source": "second"');
    expect(harness.element("detailJson").textContent).not.toContain('"source": "first"');
  });

  it("uses a fragment token for API requests without leaving it in the address bar", async () => {
    const harness = createViewerHarness();
    const stored = new Map<string, string>();
    let replacedUrl = "";
    runViewerScript(harness, {
      window: {
        location: {
          hash: "#token=panel-token",
          pathname: "/",
          search: ""
        }
      },
      sessionStorage: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => stored.set(key, value)
      },
      history: {
        replaceState: (_state: unknown, _title: string, url: string) => {
          replacedUrl = url;
        }
      }
    });
    await flushPromises();

    expect(stored.get("memmyMemoryToken")).toBe("panel-token");
    expect(replacedUrl).toBe("/");
    expect(harness.requests()).not.toHaveLength(0);
    expect(harness.requests().every((request) => request.authorization === "Bearer panel-token")).toBe(true);
    expect(harness.requests().every((request) => !request.path.includes("panel-token"))).toBe(true);
  });

  it("validates a manually entered token against a protected panel endpoint", async () => {
    const harness = createViewerHarness();
    runViewerScript(harness, {
      sessionStorage: {
        getItem: () => null,
        setItem: () => undefined,
        removeItem: () => undefined
      }
    });

    harness.element("tokenInput").value = "manual-panel-token";
    const connect = harness.element("connectToken").onclick as () => Promise<void>;
    await connect();
    await flushPromises();

    expect(harness.requests()[0]).toEqual({
      path: "/api/v1/panel/status",
      authorization: "Bearer manual-panel-token"
    });
  });
  it("loads a project topic inbox with a strict runtime namespace", async () => {
    const harness = createViewerHarness();
    runViewerScript(harness);
    await flushPromises();

    harness.element("topicInboxProject").value = "workspace:workspace_1";
    const changeProject = harness.element("topicInboxProject").onchange as () => void;
    changeProject();
    await flushPromises();


    const request = harness.requests().find(({ path }) => path.startsWith("/api/v1/topic-inbox?"));
    expect(request).toBeDefined();
    const url = new URL(request!.path, "http://localhost");
    expect(JSON.parse(url.searchParams.get("namespace") ?? "null")).toEqual({
      tenantId: "local",
      projectId: "demo",
      workspaceId: "workspace_1",
      workspacePath: "/tmp/demo",
      source: "unknown",
      profileId: "default"
    });
  });
});
interface DecisionDetailFixture {
  session: { state: string; version: number };
  snapshots?: Array<{ id: string; payload: { roster: Array<{ id: string }> } }>;
  positions?: Array<{ agentId: string; snapshotId: string }>;
  debateRounds?: Array<{ id: string }>;
  proposals?: Array<{ id: string }>;
}

type FakeRow = FakeElement & {
  dataset: { id: string };
  onclick: () => Promise<void>;
};

type DetailResolver = (body: unknown) => void;

interface ViewerHarnessRuntime {
  document: object;
  fetch: (path: string, options?: { headers?: Record<string, string> }) => Promise<unknown>;
}

function runViewerScript(
  harness: ViewerHarnessRuntime,
  browserContext: Record<string, unknown> = {}
): Context {
  const match = memoryPanelHtml().match(/<script>([\s\S]*)<\/script>/);
  const script = match?.[1];
  if (!script) {
    throw new Error("viewer script not found");
  }

  const context = createContext({
    document: harness.document,
    fetch: harness.fetch,
    navigator: { clipboard: { writeText: async () => undefined } },
    sessionStorage: {
      getItem: () => "viewer-test-token",
      setItem: () => undefined,
      removeItem: () => undefined
    },
    setTimeout: (callback: () => void) => {
      callback();
      return 0;
    },
    clearTimeout: () => undefined,
    URLSearchParams,
    ...browserContext
  });
  new Script(script).runInContext(context);
  return context;
}

function createViewerHarness() {
  const elements = new Map<string, FakeElement>();
  const detailResolvers = new Map<string, DetailResolver>();
  const requests: Array<{ path: string; authorization?: string }> = [];
  const ids = [
    "navDashboard",
    "navTopicInbox",
    "navMemories",
    "navActivity",
    "navTasks",
    "navTokenStats",
    "navAudit",
    "navSystem",
    "viewDashboard",
    "viewTopicInbox",
    "viewMemories",
    "viewActivity",
    "viewTasks",
    "viewTokenStats",
    "viewAudit",
    "viewSystem",
    "pageTitle",
    "pageSubtitle",
    "themeToggle",
    "lockConsole",
    "sidebarStatusDot",
    "sidebarStatusText",
    "sidebarVersion",
    "errorMessage",
    "stats",
    "analysisMetrics",
    "activityChart",
    "activityCaption",
    "activityTotal",
    "sourceDistribution",
    "sourceTotal",
    "namespaceDistribution",
    "namespaceTotal",
    "queueSummary",
    "queueState",
    "recentActivity",
    "openActivity",
    "evolutionPipeline",
    "l2ResolvingReason",
    "evolutionJobState",
    "contextPackMarkdown",
    "contextPackOutline",
    "contextPackGraph",
    "contextPackOutlineTab",
    "contextPackGraphTab",
    "contextPackMarkdownTab",
    "contextPackScope",
    "copyContextPack",
    "exportContextPack",
    "contextMemoryDialog",
    "contextMemoryDialogTitle",
    "contextMemoryDialogId",
    "closeContextMemoryDialog",
    "contextMemoryDetail",
    "contextMemoryEditForm",
    "contextMemoryTitle",
    "contextMemoryTags",
    "contextMemoryBody",
    "cancelContextMemoryEdit",
    "saveContextMemory",
    "contextMemoryDetailActions",
    "editContextMemory",
    "isolationAudit",
    "auditRiskState",
    "auditIssueCount",
    "auditRows",
    "auditEmpty",
    "auditPacks",
    "copyAuditPacks",
    "query",
    "layer",
    "status",
    "topicInboxProject",
    "refreshTopicInbox",
    "topicInboxSummary",
    "topicInboxList",
    "topicDecisionDetail",
    "topicDecisionTitle",
    "topicDecisionMeta",
    "topicDecisionBody",
    "closeTopicDecision",
    "sourceAgent",
    "projectScope",
    "memoryRows",
    "emptyState",
    "listMeta",
    "memoryResultSummary",
    "pageInput",
    "totalPagesText",
    "prevPage",
    "nextPage",
    "detailTitle",
    "detailId",
    "detailContent",
    "detailJson",
    "deleteMemory",
    "markUseful",
    "markNotUseful",
    "mergeMemory",
    "promoteMemory",
    "archiveMemory",
    "activityQuery",
    "activityTool",
    "activitySource",
    "activityRows",
    "activityEmpty",
    "activityMeta",
    "activityDetailTitle",
    "activityDetailId",
    "activityDetailJson",
    "loadActivity",
    "clearActivity",
    "copyActivity",
    "taskQuery",
    "searchTasks",
    "clearTasks",
    "taskRows",
    "taskEmpty",
    "taskMeta",
    "taskResultSummary",
    "taskPageText",
    "prevTaskPage",
    "nextTaskPage",
    "taskDetailTitle",
    "taskDetailId",
    "taskDetailContent",
    "taskDetailJson",
    "tokenStatsProject",
    "tokenStatsLegend",
    "tokenStatsChart",
    "tokenStatsAgents",
    "tokenStatsCombined",
    "tokenStatsScannedAt",
    "copyTask",
    "deleteTask",
    "systemHealthBadge",
    "systemHealth",
    "systemSchema",
    "systemStorage",
    "systemModels",
    "systemQueues",
    "configJson",
    "runWorker",
    "retryFailed",
    "promoteCandidates",
    "reloadConfig",
    "copyConfig",
    "authScreen",
    "tokenInput",
    "authError",
    "connectToken",
    "toast",
    "refresh",
    "search",
    "clearFilters",
    "copyJson"
    ,"reviewHeading"
    ,"reviewCount"
    ,"topicDecisionDetail"
    ,"topicDecisionTitle"
    ,"topicDecisionMeta"
    ,"topicDecisionBody"
    ,"closeTopicDecision"
    ,"reviewCandidates"
    ,"bulkApproveCandidates"
    ,"evolutionPipeline"
    ,"l2ResolvingReason"
    ,"evolutionJobState"
    ,"contextPackMarkdown"
    ,"auditPacks"
    ,"auditRiskState"
    ,"isolationAudit"
    ,"auditIssueCount"
    ,"auditEmpty"
    ,"auditRows"
  ];

  for (const id of ids) {
    elements.set(id, new FakeElement());
  }
  elements.get("pageInput")!.value = "1";

  const memoryRows = elements.get("memoryRows")!;
  Object.defineProperty(memoryRows, "innerHTML", {
    get() {
      return this.html;
    },
    set(value: string) {
      this.html = value;
      this.childRows = [...value.matchAll(/<tr data-id="([^"]+)"/g)].map((match) => {
        const encodedId = match[1];
        if (!encodedId) {
          throw new Error("memory row id not found");
        }
        const row = new FakeElement() as FakeRow;
        row.dataset = { id: decodeHtml(encodedId) };
        row.onclick = async () => undefined;
        return row;
      });
    }
  });

  const fetch = async (path: string, options: { headers?: Record<string, string> } = {}) => {
    requests.push({ path, authorization: options.headers?.authorization });
    if (path === "/api/v1/panel/overview") {
      return jsonResponse({
        counts: { memories: 2, experiences: 0, worldModels: 0, skills: 0 },
        layerCounts: { L1: 1297, L2: 2, L3: 0, Skill: 0 },
        sourceDistribution: [{ source: "codex", count: 2, percentage: 100 }],
        namespaceDistribution: [{ tenantId: "local", projectId: "demo", workspaceId: "workspace_1", workspacePath: "/tmp/demo", label: "demo", count: 2, percentage: 100 }],
        dailyActivity: []
      });
    }
    if (path === "/api/v1/panel/analysis") {
      return jsonResponse({ metrics: { avgRecallScore: 0.8, recallEvents: 2, activeSkills: 0, recentlyUsedSkills: 0, avgToolLatencyMs: 12, p95ToolLatencyMs: 20 }, dailyMemoryWrites: [], dailySkillEvolutions: [], toolLatency: { tools: [], series: [] } });
    }
    if (path === "/api/v1/panel/metrics") {
      return jsonResponse({ storage: { backend: "sqlite" }, schema: { version: 1 }, changeSeq: 1, feedback: { recent: 0 }, jobs: { queued: 0, leased: 0, succeeded: 0, failed: 0, dead_letter: 0 }, embeddingRetries: { pending: 0, in_progress: 0, succeeded: 0, failed: 0 }, models: {} });
    }
    if (path === "/api/v1/panel/status") {
      return jsonResponse({ health: { ok: true, version: "1.0.4", mode: "dev", activeProfile: "byok", uptimeMs: 10, storage: { backend: "sqlite" } }, serverTime: new Date().toISOString() });
    }
    if (path === "/api/v1/agent-token-stats") {
      return jsonResponse({ projects: [], monthly: [], scannedAt: new Date().toISOString() });
    }
    if (path === "/api/v1/panel/activity?limit=20") {
      return jsonResponse({ entries: [] });
    }
    if (path === "/api/v1/panel/evolution") {
      return jsonResponse({ layers: [{ layer: "L1", count: 2, candidates: 0, queued: 0, failed: 0 }], l2Resolving: { active: false, count: 0, reason: "没有符合条件的候选" }, recentJobs: [] });
    }
    if (path === "/api/v1/panel/context-packs") {
      return jsonResponse({ packs: [
        { namespace: { tenantId: "local", projectId: "demo", workspaceId: "workspace_1", workspacePath: "/tmp/demo", label: "demo" }, markdown: "# Project Memory Pack: demo" },
        { namespace: { tenantId: "local", projectId: "other", workspaceId: "workspace_2", workspacePath: "/tmp/other", label: "other" }, markdown: "# Project Memory Pack: other" }
      ] });
    }
    if (path.startsWith("/api/v1/topic-inbox?")) {
      return jsonResponse({ projects: [{ namespace: { tenantId: "local", projectId: "demo", workspaceId: "workspace_1" }, projectId: "demo", topics: [] }] });
    }
    if (path === "/api/v1/panel/namespace-audit") {
      return jsonResponse({ summary: { total: 2, missingWorkspace: 0, unknownSource: 0, missingAgentSourceTag: 0, crossWorkspaceRisk: 0 }, issues: [] });
    }
    if (path === "/api/v1/panel/review/candidates?limit=100") {
      return jsonResponse({ items: [], total: 0 });
    }
    if (path.startsWith("/api/v1/panel/items?")) {
      return jsonResponse({
        items: [
          listItem("memory-1", "Summary: First memory"),
          listItem("memory-2", "Summary: Second memory")
        ],
        page: 1,
        pageSize: 20,
        total: 2,
        totalPages: 1,
        hasNext: false,
        hasPrev: false
      });
    }
    if (path.startsWith("/api/v1/memory/")) {
      const id = decodeURIComponent(path.slice("/api/v1/memory/".length));
      return new Promise((resolve) => {
        detailResolvers.set(id, (body) => resolve(jsonResponse(body)));
      });
    }
    throw new Error(`unexpected fetch path: ${path}`);
  };

  return {
    document: {
      getElementById(id: string) {
        const element = elements.get(id);
        if (!element) {
          throw new Error(`missing element: ${id}`);
        }
        return element;
      },
      documentElement: new FakeElement()
    },
    element(id: string) {
      return elements.get(id)!;
    },
    fetch,
    resolveDetail(id: string, body: unknown) {
      const resolve = detailResolvers.get(id);
      if (!resolve) {
        throw new Error(`missing resolver for detail: ${id}`);
      }
      resolve(body);
    },
    rowHtml() {
      return memoryRows.html;
    },
    rows() {
      return memoryRows.childRows as FakeRow[];
    },
    requests() {
      return requests;
    }
  };
}

class FakeElement {
  html = "";
  innerHTML = "";
  textContent = "";
  value = "";
  disabled = false;
  onclick: unknown;
  onkeydown: unknown;
  onfocus: unknown;
  onchange: unknown;
  childRows: FakeRow[] = [];
  dataset: Record<string, string> = {};
  className = "";
  classList = {
    add: () => undefined,
    remove: () => undefined,
    toggle: () => undefined
  };

  querySelectorAll(selector: string): FakeRow[] {
    if (selector === "tr") return this.childRows;
    const matches = [...this.innerHTML.matchAll(/<button[^>]*data-(?:decision|topic)-action="([^"]+)"[^>]*>/g)];
    return matches.map((match) => { const row = new FakeElement() as FakeRow; row.dataset = { id: match[1] || "" }; row.onclick = async () => undefined; return row; });
  }
  select(): void {
    return undefined;
  }

  focus(): void {
    return undefined;
  }

  setAttribute(): void {
    return undefined;
  }
}

function listItem(id: string, title: string) {
  return {
    id,
    kind: "trace",
    memoryLayer: "L1",
    status: "activated",
    title,
    summary: `${title} summary`,
    tags: [],
    createdAt: "2026-06-22T00:00:00.000Z",
    updatedAt: "2026-06-22T00:00:00.000Z",
    version: 1,
    metadata: {
      source: "codex",
      namespace: {
        tenantId: "local",
        projectId: "demo",
        workspaceId: "workspace_1",
        workspacePath: "/tmp/demo",
        label: "demo"
      }
    }
  };
}

function jsonResponse(body: unknown) {
  return {
    ok: true,
    statusText: "OK",
    text: async () => JSON.stringify(body)
  };
}

function decodeHtml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}
