import { traceMetaFromMemory } from "../../algorithm/plugin-algorithms.js";
import type { MemoryRow } from "../../types.js";
import type { TopicCandidateAnalysis } from "./topic-inbox-types.js";

const POLICY_VERSION = "topic-auto-l2-v2";
const NEVER_AUTOMATIC = /\b(security|secure|destructive|delete|remove|drop|release|deploy|publish|credential|secret|token|api[ _-]?key|access[ _-]?control|permission|authorization|authentication|migration|schema)\b/i;
const NEGATED_SUCCESS = /\b(not|never|no|didn['’]?t|failed to|unable to)\b.{0,30}\b(pass(?:ed)?|success(?:ful)?|verif(?:y|ied))\b/i;

export interface AutoApprovalDecision {
  approved: boolean;
  policyVersion: string;
  rejectionReasons: string[];
  verifiedEvidenceIds: string[];
}

export function evaluateTopicAutoApproval(candidate: TopicCandidateAnalysis, evidence: MemoryRow[]): AutoApprovalDecision {
  const rejectionReasons: string[] = [];
  if (candidate.proposedLayer !== "L2") rejectionReasons.push("layer_not_l2");
  if (candidate.risk !== "low") rejectionReasons.push("risk_not_low");
  if (candidate.confidence !== "high") rejectionReasons.push("confidence_not_high");
  if (candidate.verificationStatus !== "verified") rejectionReasons.push("model_verification_not_verified");
  if (candidate.conflicts.length) rejectionReasons.push("model_conflicts_present");
  if (candidate.sensitiveCategories.length) rejectionReasons.push("model_sensitive_category");

  const cited = evidence.filter((memory) => candidateEvidenceIds(candidate).includes(memory.id));
  if (!cited.length) rejectionReasons.push("missing_cited_source_evidence");
  const verifiedEvidenceIds: string[] = [];
  for (const memory of cited) {
    const trace = traceMetaFromMemory(memory);
    const text = `${memory.memoryValue}\n${trace?.summary ?? ""}\n${trace?.reflection ?? ""}`;
    if (NEVER_AUTOMATIC.test(text)) rejectionReasons.push("never_auto_evidence_class");
    if (NEGATED_SUCCESS.test(text) || trace?.toolCalls.some((call) => call.success === false || Boolean(call.error))) rejectionReasons.push("failed_or_mixed_evidence");
    const successfulTool = trace?.toolCalls.some((call) => call.success === true && !call.error && call.output !== undefined) ?? false;
    const structuredVerified = memory.info.verification_status === "verified" && memory.info.verification_passed === true;
    if (successfulTool || structuredVerified) verifiedEvidenceIds.push(memory.id);
  }
  if (!verifiedEvidenceIds.length) rejectionReasons.push("missing_persisted_successful_verification");
  if (NEVER_AUTOMATIC.test(candidate.title) || NEVER_AUTOMATIC.test(candidate.conclusion)) rejectionReasons.push("never_auto_candidate_class");
  return { approved: rejectionReasons.length === 0, policyVersion: POLICY_VERSION, rejectionReasons: [...new Set(rejectionReasons)], verifiedEvidenceIds };
}

function candidateEvidenceIds(candidate: TopicCandidateAnalysis): string[] {
  const value = candidate as TopicCandidateAnalysis & { sourceEvidenceIds?: unknown };
  return Array.isArray(value.sourceEvidenceIds) ? value.sourceEvidenceIds.filter((item): item is string => typeof item === "string") : [];
}
