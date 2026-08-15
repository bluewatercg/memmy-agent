import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryDb } from "../../src/storage/db.js";
import {
  AssetRecallEventIdempotencyConflictError,
  Repositories
} from "../../src/storage/repositories.js";
import type { AssetRecallEventRecord } from "../../src/types.js";

const NOW = "2026-08-13T12:00:00.000Z";

function recall(overrides: Partial<AssetRecallEventRecord> = {}): AssetRecallEventRecord {
  return {
    id: "asset-recall-1",
    namespaceId: "local:project-a",
    assetId: "asset-runbook",
    assetVersion: 1,
    agentId: "agent-codex",
    episodeId: "episode-2",
    taskId: "task-2",
    loadoutEntryId: "loadout-1",
    mode: "recall",
    eventKey: "turn-3-offer",
    outcome: "offered",
    temporalValidityVersion: 4,
    freshnessAtRecall: "current",
    eligibilityEvaluatedAt: NOW,
    scoreInputs: {
      semantic: 0.82,
      validation: 0.75,
      priority: 20
    },
    evidenceIds: ["memory-1", "trace-2"],
    createdAt: NOW,
    ...overrides
  };
}

function withRepos<T>(run: (repos: Repositories) => T): T {
  const root = mkdtempSync(join(tmpdir(), "asset-recall-event-repository-"));
  const db = new MemoryDb({ path: join(root, "memory.sqlite") });
  try {
    return run(new Repositories(db.db));
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}

describe("asset recall event repository", () => {
  it("round-trips recall-time eligibility evidence", () => withRepos((repos) => {
    const event = recall();

    expect(repos.assetRecallEvents.append(event)).toEqual(event);
    expect(repos.assetRecallEvents.get(event.namespaceId, event.id)).toEqual(event);
    expect(repos.assetRecallEvents.listForEpisode(event.namespaceId, event.episodeId!)).toEqual([event]);
  }));

  it("makes an identical idempotency key retry stable", () => withRepos((repos) => {
    const event = recall();

    expect(repos.assetRecallEvents.append(event)).toEqual(event);
    expect(repos.assetRecallEvents.append({ ...event, id: "retry-id" })).toEqual(event);
    expect(repos.assetRecallEvents.listForEpisode(event.namespaceId, event.episodeId!)).toEqual([event]);
  }));

  it("rejects conflicting content for the same recall idempotency key", () => withRepos((repos) => {
    const event = recall();
    repos.assetRecallEvents.append(event);

    expect(() => repos.assetRecallEvents.append({
      ...event,
      id: "conflicting-id",
      outcome: "failed",
      failureReason: "asset reader failed"
    })).toThrow(AssetRecallEventIdempotencyConflictError);
  }));

  it("keeps offered, used, ignored, and failed as append-only events", () => withRepos((repos) => {
    const outcomes: AssetRecallEventRecord["outcome"][] = ["offered", "used", "ignored", "failed"];
    for (const [index, outcome] of outcomes.entries()) {
      repos.assetRecallEvents.append(recall({
        id: `event-${index}`,
        eventKey: `turn-3-${outcome}`,
        outcome,
        failureReason: outcome === "failed" ? "tool execution failed" : undefined
      }));
    }

    expect(repos.assetRecallEvents.listForEpisode("local:project-a", "episode-2").map((event) => event.outcome))
      .toEqual(outcomes);
  }));
});
