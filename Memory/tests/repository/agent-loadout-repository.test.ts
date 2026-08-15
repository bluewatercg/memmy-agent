import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryDb } from "../../src/storage/db.js";
import { Repositories } from "../../src/storage/repositories.js";
import type { AgentLoadoutEntry } from "../../src/types.js";

const NOW = "2026-08-13T12:00:00.000Z";
const LATER = "2026-08-13T13:00:00.000Z";

function entry(overrides: Partial<AgentLoadoutEntry> = {}): AgentLoadoutEntry {
  return {
    id: "loadout-1",
    namespaceId: "local:project-a",
    agentId: "agent-codex",
    assetId: "asset-runbook",
    assetVersion: 1,
    mode: "recall",
    priority: 20,
    enabled: true,
    projectId: "project-a",
    planId: "plan-1",
    workItemId: "work-1",
    taskTypes: ["repository-migration"],
    retireWhen: "project_completed",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  };
}

function withRepos<T>(run: (repos: Repositories) => T): T {
  const root = mkdtempSync(join(tmpdir(), "agent-loadout-repository-"));
  const db = new MemoryDb({ path: join(root, "memory.sqlite") });
  try {
    return run(new Repositories(db.db));
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}

describe("agent loadout repository", () => {
  it("round-trips a version-pinned binding", () => withRepos((repos) => {
    const record = entry();

    expect(repos.agentLoadouts.create(record)).toEqual(record);
    expect(repos.agentLoadouts.get(record.namespaceId, record.id)).toEqual(record);
  }));

  it("lists enabled entries in stable priority order within namespace and agent", () => withRepos((repos) => {
    const lower = entry({ id: "loadout-lower", priority: 10 });
    const higher = entry({ id: "loadout-higher", assetId: "asset-higher", priority: 30 });
    const disabled = entry({ id: "loadout-disabled", assetId: "asset-disabled", priority: 40, enabled: false });
    const otherAgent = entry({ id: "loadout-other-agent", agentId: "agent-reviewer", assetId: "asset-reviewer", priority: 50 });
    const otherNamespace = entry({ id: "loadout-other-namespace", namespaceId: "local:project-b", assetId: "asset-b", priority: 60 });
    for (const record of [lower, higher, disabled, otherAgent, otherNamespace]) repos.agentLoadouts.create(record);

    expect(repos.agentLoadouts.list("local:project-a", "agent-codex", { enabled: true }))
      .toEqual([higher, lower]);
  }));

  it("disables a binding without changing its pinned asset version", () => withRepos((repos) => {
    const record = entry();
    repos.agentLoadouts.create(record);

    expect(repos.agentLoadouts.setEnabled(record.namespaceId, record.id, false, LATER)).toEqual({
      ...record,
      enabled: false,
      updatedAt: LATER
    });
    expect(repos.agentLoadouts.get(record.namespaceId, record.id)?.assetVersion).toBe(1);
  }));
});
