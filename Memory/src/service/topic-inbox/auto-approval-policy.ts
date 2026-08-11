import type { TopicCandidateAnalysis } from "./topic-inbox-types.js";

const POLICY_VERSION = "topic-auto-l2-v1";
const SUCCESSFUL_VERIFICATION = /\b(pass(?:ed|es)?|success(?:ful|fully)?|verified|green|exit(?:ed)?\s+0)\b/i;

export interface AutoApprovalDecision {
  approved: boolean;
  policyVersion: string;
  rejectionReasons: string[];
}

export function evaluateTopicAutoApproval(candidate: TopicCandidateAnalysis): AutoApprovalDecision {
  const rejectionReasons: string[] = [];
  if (candidate.proposedLayer !== "L2") rejectionReasons.push("layer_not_l2");
  if (candidate.risk !== "low") rejectionReasons.push("risk_not_low");
  if (candidate.confidence !== "high") rejectionReasons.push("confidence_not_high");
  if (candidate.verificationStatus !== "verified") rejectionReasons.push("not_verified");
  if (!candidate.verificationEvidence.trim() || !SUCCESSFUL_VERIFICATION.test(candidate.verificationEvidence)) rejectionReasons.push("missing_successful_verification_evidence");
  if (candidate.conflicts.length) rejectionReasons.push("conflicts_present");
  if (candidate.sensitiveCategories.length) rejectionReasons.push("sensitive_category");
  return { approved: rejectionReasons.length === 0, policyVersion: POLICY_VERSION, rejectionReasons };
}
