import type { Repositories } from "../../storage/repositories.js";
import type { TopicAgentSpec } from "../../types.js";
import { stableHash } from "../../utils/id.js";
import { nowIso } from "../../utils/time.js";

export interface EvidenceSnapshotInput {
  namespaceId: string;
  topicId: string;
  agents?: TopicAgentSpec[];
}

export interface EvidenceSnapshotResult {
  topicVersion: number;
  evidenceIds: string[];
  evidenceHashes: Record<string, string>;
  evidenceContent: Record<string, string>;
  projectConstraints: Array<Record<string, unknown>>;
  roster: TopicAgentSpec[];
  inputHash: string;
}

export class EvidenceSnapshotBuilder {
  constructor(private readonly repos: Repositories) {}

  build(input: EvidenceSnapshotInput): EvidenceSnapshotResult {
    const topic = this.repos.topics.getTopic(input.topicId, input.namespaceId);
    if (!topic) {
      throw new Error(`topic not found: ${input.topicId}`);
    }

    // Get all evidence linked to the topic (without namespace filter) for validation
    const allEvidence = this.repos.topics.listAllEvidenceForTopic(input.topicId);

    // Validate every evidence attached to the topic
    for (const ev of allEvidence) {
      if (ev.namespaceId !== input.namespaceId) {
        throw new Error(`evidence not found in namespace: ${ev.id}`);
      }
    }

    // Get evidence for this namespace (now validated)
    const evidence = allEvidence.filter((ev) => ev.namespaceId === input.namespaceId);

    const evidenceHashes: Record<string, string> = {};
    const evidenceContent: Record<string, string> = {};

    for (const ev of evidence) {
      const contentHash = stableHash({
        id: ev.id,
        topicId: ev.topicId,
        memoryId: ev.memoryId,
        role: ev.role,
        summary: ev.summary,
        metadata: ev.metadata
      });
      evidenceHashes[ev.id] = contentHash;
      evidenceContent[ev.id] = ev.summary;
    }

    // Get project constraints if projectId present
    const projectConstraints: Array<Record<string, unknown>> = [];
    if (topic.projectId) {
      const goals = this.repos.projectContext.listGoals(input.namespaceId).filter((g) => g.projectId === topic.projectId);
      for (const goal of goals) {
        projectConstraints.push({
          type: "goal",
          id: goal.id,
          title: goal.title,
          description: goal.detail ?? goal.summary,
          status: goal.status
        });
      }
    }

    const roster = input.agents ?? [];

    const canonicalInput = {
      namespaceId: input.namespaceId,
      topicId: input.topicId,
      topicVersion: topic.version,
      evidenceIds: evidence.map((e) => e.id).sort(),
      evidenceHashes: Object.entries(evidenceHashes).sort(([a], [b]) => a.localeCompare(b)),
      projectConstraints: projectConstraints.map((c) => c.id).sort(),
      roster: roster.map((a) => ({ id: a.id, role: a.role, model: a.model, reason: a.reason }))
    };

    const inputHash = stableHash(canonicalInput);

    return {
      topicVersion: topic.version,
      evidenceIds: evidence.map((e) => e.id),
      evidenceHashes,
      evidenceContent,
      projectConstraints,
      roster,
      inputHash
    };
  }
}