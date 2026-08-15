import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AssetLifecycleService } from "../../../src/service/assets/asset-lifecycle-service.js";
import type { AssetCandidateInput } from "../../../src/service/assets/asset-types.js";
import { MemoryDb } from "../../../src/storage/db.js";
import { Repositories } from "../../../src/storage/repositories.js";

const NOW = "2026-08-15T09:00:00.000Z";
const NAMESPACE = "local:project-a";

function skillCandidate(overrides: Partial<AssetCandidateInput> = {}): AssetCandidateInput {
  return {
    namespaceId: NAMESPACE,
    assetType: "skill",
    stableKey: "skill/recover-repository",
    title: "Recover repository",
    summary: "Recover an interrupted repository migration",
    contentRef: "memory://skills/recover-repository/v1",
    ownerId: "agent-curator",
    visibility: "restricted",
    allowedAgentIds: ["agent-codex"],
    sourceMemoryIds: ["policy-memory-1"],
    sourceEpisodeIds: ["episode-1"],
    sourceTraceIds: ["trace-1"],
    sourceTopicIds: [],
    applicability: {
      scope: "work_item",
      taskTypes: ["repository-migration"],
      projectIds: ["project-a"],
      planIds: ["plan-a"],
      workItemIds: ["work-a"],
      requiredSignals: ["migration-interrupted"],
      excludedSignals: ["read-only-worktree"],
      invocationHints: ["Use before resuming migration changes"],
      retireWhen: "work_item_completed"
    },
    provenance: {
      invocationGuide: "Inspect the interrupted migration before resuming it.",
      procedureJson: {
        summary: "Inspect state, repair the migration, and rerun the focused check.",
        steps: [
          { title: "Inspect", body: "Read the migration state and exact failure." },
          { title: "Repair", body: "Apply the narrow repair and rerun the failed check." }
        ],
        tools: ["shell"]
      },
      acceptanceRules: ["The focused migration check passes."],
      rollbackRules: ["Restore the pre-migration database snapshot."],
      sourcePolicyIds: ["policy-memory-1"],
      evidenceAnchorIds: ["episode-1", "trace-1"],
      support: 3,
      gain: 0.4,
      eta: 0.8,
      trialProvenance: [
        { trialId: "trial-1", episodeId: "episode-1", traceId: "trace-1", policyId: "policy-memory-1", reward: 0.8, outcome: "success" },
        { trialId: "trial-2", episodeId: "episode-2", traceId: "trace-2", policyId: "policy-memory-1", reward: 0.7, outcome: "success" }
      ]
    },
    ...overrides
  };
}

function withService<T>(run: (context: { service: AssetLifecycleService; repos: Repositories }) => T): T {
  const root = mkdtempSync(join(tmpdir(), "skill-asset-lifecycle-"));
  const db = new MemoryDb({ path: join(root, "memory.sqlite") });
  const repos = new Repositories(db.db);
  let nextId = 0;
  const service = new AssetLifecycleService({
    repositories: repos,
    now: () => NOW,
    id: (prefix) => `${prefix}-${++nextId}`,
    skillActivation: { minimumTrials: 2, minimumEta: 0.5 }
  });
  try {
    return run({ service, repos });
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}

const audit = {
  actorId: "reviewer-1",
  reason: "Validated against successful migration trials",
  evidenceIds: ["trial-1", "trial-2"]
};

describe("AssetLifecycleService / governed Skill lifecycle", () => {
  it("rejects structurally incomplete Skill candidates before review", () => withService(({ service }) => {
    const created = service.createCandidate(skillCandidate({
      provenance: { ...skillCandidate().provenance, rollbackRules: [] }
    }));

    expect(() => service.submitForReview({
      namespaceId: NAMESPACE,
      assetId: created.id,
      assetVersion: 1,
      ...audit
    })).toThrow(/rollbackRules/);
    expect(service.getVersion(NAMESPACE, created.id, 1)?.status).toBe("candidate");
  }));
  it("allows a structurally complete candidate with no trials to enter review but blocks activation", () => withService(({ service }) => {
    const created = service.createCandidate(skillCandidate({
      provenance: { ...skillCandidate().provenance, trialProvenance: [] }
    }));
    const reviewing = service.submitForReview({
      namespaceId: NAMESPACE,
      assetId: created.id,
      assetVersion: 1,
      ...audit
    });

    expect(reviewing.status).toBe("reviewing");
    expect(() => service.activateSkill({
      namespaceId: NAMESPACE,
      assetId: created.id,
      assetVersion: 1,
      approved: true,
      unresolvedHighRiskConflicts: [],
      ...audit
    })).toThrow(/validation trials/);
  }));

  it("records completed trial evidence without bypassing governed approval", () => withService(({ service }) => {
    const created = service.createCandidate(skillCandidate({
      provenance: { ...skillCandidate().provenance, trialProvenance: [] }
    }));

    const updated = service.recordResolvedSkillTrial({
      namespaceId: NAMESPACE,
      stableKey: created.stableKey,
      trialId: "trial-auto-1",
      episodeId: "episode-auto-1",
      traceId: "trace-auto-1",
      reward: 1,
      outcome: "success",
      eta: 0.8,
      actorId: "worker.skill-trial-resolver",
      reason: "Resolved trial-auto-1"
    });

    expect(updated).toBeDefined();
    expect(updated!.status).toBe("reviewing");
    expect(updated!.provenance.trialProvenance).toEqual([
      expect.objectContaining({ trialId: "trial-auto-1", outcome: "success", reward: 1 })
    ]);
  }));


  it("requires explicit approval, successful provenance, configured trials and eta, and no high-risk conflict", () => withService(({ service }) => {
    const created = service.createCandidate(skillCandidate());
    service.submitForReview({ namespaceId: NAMESPACE, assetId: created.id, assetVersion: 1, ...audit });

    expect(() => service.activateSkill({
      namespaceId: NAMESPACE,
      assetId: created.id,
      assetVersion: 1,
      approved: true,
      unresolvedHighRiskConflicts: ["writes outside repository"],
      ...audit
    })).toThrow(/high-risk conflict/);

    expect(() => service.activateSkill({
      namespaceId: NAMESPACE,
      assetId: created.id,
      assetVersion: 1,
      approved: false,
      unresolvedHighRiskConflicts: [],
      ...audit
    })).toThrow(/explicit approval/);
    expect(service.getVersion(NAMESPACE, created.id, 1)?.status).toBe("reviewing");
  }));

  it("atomically activates one version, deprecates the prior active version, and preserves audit history", () => withService(({ service, repos }) => {
    const first = service.createCandidate(skillCandidate());
    service.submitForReview({ namespaceId: NAMESPACE, assetId: first.id, assetVersion: 1, ...audit });
    const activeFirst = service.activateSkill({
      namespaceId: NAMESPACE,
      assetId: first.id,
      assetVersion: 1,
      approved: true,
      unresolvedHighRiskConflicts: [],
      ...audit
    });
    const second = service.createScopeExpandedVersion({
      namespaceId: NAMESPACE,
      assetId: first.id,
      assetVersion: 1,
      applicability: {
        ...first.applicability,
        scope: "plan",
        workItemIds: [],
        retireWhen: "plan_completed"
      },
      successfulReuseEvidence: [
        { evidenceId: "trial-work-a", boundaryId: "work-a" },
        { evidenceId: "trial-work-b", boundaryId: "work-b" }
      ],
      ...audit
    });
    service.submitForReview({ namespaceId: NAMESPACE, assetId: second.id, assetVersion: 2, ...audit });
    const activeSecond = service.activateSkill({
      namespaceId: NAMESPACE,
      assetId: second.id,
      assetVersion: 2,
      approved: true,
      unresolvedHighRiskConflicts: [],
      ...audit
    });

    expect(activeFirst.status).toBe("active");
    expect(activeSecond.status).toBe("active");
    expect(service.getVersion(NAMESPACE, first.id, 1)?.status).toBe("deprecated");
    expect(service.getVersion(NAMESPACE, first.id, 2)?.status).toBe("active");
    expect(repos.assets.list(NAMESPACE, { stableKey: first.stableKey }).filter((asset) => asset.status === "active")).toHaveLength(1);
    expect(repos.runtime.listMemoryChanges(first.id).map((event) => event.changeType)).toEqual(expect.arrayContaining([
      "asset.skill.reviewing",
      "asset.skill.activated",
      "asset.skill.scope_expanded",
      "asset.skill.deprecated"
    ]));
  }));

  it("supports rejection, deprecation, and explicitly revalidated restoration while preserving terminal rejection", () => withService(({ service }) => {
    const rejected = service.createCandidate(skillCandidate({ stableKey: "skill/rejected" }));
    service.rejectSkill({ namespaceId: NAMESPACE, assetId: rejected.id, assetVersion: 1, ...audit });
    expect(service.getVersion(NAMESPACE, rejected.id, 1)?.status).toBe("rejected");
    expect(() => service.submitForReview({ namespaceId: NAMESPACE, assetId: rejected.id, assetVersion: 1, ...audit })).toThrow(/rejected/);

    const restorable = service.createCandidate(skillCandidate({ stableKey: "skill/restorable" }));
    service.submitForReview({ namespaceId: NAMESPACE, assetId: restorable.id, assetVersion: 1, ...audit });
    service.activateSkill({ namespaceId: NAMESPACE, assetId: restorable.id, assetVersion: 1, approved: true, unresolvedHighRiskConflicts: [], ...audit });
    service.deprecateSkill({ namespaceId: NAMESPACE, assetId: restorable.id, assetVersion: 1, ...audit });
    const restored = service.restoreSkill({
      namespaceId: NAMESPACE,
      assetId: restorable.id,
      assetVersion: 1,
      approved: true,
      unresolvedHighRiskConflicts: [],
      ...audit
    });
    expect(restored.status).toBe("active");
  }));

  it("creates a new immutable version for one-step scope expansion and requires distinct boundary evidence", () => withService(({ service }) => {
    const first = service.createCandidate(skillCandidate());

    expect(() => service.createScopeExpandedVersion({
      namespaceId: NAMESPACE,
      assetId: first.id,
      assetVersion: 1,
      applicability: { ...first.applicability, scope: "project", workItemIds: [], retireWhen: "project_completed" },
      successfulReuseEvidence: [{ evidenceId: "trial-work-a", boundaryId: "work-a" }],
      ...audit
    })).toThrow(/one scope level/);

    expect(() => service.createScopeExpandedVersion({
      namespaceId: NAMESPACE,
      assetId: first.id,
      assetVersion: 1,
      applicability: { ...first.applicability, scope: "plan", workItemIds: [], retireWhen: "plan_completed" },
      successfulReuseEvidence: [
        { evidenceId: "trial-work-a-1", boundaryId: "work-a" },
        { evidenceId: "trial-work-a-2", boundaryId: "work-a" }
      ],
      ...audit
    })).toThrow(/distinct boundaries/);

    const second = service.createScopeExpandedVersion({
      namespaceId: NAMESPACE,
      assetId: first.id,
      assetVersion: 1,
      applicability: { ...first.applicability, scope: "plan", workItemIds: [], retireWhen: "plan_completed" },
      successfulReuseEvidence: [
        { evidenceId: "trial-work-a", boundaryId: "work-a" },
        { evidenceId: "trial-work-b", boundaryId: "work-b" }
      ],
      ...audit
    });

    expect(second).toMatchObject({ id: first.id, version: 2, status: "candidate", applicability: { scope: "plan" } });
    expect(service.getVersion(NAMESPACE, first.id, 1)?.applicability.scope).toBe("work_item");
  }));
});
