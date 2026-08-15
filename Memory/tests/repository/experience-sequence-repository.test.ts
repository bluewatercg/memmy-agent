import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryDb } from "../../src/storage/db.js";
import {
  ExperienceSequenceMembershipConflictError,
  ExperienceSequenceRepository,
  Repositories
} from "../../src/storage/repositories.js";
import type {
  ExperienceSequenceMemberRecord,
  ExperienceSequenceRecord
} from "../../src/types.js";

const NOW = "2026-08-13T13:00:00.000Z";

function sequence(overrides: Partial<ExperienceSequenceRecord> = {}): ExperienceSequenceRecord {
  return {
    id: "sequence-recovery",
    namespaceId: "local:project-a",
    title: "Repository recovery sequence",
    metadata: { source: "explicit", confidence: 1 },
    createdAt: NOW,
    ...overrides
  };
}

function member(overrides: Partial<ExperienceSequenceMemberRecord> = {}): ExperienceSequenceMemberRecord {
  return {
    id: "sequence-member-1",
    namespaceId: "local:project-a",
    sequenceId: "sequence-recovery",
    episodeId: "episode-solve",
    position: 0,
    role: "solve",
    taskId: "task-recover",
    planId: "plan-1",
    workItemId: "work-1",
    topicId: "topic-recovery",
    provenance: { actor: "agent-codex" },
    createdAt: NOW,
    ...overrides
  };
}

function withRepo<T>(run: (repo: ExperienceSequenceRepository) => T): T {
  const root = mkdtempSync(join(tmpdir(), "experience-sequence-repository-"));
  const db = new MemoryDb({ path: join(root, "memory.sqlite") });
  try {
    return run(new Repositories(db.db).experienceSequences);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}

describe("experience sequence repository", () => {
  it("round-trips namespace-scoped sequence metadata and ordered members", () => withRepo((repo) => {
    const record = sequence();
    const first = member();
    const second = member({
      id: "sequence-member-2",
      episodeId: "episode-verify",
      position: 1,
      role: "verify"
    });

    expect(repo.create(record)).toEqual(record);
    expect(repo.appendMember(second)).toEqual(second);
    expect(repo.appendMember(first)).toEqual(first);
    expect(repo.get(record.namespaceId, record.id)).toEqual(record);
    expect(repo.listMembers(record.namespaceId, record.id)).toEqual([first, second]);
    expect(repo.getMemberByEpisode(record.namespaceId, first.episodeId)).toEqual(first);
  }));

  it("isolates sequence and episode membership reads by namespace", () => withRepo((repo) => {
    const first = sequence();
    const second = sequence({ namespaceId: "local:project-b", title: "Project B sequence" });
    repo.create(first);
    repo.create(second);
    repo.appendMember(member());
    repo.appendMember(member({ namespaceId: "local:project-b", id: "member-b", episodeId: "episode-b" }));

    expect(repo.get("local:project-a", first.id)).toEqual(first);
    expect(repo.get("local:project-b", second.id)).toEqual(second);
    expect(repo.getMemberByEpisode("local:project-a", "episode-b")).toBeUndefined();
    expect(repo.getMemberByEpisode("local:project-b", "episode-solve")).toBeUndefined();
  }));

  it("makes identical metadata and membership retries idempotent", () => withRepo((repo) => {
    const record = sequence();
    const membership = member();

    expect(repo.create(record)).toEqual(record);
    expect(repo.create(record)).toEqual(record);
    expect(repo.appendMember(membership)).toEqual(membership);
    expect(repo.appendMember({ ...membership, id: "retry-member" })).toEqual(membership);
    expect(repo.listMembers(record.namespaceId, record.id)).toEqual([membership]);
  }));

  it("rejects duplicate positions and membership in multiple sequences", () => withRepo((repo) => {
    repo.create(sequence());
    repo.create(sequence({ id: "sequence-second", title: "Second sequence" }));
    repo.appendMember(member());

    expect(() => repo.appendMember(member({
      id: "duplicate-position",
      episodeId: "episode-other"
    }))).toThrow(ExperienceSequenceMembershipConflictError);
    expect(() => repo.appendMember(member({
      id: "duplicate-episode",
      sequenceId: "sequence-second",
      position: 1
    }))).toThrow(ExperienceSequenceMembershipConflictError);
  }));

  it("rejects negative and fractional positions", () => withRepo((repo) => {
    repo.create(sequence());

    expect(() => repo.appendMember(member({ position: -1 }))).toThrow();
    expect(() => repo.appendMember(member({ position: 0.5 }))).toThrow();
  }));
});
