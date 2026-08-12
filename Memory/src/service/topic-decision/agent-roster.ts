import type { TopicAgentSpec } from "../../types.js";
import type { TopicAgentRole } from "./decision-types.js";

const DEFAULT_ROLES: TopicAgentRole[] = [
  "evidence_analyst",
  "domain_analyst",
  "risk_challenger",
  "action_planner"
];

export function recommendAgents(
  models: string[],
  topicMetadata?: Record<string, unknown>
): TopicAgentSpec[] {
  const available = models.length > 0 ? models : ["default-model"];
  const agents: TopicAgentSpec[] = [];
  let modelIndex = 0;

  for (const role of DEFAULT_ROLES) {
    agents.push({
      id: `agent-${role}`,
      role,
      model: available[modelIndex % available.length],
      reason: ""
    });
    modelIndex++;
  }

  const specialist = extractSpecialist(topicMetadata);
  if (specialist) {
    agents.push({
      id: `agent-specialist-${specialist}`,
      role: "specialist",
      model: available[modelIndex % available.length],
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