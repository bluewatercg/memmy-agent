import { traceMetaFromMemory } from "../../algorithm/plugin-algorithms.js";
import type { MemoryRow, ProjectTopicRecord } from "../../types.js";
import type { TopicMatch } from "./topic-inbox-types.js";

const MATCH_THRESHOLD = 0.5;
const AMBIGUITY_MARGIN = 0.08;
const GENERIC_TERMS = new Set(["error", "fix", "issue", "test", "task", "project", "code", "file", "run", "failed"]);

export function matchProjectTopic(memory: MemoryRow, topics: ProjectTopicRecord[]): TopicMatch {
  const role = evidenceRole(memory);
  const signals = memorySignals(memory);
  const ranked = topics.map((topic) => ({ topic, score: similarity(signals, topicSignals(topic)) })).sort((a, b) => b.score - a.score);
  const best = ranked[0];
  if (!best || best.score < MATCH_THRESHOLD) return { role, confidence: "new" };
  if (ranked[1] && best.score - ranked[1].score < AMBIGUITY_MARGIN) return { role, confidence: "ambiguous" };
  return { topic: best.topic, role, confidence: "assigned" };
}

function evidenceRole(memory: MemoryRow): TopicMatch["role"] {
  const text = `${memory.memoryValue}\n${memory.tags.join(" ")}`.toLowerCase();
  if (/\b(error|exception|failed|failure|crash)\b/.test(text)) return "error";
  if (/\b(fix(?:ed)?|repair(?:ed)?|resolved)\b/.test(text)) return "fix";
  if (/\b(verif(?:y|ied|ication)|passed|success(?:ful)?)\b/.test(text)) return "verification";
  return "evidence";
}

function memorySignals(memory: MemoryRow): Set<string> {
  const trace = traceMetaFromMemory(memory);
  const tools = trace?.toolCalls.map((call) => call.name) ?? [];
  return normalize([memory.memoryValue, ...memory.tags, ...tools, ...(trace?.errorSignatures ?? [])]);
}

function topicSignals(topic: ProjectTopicRecord): Set<string> {
  const metadata = topic.metadata;
  const stored = Array.isArray(metadata.signals) ? metadata.signals.filter((item): item is string => typeof item === "string") : [];
  return normalize([topic.title, topic.summary, ...stored]);
}

function normalize(values: string[]): Set<string> {
  return new Set(values.join(" ").toLowerCase().match(/[a-z0-9_./:-]{3,}/g)?.filter((term) => !GENERIC_TERMS.has(term)) ?? []);
}

function similarity(left: Set<string>, right: Set<string>): number {
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const value of left) if (right.has(value)) shared += 1;
  return shared / Math.max(1, Math.min(left.size, right.size));
}

export function topicSignalsForMemory(memory: MemoryRow): string[] {
  return [...memorySignals(memory)].sort();
}
