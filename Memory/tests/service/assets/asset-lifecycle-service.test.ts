import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AssetLifecycleService } from "../../../src/service/assets/asset-lifecycle-service.js";
import { MemoryDb } from "../../../src/storage/db.js";
import { Repositories } from "../../../src/storage/repositories.js";
import type { AssetCandidateInput } from "../../../src/service/assets/asset-types.js";

const NOW = "2026-08-15T09:00:00.000Z";
const ALPHA = "local:project-a";
const BETA = "local:project-b";

function candidate(overrides: Partial<AssetCandidateInput> = {}): AssetCandidateInput {
  return {
    namespaceId: ALPHA,
    assetType: "skill",
    stableKey: "repository/recovery-runbook",
    title: "Repository recovery runbook",
    summary: "Recover a repository after an interrupted migration",
    contentRef: "memory://assets/repository-recovery/v1",
    ownerId: "agent-curator",
    visibility: "restricted",
    allowedAgentIds: ["agent-codex", "agent-reviewer"],
    sourceMemoryIds: ["memory-1", "memory-2"],
    sourceEpisodeIds: ["episode-1"],
    sourceTraceIds: ["trace-1"],
    sourceTopicIds: ["topic-1"],
    applicability: {
      scope: "project",
      taskTypes: ["repository-migration"],
      projectIds: ["project-a"],
      planIds: ["plan-1"],
      workItemIds: ["work-1"],
      requiredSignals: ["migration-interrupted"],
      excludedSignals: ["read-only-worktree"],
      invocationHints: ["Use before resuming schema changes"],
      validFrom: "2026-08-01T00:00:00.000Z",
      validUntil: "2026-12-31T23:59:59.000Z",
      retireWhen: "project_completed"
    },
    provenance: {
      generator: "asset-lifecycle-test",
      source: { adapter: "codex", requestId: "request-1" },
      confidence: 0.91
    },
    ...overrides
  };
}

function withService<T>(run: (context: {
  service: AssetLifecycleService;
  repos: Repositories;
}) => T): T {
  const root = mkdtempSync(join(tmpdir(), "asset-lifecycle-service-"));
  const db = new MemoryDb({ path: join(root, "memory.sqlite") });
  const repos = new Repositories(db.db);
  let nextId = 0;
  const service = new AssetLifecycleService({
    repositories: repos,
    now: () => NOW,
    id: (prefix) => `${prefix}-${++nextId}`
  });
  try {
    return run({ service, repos });
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}

describe("AssetLifecycleService", () => {
  it("creates a candidate at version one with zeroed validation defaults", () => withService(({ service }) => {
    const created = service.createCandidate(candidate());

    expect(created).toMatchObject({
      namespaceId: ALPHA,
      assetType: "skill",
      stableKey: "repository/recovery-runbook",
      status: "candidate",
      version: 1,
      createdAt: NOW,
      updatedAt: NOW,
      validation: {
        attempts: 0,
        successes: 0,
        failures: 0,
        unknowns: 0,
        transferRewardSum: 0,
        riskPenaltySum: 0
      }
    });
    expect(created.id).toEqual(expect.any(String));
  }));

  it("reads an explicit version and resolves the latest version when omitted", () => withService(({ service, repos }) => {
    const first = service.createCandidate(candidate());
    const second = repos.assets.create({
      ...first,
      version: 2,
      title: "Repository recovery runbook v2",
      contentRef: "memory://assets/repository-recovery/v2",
      createdAt: "2026-08-15T10:00:00.000Z",
      updatedAt: "2026-08-15T10:00:00.000Z"
    });

    expect(service.getVersion(ALPHA, first.id, 1)).toEqual(first);
    expect(service.getVersion(ALPHA, first.id, 2)).toEqual(second);
    expect(service.getVersion(ALPHA, first.id)).toEqual(second);
    expect(service.getVersion(ALPHA, first.id, 99)).toBeUndefined();
  }));

  it("returns the original candidate when identical stable-key content is retried", () => withService(({ service, repos }) => {
    const input = candidate();

    const first = service.createCandidate(input);
    const retry = service.createCandidate({ ...input });

    expect(retry).toEqual(first);
    expect(repos.assets.list(ALPHA, { stableKey: input.stableKey })).toEqual([first]);
  }));

  it("keeps an identical candidate retry idempotent after validation changes", () => withService(({ service, repos }) => {
    const input = candidate();
    const created = service.createCandidate(input);
    repos.assets.updateValidation(ALPHA, created.id, created.version, {
      ...created.validation,
      attempts: 1,
      successes: 1
    }, NOW);

    expect(service.upsertCandidateVersion({ ...input }, 1)).toMatchObject({
      id: created.id,
      version: 1,
      status: "candidate",
      validation: { attempts: 1, successes: 1 }
    });
    expect(repos.assets.list(ALPHA, { stableKey: input.stableKey })).toHaveLength(1);
  }));

  it("creates the requested next candidate version with stable asset identity", () => withService(({ service, repos }) => {
    const first = service.createCandidate(candidate());
    const second = service.upsertCandidateVersion(candidate({
      title: "Repository recovery runbook v2",
      contentRef: "memory://assets/repository-recovery/v2"
    }), 2);

    expect(second).toMatchObject({
      id: first.id,
      version: 2,
      status: "candidate",
      title: "Repository recovery runbook v2",
      contentRef: "memory://assets/repository-recovery/v2"
    });
    expect(repos.assets.list(ALPHA, { stableKey: first.stableKey })).toEqual([first, second]);
  }));

  it("keeps versioned candidate retries idempotent and rejects version gaps", () => withService(({ service }) => {
    const input = candidate({ contentRef: "memory://assets/repository-recovery/v1" });
    const first = service.upsertCandidateVersion(input, 1);

    expect(service.upsertCandidateVersion({ ...input }, 1)).toEqual(first);
    expect(() => service.upsertCandidateVersion(candidate({
      contentRef: "memory://assets/repository-recovery/v3"
    }), 3)).toThrow("asset candidate version must follow latest version 1");
  }));

  it("isolates candidate identity, stable keys, and version reads by namespace", () => withService(({ service }) => {
    const alpha = service.createCandidate(candidate());
    const beta = service.createCandidate(candidate({
      namespaceId: BETA,
      title: "Project B recovery runbook",
      contentRef: "memory://assets/project-b/repository-recovery/v1",
      applicability: {
        ...candidate().applicability,
        projectIds: ["project-b"]
      }
    }));

    expect(service.getVersion(ALPHA, alpha.id)).toEqual(alpha);
    expect(service.getVersion(BETA, beta.id)).toEqual(beta);
    expect(service.getVersion(BETA, alpha.id)).toBeUndefined();
    expect(service.getVersion(ALPHA, beta.id)).toBeUndefined();
    expect(alpha.namespaceId).toBe(ALPHA);
    expect(beta.namespaceId).toBe(BETA);
  }));
});
