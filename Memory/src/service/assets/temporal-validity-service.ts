import { namespaceForMemory, namespaceIdFromContext } from "../namespace/namespace-scope.js";
import type { MemoryFreshness, MemoryTemporalValidity, MemoryTemporalValidityEvent } from "../../types.js";
import type {
  AssetServiceDependencies,
  TemporalAuditInput,
  TemporalEventType,
  TemporalInitializeInput,
  TemporalInvalidateInput,
  TemporalMutationInput,
  TemporalProjection,
  TemporalProjectionOptions,
  TemporalReviewInput,
  TemporalSupersedeInput
} from "./asset-types.js";

export class TemporalValidityService {
  constructor(private readonly deps: AssetServiceDependencies) {}

  initialize(input: TemporalInitializeInput): MemoryTemporalValidity {
    if (input.expectedVersion !== 0) throw new Error("temporal validity initialization requires expectedVersion 0");
    this.requireVisibleMemory(input.namespaceId, input.memoryId);
    return this.deps.repositories.transaction(() => {
      if (this.deps.repositories.temporalValidity.get(input.namespaceId, input.memoryId)) {
        throw new Error(`temporal validity already exists for ${input.namespaceId}/${input.memoryId}`);
      }
      const record = this.deps.repositories.temporalValidity.create({
        namespaceId: input.namespaceId,
        memoryId: input.memoryId,
        observedAt: input.observedAt,
        effectiveFrom: input.effectiveFrom,
        effectiveUntil: input.effectiveUntil,
        reviewAfter: input.reviewAfter,
        freshness: "current",
        invalidationKeys: input.invalidationKeys ?? [],
        version: 1
      });
      this.appendAudit(record, "initialized", input, this.deps.now());
      return record;
    });
  }

  review(input: TemporalReviewInput): MemoryTemporalValidity {
    return this.mutate(input, "reviewed", (stored) => ({
      ...stored,
      freshness: "current",
      reviewAfter: input.reviewAfter ?? stored.reviewAfter,
      invalidationKeys: [],
      invalidatedAt: undefined,
      invalidationReason: undefined,
      supersededByMemoryId: undefined,
      lastReviewedAt: input.at
    }));
  }

  invalidate(input: TemporalInvalidateInput): MemoryTemporalValidity {
    return this.mutate(input, "invalidated", (stored) => ({
      ...stored,
      freshness: "stale",
      invalidationKeys: [...input.invalidationKeys],
      invalidatedAt: input.at,
      invalidationReason: input.reason
    }));
  }

  supersede(input: TemporalSupersedeInput): MemoryTemporalValidity {
    if (input.memoryId === input.supersededByMemoryId) throw new Error("memory cannot supersede itself");
    this.requireVisibleMemory(input.namespaceId, input.supersededByMemoryId);
    this.assertAcyclic(input.namespaceId, input.memoryId, input.supersededByMemoryId);
    return this.mutate(input, "superseded", (stored) => ({
      ...stored,
      freshness: "superseded",
      supersededByMemoryId: input.supersededByMemoryId
    }));
  }

  project(namespaceId: string, memoryId: string, options: TemporalProjectionOptions): TemporalProjection | undefined {
    const stored = this.deps.repositories.temporalValidity.get(namespaceId, memoryId);
    if (!stored) return undefined;
    if (!options.scopeActive || this.hasEnded(stored, options.at)) {
      return { view: "historical_evidence", freshness: "historical", eligible: false };
    }
    if (stored.freshness === "stale" || stored.freshness === "superseded" || stored.freshness === "historical") {
      return { view: "historical_evidence", freshness: stored.freshness, eligible: false };
    }
    const signals = new Set(options.invalidationSignals ?? []);
    if (stored.invalidationKeys.some((key) => signals.has(key))) {
      return { view: "historical_evidence", freshness: "stale", eligible: false };
    }
    if (stored.reviewAfter && options.at >= stored.reviewAfter) {
      return { view: "review_queue", freshness: "review_due", eligible: false };
    }
    return { view: "current_truth", freshness: "current", eligible: true };
  }

  private mutate(
    input: TemporalMutationInput,
    type: TemporalEventType,
    change: (stored: MemoryTemporalValidity) => MemoryTemporalValidity
  ): MemoryTemporalValidity {
    this.requireVisibleMemory(input.namespaceId, input.memoryId);
    return this.deps.repositories.transaction(() => {
      const stored = this.deps.repositories.temporalValidity.get(input.namespaceId, input.memoryId);
      if (!stored) throw new Error(`temporal validity not found for ${input.namespaceId}/${input.memoryId}`);
      const updated = this.deps.repositories.temporalValidity.update(
        input.namespaceId,
        input.memoryId,
        input.expectedVersion,
        change(stored)
      );
      this.appendAudit(updated, type, input, input.at);
      return updated;
    });
  }

  private appendAudit(
    record: MemoryTemporalValidity,
    type: TemporalEventType,
    input: TemporalAuditInput,
    createdAt: string
  ): MemoryTemporalValidityEvent {
    return this.deps.repositories.temporalValidity.appendEvent({
      id: this.deps.id("temporal_event"),
      namespaceId: record.namespaceId,
      memoryId: record.memoryId,
      validityVersion: record.version,
      type,
      actor: input.actor,
      reason: input.reason,
      evidenceIds: [...input.evidenceIds],
      projectStateRef: { ...input.projectStateRef },
      createdAt
    });
  }

  private requireVisibleMemory(namespaceId: string, memoryId: string): void {
    const memory = this.deps.repositories.memories.get(memoryId);
    if (!memory || namespaceIdFromContext(namespaceForMemory(memory)) !== namespaceId) {
      throw new Error(`memory ${memoryId} is not visible in namespace ${namespaceId}`);
    }
  }

  private assertAcyclic(namespaceId: string, sourceMemoryId: string, targetMemoryId: string): void {
    const visited = new Set<string>();
    let currentId: string | undefined = targetMemoryId;
    while (currentId) {
      if (currentId === sourceMemoryId) throw new Error("supersession would create a cycle");
      if (visited.has(currentId)) throw new Error("existing supersession chain contains a cycle");
      visited.add(currentId);
      currentId = this.deps.repositories.temporalValidity.get(namespaceId, currentId)?.supersededByMemoryId;
    }
  }

  private hasEnded(record: MemoryTemporalValidity, at: string): boolean {
    return Boolean((record.effectiveFrom && at < record.effectiveFrom) || (record.effectiveUntil && at >= record.effectiveUntil));
  }
}
