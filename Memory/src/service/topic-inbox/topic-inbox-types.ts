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
  stableKey?: string;
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
export type TopicCandidateDecision =
  | { action: "approve"; expectedVersion: number; actor?: Record<string, unknown> }
  | { action: "edit_and_approve"; expectedVersion: number; title: string; conclusion: string; proposedLayer: "L2" | "L3" | "Skill"; actor?: Record<string, unknown> }
  | { action: "reject" | "defer"; expectedVersion: number; reason?: string; actor?: Record<string, unknown> };
export interface TopicDecisionResult { candidate: ProjectTopicCandidateRecord; memory?: MemoryRow; auditId: string }
export interface TopicMergeResult { topic: ProjectTopicRecord; mergedTopicId: string; auditId: string }
export interface TopicSplitResult { topic: ProjectTopicRecord; sourceTopic: ProjectTopicRecord; auditId: string }
export interface TopicEvidenceResult { topicId: string; items: Array<ProjectTopicEvidenceRecord & { rawText: string }>; total: number; limit: number }

export interface ProjectTopicInbox {
  ingest(memoryId: string): Promise<TopicIngestResult>;
  list(namespace: RuntimeNamespace, query?: TopicInboxQuery): TopicInboxView;
  decide(namespace: RuntimeNamespace, candidateId: string, decision: TopicCandidateDecision): Promise<TopicDecisionResult>;
  refresh(namespace: RuntimeNamespace): Promise<TopicRefreshResult>;
}
