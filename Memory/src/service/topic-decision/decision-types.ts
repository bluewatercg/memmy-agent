import type { RuntimeNamespace, TopicActionProposalRecord, TopicAgentPositionRecord, TopicAgentSpec, TopicDebateRoundRecord, TopicEvidenceRequestRecord, TopicExecutionRunRecord } from "../../types.js";

export type TopicAgentRole = "evidence_analyst" | "domain_analyst" | "risk_challenger" | "action_planner" | "specialist";

export interface TopicDecisionStartInput {
  namespace: RuntimeNamespace;
  topicId: string;
  agents?: TopicAgentSpec[];
  adapterId?: string;
  requestId?: string;
}

export interface TopicDecisionStartResult {
  session: {
    id: string;
    namespaceId: string;
    topicId: string;
    inputHash: string;
    state: string;
    version: number;
    metadata: Record<string, unknown>;
    createdAt: string;
    updatedAt: string;
  };
  snapshot: {
    id: string;
    namespaceId: string;
    sessionId: string;
    round: number;
    payload: {
      topicVersion: number;
      evidenceIds: string[];
      evidenceHashes: Record<string, string>;
      evidenceContent: Record<string, string>;
      projectConstraints: Array<Record<string, unknown>>;
      roster: TopicAgentSpec[];
      inputHash: string;
    };
    createdAt: string;
  };
  reused: boolean;
}

export interface TopicDecisionDetail {
  session: TopicDecisionStartResult["session"];
  snapshots: TopicDecisionStartResult["snapshot"][];
  positions?: TopicAgentPositionRecord[];
  debateRounds?: TopicDebateRoundRecord[];
  evidenceRequests?: TopicEvidenceRequestRecord[];
  proposals?: TopicActionProposalRecord[];
  executionRuns?: TopicExecutionRunRecord[];
}