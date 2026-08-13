import type { TopicAgentSpec } from "../../types.js";
import type { TopicAgentRole } from "./decision-types.js";

/** Default four-model roster from environment contract (task-2). */
export const DEFAULT_TOPIC_DECISION_MODELS = [
  "MiniMax-M2.5",
  "qwen3.7-plus",
  "kimi-k2.5",
  "glm-5"
] as const;

const DEFAULT_ROLES: TopicAgentRole[] = [
  "evidence_analyst",
  "domain_analyst",
  "risk_challenger",
  "action_planner"
];

function safeGetModel(models: string[], index: number): string {
  // With noUncheckedIndexedAccess, array access returns T | undefined.
  // models is non-empty (guaranteed by caller), so we assert definedness.
  return models[index] as string;
}

export function recommendAgents(
  models: string[],
  topicMetadata?: Record<string, unknown>
): TopicAgentSpec[] {
  // Caller must provide models; fallback to default four-model roster if empty/undefined
  const rosterModels: string[] = models.length > 0 ? models : [...DEFAULT_TOPIC_DECISION_MODELS];
  const agents: TopicAgentSpec[] = [];

  for (let i = 0; i < DEFAULT_ROLES.length; i++) {
    const role: string = DEFAULT_ROLES[i] as string;
    const model: string = safeGetModel(rosterModels, i % rosterModels.length);
    agents.push({
      id: `agent-${role}`,
      role,
      model,
      reason: ""
    });
  }

  const specialist = extractSpecialist(topicMetadata);
  if (specialist) {
    const model: string = safeGetModel(rosterModels, DEFAULT_ROLES.length % rosterModels.length);
    agents.push({
      id: `agent-specialist-${specialist}`,
      role: "specialist",
      model,
      reason: `topic requires ${specialist} expertise`
    });
  }

  // Dedupe role-model pairs without reason
  const seen = new Set<string>();
  return agents.filter((agent) => {
    const key = `${agent.role}:${agent.model}`;
    if (!agent.reason || agent.reason.trim() === "") {
      if (seen.has(key)) return false;
      seen.add(key);
    }
    return true;
  });
}

function extractSpecialist(metadata?: Record<string, unknown>): string | null {
  if (!metadata || typeof metadata.specialist !== "string") return null;
  return metadata.specialist.trim() || null;
}