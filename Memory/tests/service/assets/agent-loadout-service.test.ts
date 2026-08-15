import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentLoadoutService } from "../../../src/service/assets/agent-loadout-service.js";
import { MemoryDb } from "../../../src/storage/db.js";
import { Repositories } from "../../../src/storage/repositories.js";
import type { MemoryAssetRecord, ProjectWorkItemRecord } from "../../../src/types.js";

const NOW = "2026-08-15T12:00:00.000Z";
const ALPHA = "local:project-a";

function asset(overrides: Partial<MemoryAssetRecord> = {}): MemoryAssetRecord {
  return {
    id: "asset-runbook",
    namespaceId: ALPHA,
    assetType: "skill",
    stableKey: "repository/recovery-runbook",
    version: 1,
    status: "active",
    title: "Repository recovery runbook",
    summary: "Recover an interrupted repository migration",
    contentRef: "memory://assets/recovery/v1",
    ownerId: "agent-curator",
    visibility: "restricted",
    allowedAgentIds: ["agent-codex"],
    sourceMemoryIds: ["memory-1"],
    sourceEpisodeIds: ["episode-1"],
    sourceTraceIds: ["trace-1"],
    sourceTopicIds: [],
    applicability: {
      scope: "project",
      taskTypes: ["repository-migration"],
      projectIds: ["project-a"],
      planIds: ["plan-1"],
      workItemIds: ["work-1"],
      requiredSignals: ["migration-interrupted"],
      excludedSignals: ["read-only-worktree"],
      invocationHints: ["Use before resuming migration changes"],
      validFrom: "2026-08-01T00:00:00.000Z",
      validUntil: "2026-12-31T23:59:59.000Z",
      retireWhen: "project_completed"
    },
    validation: { attempts: 2, successes: 2, failures: 0, unknowns: 0, transferRewardSum: 1.4, riskPenaltySum: 0 },
    provenance: {},
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  };
}

function workItem(overrides: Partial<ProjectWorkItemRecord> = {}): ProjectWorkItemRecord {
  return {
    id: "work-1",
    namespaceId: ALPHA,
    userId: "user-a",
    projectId: "project-a",
    goalId: "goal-1",
    title: "Recover migration",
    summary: "Recover the interrupted migration",
    nextStep: "Inspect the failure",
    acceptanceCriteria: [],
    constraints: [],
    status: "active",
    focused: false,
    sourceMemoryIds: [],
    provenance: {},
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  };
}

function withService<T>(run: (context: { service: AgentLoadoutService; repos: Repositories }) => T): T {
  const root = mkdtempSync(join(tmpdir(), "agent-loadout-service-"));
  const db = new MemoryDb({ path: join(root, "memory.sqlite") });
  const repos = new Repositories(db.db);
  let nextId = 0;
  const service = new AgentLoadoutService({ repositories: repos, now: () => NOW, id: (prefix) => `${prefix}-${++nextId}` });
  try {
    return run({ service, repos });
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}

describe("AgentLoadoutService", () => {
  it("binds an authorized agent to the exact active asset version", () => withService(({ service, repos }) => {
    const first = repos.assets.create(asset());
    repos.assets.create(asset({ version: 2, title: "Recovery runbook v2", contentRef: "memory://assets/recovery/v2" }));

    const binding = service.bind({
      namespaceId: ALPHA,
      agentId: "agent-codex",
      assetId: first.id,
      assetVersion: 1,
      mode: "recall",
      priority: 20,
      projectId: "project-a",
      planId: "plan-1",
      workItemId: "work-1",
      taskTypes: ["repository-migration"],
      retireWhen: "project_completed"
    });

    expect(binding).toMatchObject({ assetVersion: 1, enabled: true, mode: "recall" });
    expect(service.listAvailable({
      namespaceId: ALPHA,
      agentId: "agent-codex",
      mode: "recall",
      projectId: "project-a",
      planId: "plan-1",
      workItemId: "work-1",
      taskType: "repository-migration",
      signals: ["migration-interrupted"],
      at: NOW
    })).toEqual([{ binding, asset: first }]);
  }));

  it("rejects cross-namespace, non-active, unauthorized, and out-of-scope bindings", () => withService(({ service, repos }) => {
    repos.assets.create(asset());
    repos.assets.create(asset({ id: "candidate", stableKey: "candidate", status: "candidate" }));

    const bind = (overrides: Record<string, unknown> = {}) => service.bind({
      namespaceId: ALPHA,
      agentId: "agent-codex",
      assetId: "asset-runbook",
      assetVersion: 1,
      mode: "recall",
      priority: 1,
      projectId: "project-a",
      taskTypes: ["repository-migration"],
      retireWhen: "project_completed",
      ...overrides
    });

    expect(() => bind({ namespaceId: "local:project-b" })).toThrow("asset not found");
    expect(() => bind({ assetId: "candidate" })).toThrow("active asset");
    expect(() => bind({ agentId: "agent-other" })).toThrow("not visible");
    expect(() => bind({ projectId: "project-b" })).toThrow("project scope");
    expect(() => bind({ taskTypes: ["unrelated-task"] })).toThrow("task type scope");
  }));

  it("filters availability by mode, scope, signals, time, and fixed lifecycle state", () => withService(({ service, repos }) => {
    const stored = repos.assets.create(asset());
    const binding = service.bind({
      namespaceId: ALPHA, agentId: "agent-codex", assetId: stored.id, assetVersion: 1,
      mode: "recall", priority: 20, projectId: "project-a", planId: "plan-1", workItemId: "work-1",
      taskTypes: ["repository-migration"], retireWhen: "project_completed"
    });
    const base = {
      namespaceId: ALPHA, agentId: "agent-codex", mode: "recall" as const, projectId: "project-a",
      planId: "plan-1", workItemId: "work-1", taskType: "repository-migration",
      signals: ["migration-interrupted"], at: NOW
    };

    expect(service.listAvailable(base)).toEqual([{ binding, asset: stored }]);
    expect(service.listAvailable({ ...base, mode: "tool" })).toEqual([]);
    expect(service.listAvailable({ ...base, signals: [] })).toEqual([]);
    expect(service.listAvailable({ ...base, signals: ["migration-interrupted", "read-only-worktree"] })).toEqual([]);
    expect(service.listAvailable({ ...base, at: "2027-01-01T00:00:00.000Z" })).toEqual([]);
    repos.assets.updateStatus(ALPHA, stored.id, 1, "active", "deprecated", NOW);
    expect(service.listAvailable(base)).toEqual([]);
  }));

  it("retires a completed work-item binding while preserving active asset trust", () => withService(({ service, repos }) => {
    const stored = repos.assets.create(asset({ applicability: { ...asset().applicability, scope: "work_item", retireWhen: "work_item_completed" } }));
    repos.projectContext.insertWorkItem(workItem({ goalId: undefined, status: "completed" }));
    const binding = service.bind({
      namespaceId: ALPHA, agentId: "agent-codex", assetId: stored.id, assetVersion: 1,
      mode: "bootstrap", priority: 20, projectId: "project-a", workItemId: "work-1",
      taskTypes: ["repository-migration"], retireWhen: "work_item_completed"
    });

    expect(service.retireCompleted({ namespaceId: ALPHA, agentId: "agent-codex", actorId: "system-worker" }))
      .toEqual([{ ...binding, enabled: false }]);
    expect(repos.assets.get(ALPHA, stored.id, 1)?.status).toBe("active");
    expect(repos.runtime.listChanges("system-worker", 10, undefined, ALPHA)[0]).toMatchObject({
      changeType: "asset.loadout.retired",
      entityId: binding.id
    });
  }));
});
