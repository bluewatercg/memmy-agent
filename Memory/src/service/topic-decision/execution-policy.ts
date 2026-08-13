import type { TopicActionEffect } from "../../types.js";

export type TopicActionPolicyDecision =
  | { mode: "automatic" }
  | { mode: "confirmation_required"; reason: string }
  | { mode: "forbidden"; reason: string };

const AUTOMATIC_EFFECTS: Set<TopicActionEffect> = new Set([
  "read",
  "analyze",
  "draft",
  "create_candidate_task"
]);

const CONFIRMATION_EFFECTS: Set<TopicActionEffect> = new Set([
  "authoritative_write",
  "external_write",
  "delete",
  "topic_mutation",
  "memory_promotion"
]);

/**
 * Irreversible effects require a separately recorded second confirmation
 * before execution. Defined by the policy contract:
 * delete, topic_mutation, memory_promotion, authoritative_write, external_write.
 */
export const IRREVERSIBLE_EFFECTS: Set<TopicActionEffect> = new Set([
  "delete",
  "topic_mutation",
  "memory_promotion",
  "authoritative_write",
  "external_write"
]);

/**
 * Returns true if the effect is irreversible and requires two confirmations.
 */
export function isIrreversibleEffect(effect: TopicActionEffect): boolean {
  return IRREVERSIBLE_EFFECTS.has(effect);
}

const ALL_KNOWN_EFFECTS: Set<TopicActionEffect> = new Set([
  ...AUTOMATIC_EFFECTS,
  ...CONFIRMATION_EFFECTS
]);

export interface PolicyMetadata {
  recoveryPoint?: string;
  acceptanceCondition?: string;
}

/**
 * Evaluate the execution policy for a proposed action effect.
 * - Automatic effects (read, analyze, draft, create_candidate_task) can execute immediately
 *   if they have a recovery point and acceptance condition.
 * - Confirmation effects (authoritative_write, external_write, delete, topic_mutation, memory_promotion)
 *   require explicit human confirmation before execution.
 * - Unknown effects are forbidden.
 * - Actions lacking a recovery point or acceptance condition cannot be automatic.
 */
export function evaluateExecutionPolicy(
  effect: TopicActionEffect,
  metadata: PolicyMetadata
): TopicActionPolicyDecision {
  if (!ALL_KNOWN_EFFECTS.has(effect)) {
    return { mode: "forbidden", reason: `unknown effect: ${effect}` };
  }

  const hasRecoveryPoint = metadata.recoveryPoint && metadata.recoveryPoint.trim().length > 0;
  const hasAcceptanceCondition = metadata.acceptanceCondition && metadata.acceptanceCondition.trim().length > 0;

  if (!hasRecoveryPoint) {
    return { mode: "forbidden", reason: "action lacks recovery point" };
  }

  if (!hasAcceptanceCondition) {
    return { mode: "forbidden", reason: "action lacks acceptance condition" };
  }

  if (AUTOMATIC_EFFECTS.has(effect)) {
    return { mode: "automatic" };
  }

  if (CONFIRMATION_EFFECTS.has(effect)) {
    const irreversible = isIrreversibleEffect(effect);
    return {
      mode: "confirmation_required",
      reason: irreversible
        ? `effect ${effect} is irreversible; requires two separate confirmations`
        : `effect ${effect} has external impact; requires explicit confirmation`
    };
  }

  return { mode: "forbidden", reason: `unhandled effect: ${effect}` };
}
