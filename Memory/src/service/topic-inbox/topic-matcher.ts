import { traceMetaFromMemory } from "../../algorithm/plugin-algorithms.js";
import type { MemoryRow, ProjectTopicRecord } from "../../types.js";
import type { TopicMatch } from "./topic-inbox-types.js";

const MATCH_THRESHOLD = 0.5;
const AMBIGUITY_MARGIN = 0.08;
const GENERIC_TERMS: Record<string, true> = { error: true, fix: true, issue: true, test: true, task: true, project: true, code: true, file: true, run: true, failed: true };

export function matchProjectTopic(memory: MemoryRow, topics: ProjectTopicRecord[]): TopicMatch {
  const roles = evidenceRoles(memory);
  const signals = memorySignals(memory);
  const vector = traceMetaFromMemory(memory)?.vecSummary;
  const ranked = topics.map((topic) => {
    const lexical = similarity(signals, topicSignals(topic));
    const centroid = numericArray(topic.metadata.embeddingCentroid);
    const semantic = vector && centroid.length === vector.length ? cosine(vector, centroid) : 0;
    return { topic, score: Math.max(lexical, semantic) };
  }).sort((a, b) => b.score - a.score || a.topic.id.localeCompare(b.topic.id));
  const best = ranked[0];
  if (!best || best.score < MATCH_THRESHOLD) return { roles, confidence: "new" };
  if (ranked[1] && best.score - ranked[1].score < AMBIGUITY_MARGIN) return { roles, confidence: "ambiguous" };
  return { topic: best.topic, roles, confidence: "assigned" };
}

function evidenceRoles(memory: MemoryRow): TopicMatch["roles"] {
  const text = `${memory.memoryValue}\n${memory.tags.join(" ")}`.toLowerCase();
  const roles: TopicMatch["roles"] = [];
  if (/\b(error|exception|failed|failure|crash)\b/.test(text)) roles.push("error");
  if (/\b(fix(?:ed)?|repair(?:ed)?|resolved)\b/.test(text)) roles.push("fix");
  if (/\b(verif(?:y|ied|ication)|passed|success(?:ful)?)\b/.test(text)) roles.push("verification");
  return roles.length ? roles : ["evidence"];
}

function memorySignals(memory: MemoryRow): Set<string> {
  const trace = traceMetaFromMemory(memory);
  const tools = trace?.toolCalls.map((call) => call.name) ?? [];
  return normalize([memory.memoryValue, ...memory.tags, ...tools, ...(trace?.errorSignatures ?? []), trace?.episodeId ?? "", trace?.signature ?? "", ...structuredPaths(memory)]);
}

function structuredPaths(memory: MemoryRow): string[] {
  const internal = memory.properties.internal_info;
  return [internal.files, internal.modules, internal.tools, internal.error_signatures]
    .flatMap((value) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
}

function topicSignals(topic: ProjectTopicRecord): Set<string> {
  const stored = Array.isArray(topic.metadata.signals) ? topic.metadata.signals.filter((item): item is string => typeof item === "string") : [];
  return normalize([topic.title, topic.summary, ...stored]);
}

function normalize(values: string[]): Set<string> {
  return new Set(values.join(" ").toLowerCase().match(/[a-z0-9_./:-]{3,}/g)?.filter((term) => !GENERIC_TERMS[term]) ?? []);
}

function similarity(left: Set<string>, right: Set<string>): number {
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const value of left) if (right.has(value)) shared += 1;
  return shared / Math.max(1, Math.min(left.size, right.size));
}

function cosine(left: number[], right: number[]): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index]! * right[index]!;
    leftNorm += left[index]! ** 2;
    rightNorm += right[index]! ** 2;
  }
  return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : 0;
}

function numericArray(value: unknown): number[] {
  return Array.isArray(value) && value.every((item) => typeof item === "number" && Number.isFinite(item)) ? value : [];
}

export function topicSignalsForMemory(memory: MemoryRow): string[] {
  return [...memorySignals(memory)].sort();
}
