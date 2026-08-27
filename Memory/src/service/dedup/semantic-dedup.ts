import type { SemanticDedupConfig } from "../../config/index.js";
import { createMemoryLogger, memoryErrorFields } from "../../logging/logger.js";
import type { MemoryFilter, MemoryLayer } from "../../types.js";

const logger = createMemoryLogger("dedup");

export type SemanticDedupTier = "merge" | "warn" | "distinct" | "unknown";

export interface SemanticDedupMatch {
  memoryId: string;
  title: string;
  similarity: number;
}

export interface SemanticDedupResult {
  tier: SemanticDedupTier;
  /** Nearest matches ordered by similarity desc; empty for distinct/unknown. */
  matches: SemanticDedupMatch[];
  /** Highest cosine similarity found; undefined when no candidate vectors exist or check failed. */
  topSimilarity?: number;
  /** Failure reason when tier is "unknown" — unknown never blocks a write. */
  reason?: string;
}

export interface SemanticDedupCheckInput {
  content: string;
  title: string;
  layer: MemoryLayer;
  userId?: string;
  /** Memory ids to ignore (e.g. the row an upsert-by-key is about to update). */
  excludeMemoryIds?: string[];
}

/** Minimal collaborator surface so the service stays decoupled from repositories. */
export interface SemanticDedupDeps {
  config: { algorithm: { semanticDedup: SemanticDedupConfig } };
  embedOne(text: string, role?: "query" | "document"): Promise<number[]>;
  searchVectorIds(
    query: number[],
    vectorField: "vec_summary",
    filter: MemoryFilter,
    limit: number
  ): Array<{ id: string; score: number }>;
  getMany(memoryIds: string[]): Array<{ id: string; info: Record<string, unknown> }>;
}

/**
 * DreamCycle-style write-path dedup: embed the incoming content and compare it
 * against the nearest existing summary vectors in scope.
 *
 * Verdict tiers:
 * - merge   (≥ mergeThreshold): treat as duplicate of the top match.
 * - warn    (≥ warnThreshold): allow but annotate.
 * - distinct: allow.
 * - unknown (embedding/search failure): allow — never fall back to lexical
 *   comparison, which would silently pass false negatives.
 */
export class SemanticDedupService {
  constructor(private readonly deps: SemanticDedupDeps) {}

  async check(input: SemanticDedupCheckInput): Promise<SemanticDedupResult> {
    const options = this.deps.config.algorithm.semanticDedup;
    const startedAt = Date.now();
    let vector: number[];
    try {
      vector = await this.deps.embedOne(input.content, "document");
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      logger.error("semantic.unknown", { ...memoryErrorFields(error), layer: input.layer });
      return { tier: "unknown", matches: [], reason };
    }

    const exclude = new Set(input.excludeMemoryIds ?? []);
    const limit = Math.max(options.maxCandidates + exclude.size, options.maxCandidates);
    const hits = this.deps.searchVectorIds(vector, "vec_summary", buildScopeFilter(input), limit)
      .filter((hit) => !exclude.has(hit.id))
      .slice(0, Math.max(options.maxCandidates, 0));
    if (hits.length === 0) {
      return { tier: "distinct", matches: [] };
    }

    const titles = titleById(this.deps.getMany(hits.map((hit) => hit.id)));
    const matches = hits.map((hit) => ({
      memoryId: hit.id,
      title: titles.get(hit.id) ?? "",
      similarity: hit.score
    }));
    const topSimilarity = matches[0]?.similarity;
    const tier: SemanticDedupTier =
      topSimilarity !== undefined && topSimilarity >= options.mergeThreshold
        ? "merge"
        : topSimilarity !== undefined && topSimilarity >= options.warnThreshold
          ? "warn"
          : "distinct";
    logger.info("semantic.checked", {
      layer: input.layer,
      tier,
      candidates: matches.length,
      topSimilarity,
      durationMs: Date.now() - startedAt
    });
    return { tier, matches, topSimilarity };
  }
}

function buildScopeFilter(input: SemanticDedupCheckInput): MemoryFilter {
  // Compare within the same durable layer only: an L2 policy must not be
  // declared a duplicate of an L1 turn transcript and vice versa.
  return { memoryLayer: input.layer, ...(input.userId ? { userId: input.userId } : {}) };
}

function titleById(rows: Array<{ id: string; info: Record<string, unknown> }>): Map<string, string> {
  const byId = new Map<string, string>();
  for (const row of rows) {
    const title = row.info?.title;
    if (typeof title === "string") byId.set(row.id, title);
  }
  return byId;
}
