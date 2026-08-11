import type { LlmClient } from "../../model/types.js";
import type { MemoryRow, ProjectTopicEvidenceRecord, ProjectTopicRecord } from "../../types.js";
import { memoryVectorEntries } from "../../storage/memory-vector-state.js";
import { stableHash } from "../../utils/id.js";
import { isRecord } from "../../utils/json.js";
import type { TopicAnalysisResult, TopicCandidateAnalysis } from "./topic-inbox-types.js";

export function topicAnalysisInputHash(topic: ProjectTopicRecord | undefined, evidence: Array<{ memory: MemoryRow; role: string | string[] }>): string {
  return stableHash(evidence.map(({ memory, role }) => ({ id: memory.id, contentHash: memory.contentHash, version: memory.version, quality: memory.info.quality_rating, verification: memory.info.verification_status, role })).sort((a, b) => a.id.localeCompare(b.id)));
}

export function topicCentroidInputHash(evidence: Array<{ memory: MemoryRow }>): string {
  return stableHash(evidence.map(({ memory }) => ({
    id: memory.id,
    vectors: memoryVectorEntries(memory).map((entry) => ({ field: entry.vectorField, vector: entry.vector, model: entry.embeddingModel, provider: entry.embeddingProvider }))
  })).sort((a, b) => a.id.localeCompare(b.id)));
}

export async function analyzeProjectTopic(input: {
  llm: LlmClient;
  topic?: ProjectTopicRecord;
  evidence: Array<{ memory: MemoryRow; role: string | string[] }>;
}): Promise<TopicAnalysisResult> {
  const result = await input.llm.completeJson<Record<string, unknown>>([
    { role: "system", content: "Aggregate project L1 evidence into one topic and zero or more governed candidates. Preserve error, fix, and verification order. Return JSON only." },
    { role: "user", content: JSON.stringify({ topic: input.topic, evidence: input.evidence.map(({ memory, role }) => ({ id: memory.id, role, timeline: memory.timeline, value: memory.memoryValue, tags: memory.tags })) }) }
  ], { operation: "topic.inbox.analyze", temperature: 0, jsonMode: true });
  return validateTopicAnalysis(result);
}

function validateTopicAnalysis(value: unknown): TopicAnalysisResult {
  if (!isRecord(value) || !isRecord(value.topic) || typeof value.topic.title !== "string" || !value.topic.title.trim() || typeof value.topic.summary !== "string" || !value.topic.summary.trim() || !Array.isArray(value.candidates)) {
    throw new Error("invalid topic analysis result");
  }
  const candidates = value.candidates.map(validateCandidate);
  const slots = new Set<string>();
  for (const candidate of candidates) {
    const slot = candidateSlot(candidate);
    if (slots.has(slot)) throw new Error(`duplicate topic candidate slot: ${slot}`);
    slots.add(slot);
  }
  return {
    topic: { title: value.topic.title.trim(), summary: value.topic.summary.trim() },
    candidates
  };
}

function validateCandidate(value: unknown): TopicCandidateAnalysis {
  if (!isRecord(value)) throw new Error("invalid topic candidate");
  const proposedLayer = enumValue(value.proposedLayer, ["L2", "L3", "Skill"] as const, "proposedLayer");
  const risk = enumValue(value.risk, ["low", "medium", "high"] as const, "risk");
  const confidence = enumValue(value.confidence, ["low", "medium", "high"] as const, "confidence");
  const verificationStatus = enumValue(value.verificationStatus, ["unverified", "failed", "verified"] as const, "verificationStatus");
  if (typeof value.title !== "string" || !value.title.trim() || typeof value.conclusion !== "string" || !value.conclusion.trim() || typeof value.verificationEvidence !== "string") throw new Error("invalid topic candidate fields");
  const stableKey = value.stableKey === undefined ? undefined : validatedStableKey(value.stableKey);
  return { title: value.title.trim(), ...(stableKey ? { stableKey } : {}), conclusion: value.conclusion.trim(), proposedLayer, risk, confidence, verificationStatus, verificationEvidence: value.verificationEvidence.trim(), sourceEvidenceIds: stringArray(value.sourceEvidenceIds), conflicts: stringArray(value.conflicts), sensitiveCategories: stringArray(value.sensitiveCategories) };
}

function enumValue<const T extends readonly string[]>(value: unknown, allowed: T, name: string): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) throw new Error(`invalid topic candidate ${name}`);
  return value as T[number];
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error("invalid topic candidate array");
  return value.map((item) => item.trim()).filter(Boolean);
}

function candidateSlot(candidate: TopicCandidateAnalysis): string {
  if (candidate.stableKey) return stableHash({ layer: candidate.proposedLayer, stableKey: candidate.stableKey.normalize("NFKC").toLocaleLowerCase() });
  return stableHash({
    layer: candidate.proposedLayer,
    title: candidate.title.normalize("NFKC").toLocaleLowerCase(),
    evidence: [...candidate.sourceEvidenceIds].sort(),
    sensitive: candidate.sensitiveCategories.map((item) => item.normalize("NFKC").toLocaleLowerCase()).sort()
  });
}

function validatedStableKey(value: unknown): string {
  if (typeof value !== "string") throw new Error("invalid topic candidate stableKey");
  const normalized = value.normalize("NFKC").trim();
  if (!normalized || normalized.length > 128 || !/^[\p{L}\p{N}_.:/ -]+$/u.test(normalized)) throw new Error("invalid topic candidate stableKey");
  return normalized;
}

