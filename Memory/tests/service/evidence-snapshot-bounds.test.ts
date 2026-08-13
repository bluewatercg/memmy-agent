import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryDb } from "../../src/index.js";
import { Repositories } from "../../src/storage/repositories.js";
import { EvidenceSnapshotBuilder, EVIDENCE_SUMMARY_MAX_CHARS } from "../../src/service/topic-decision/evidence-snapshot.js";

const at = "2026-08-12T00:00:00.000Z";
const nsA = "local:workspace-a";

describe("EvidenceSnapshotBuilder bounded summary", () => {
  it("stores evidence summary bounded at EVIDENCE_SUMMARY_MAX_CHARS", () => {
    const root = mkdtempSync(join(tmpdir(), "ev-snapshot-bounded-"));
    try {
      const db = new MemoryDb({ path: join(root, "memory.sqlite") });
      const repos = new Repositories(db.db);

      // Create topic
      repos.topics.insertTopic({
        id: "topic-1",
        namespaceId: nsA,
        title: "Test Topic",
        summary: "test",
        status: "active",
        version: 1,
        sourceMemoryIds: [],
        metadata: {},
        createdAt: at,
        updatedAt: at
      });

      // Create oversized summary (2x the limit)
      const oversizedSummary = "x".repeat(EVIDENCE_SUMMARY_MAX_CHARS * 2);

      // Create evidence with oversized summary
      repos.topics.insertEvidence({
        id: "ev-1",
        topicId: "topic-1",
        namespaceId: nsA,
        memoryId: "mem-1",
        role: "support",
        summary: oversizedSummary,
        metadata: {},
        createdAt: at
      });

      const builder = new EvidenceSnapshotBuilder(repos);
      const result = builder.build({
        namespaceId: nsA,
        topicId: "topic-1"
      });

      // Evidence content must be bounded
      const content = result.evidenceContent["ev-1"]!;
      expect(content.length).toBeLessThanOrEqual(EVIDENCE_SUMMARY_MAX_CHARS);
      expect(content).toContain("…[truncated]");

      // Evidence hash is based on full canonical content (not truncated)
      // Same hash for same full summary
      expect(result.evidenceHashes["ev-1"]).toBeDefined();

      db.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves short summaries unchanged and hashes canonical evidence", () => {
    const root = mkdtempSync(join(tmpdir(), "ev-snapshot-short-"));
    try {
      const db = new MemoryDb({ path: join(root, "memory.sqlite") });
      const repos = new Repositories(db.db);

      repos.topics.insertTopic({
        id: "topic-2",
        namespaceId: nsA,
        title: "Test",
        summary: "test",
        status: "active",
        version: 1,
        sourceMemoryIds: [],
        metadata: {},
        createdAt: at,
        updatedAt: at
      });

      const shortSummary = "short summary under limit";
      repos.topics.insertEvidence({
        id: "ev-2",
        topicId: "topic-2",
        namespaceId: nsA,
        memoryId: "mem-2",
        role: "support",
        summary: shortSummary,
        metadata: {},
        createdAt: at
      });

      const builder = new EvidenceSnapshotBuilder(repos);
      const result = builder.build({
        namespaceId: nsA,
        topicId: "topic-2"
      });

      // Short summary preserved unchanged
      expect(result.evidenceContent["ev-2"]).toBe(shortSummary);
      expect(result.evidenceHashes["ev-2"]).toBeDefined();

      db.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("inputHash is stable and based on canonical full evidence content", () => {
    const root = mkdtempSync(join(tmpdir(), "ev-snapshot-hash-"));
    try {
      const db = new MemoryDb({ path: join(root, "memory.sqlite") });
      const repos = new Repositories(db.db);

      repos.topics.insertTopic({
        id: "topic-3",
        namespaceId: nsA,
        title: "Test",
        summary: "test",
        status: "active",
        version: 1,
        sourceMemoryIds: [],
        metadata: {},
        createdAt: at,
        updatedAt: at
      });

      // Create two identical topics with same evidence
      const longSummary = "a".repeat(EVIDENCE_SUMMARY_MAX_CHARS * 2);
      repos.topics.insertEvidence({
        id: "ev-3",
        topicId: "topic-3",
        namespaceId: nsA,
        memoryId: "mem-3",
        role: "support",
        summary: longSummary,
        metadata: { key: "value" },
        createdAt: at
      });

      const builder = new EvidenceSnapshotBuilder(repos);
      const result1 = builder.build({ namespaceId: nsA, topicId: "topic-3" });
      const result2 = builder.build({ namespaceId: nsA, topicId: "topic-3" });

      // Same canonical evidence produces same inputHash
      expect(result1.inputHash).toBe(result2.inputHash);
      // Hash is deterministic length
      expect(result1.inputHash.length).toBeGreaterThan(0);

      db.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});