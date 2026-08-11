import type {
  MemoryRow,
  ProjectTopicCandidateRecord,
  ProjectTopicEvidenceRecord,
  ProjectTopicRecord,
  RuntimeNamespace
} from "../../types.js";

export type TopicRisk = "low" | "medium" | "high";
export type TopicConfidence = "low" | "medium" | "high";
export type TopicVerificationStatus = "unverified" | "failed" | "verified";

export interface TopicCandidateAnalysis {
  title: string;
  conclusion: string;
  proposedLayer: "L2" | "L3" | "Skill";
  risk: TopicRisk;
  confidence: TopicConfidence;
  verificationStatus: TopicVerificationStatus;
  verificationEvidence: string;
  sourceEvidenceIds: string[];
  conflicts: string[];
  sensitiveCategories: string[];
}

export interface TopicAnalysisResult {
  topic: { title: string; summary: string };
  candidates: TopicCandidateAnalysis[];
}

export interface TopicMatch {
  topic?: ProjectTopicRecord;
  roles: Array<"error" | "fix" | "verification" | "evidence">;
  confidence: "assigned" | "ambiguous" | "new";
}

export interface TopicInboxQuery {
  statuses?: ProjectTopicCandidateRecord["status"][];
}

export interface TopicInboxItem {
  topic: ProjectTopicRecord;
  evidence: ProjectTopicEvidenceRecord[];
  candidates: ProjectTopicCandidateRecord[];
}

export interface TopicInboxView { topics: TopicInboxItem[] }
export interface TopicIngestResult { assigned: boolean; unchanged: boolean; topicId?: string; candidateIds: string[] }
export interface TopicRefreshResult { jobId: string; unchanged: boolean }
export interface TopicCandidateDecision { decision: "approve" | "reject" | "defer"; reason?: string }
export interface TopicDecisionResult { candidate: ProjectTopicCandidateRecord; memory?: MemoryRow }

export interface ProjectTopicInbox {
  ingest(memoryId: string): Promise<TopicIngestResult>;
  list(namespace: RuntimeNamespace, query?: TopicInboxQuery): TopicInboxView;
  decide(namespace: RuntimeNamespace, candidateId: string, decision: TopicCandidateDecision): Promise<TopicDecisionResult>;
  refresh(namespace: RuntimeNamespace): Promise<TopicRefreshResult>;
}
