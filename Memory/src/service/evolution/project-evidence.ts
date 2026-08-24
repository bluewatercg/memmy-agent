import type { ToolCallPayload } from "../../types.js";
import { stableHash, stableStringify } from "../../utils/id.js";

export type ProjectEvidenceKind = "fact" | "decision" | "procedure" | "outcome" | "noise";
export type MemoryCandidateType = "fact" | "decision" | "policy" | "avoidance" | "pure_process" | "noise";
export type EvidenceVerification = "tool_verified" | "user_asserted" | "agent_inferred" | "unverified";
export type EvidenceRisk = "low" | "medium" | "high";
export type EvidenceActivation = "active_memory" | "review_candidate" | "rejected";

export interface ProjectEvidence {
  kind: ProjectEvidenceKind;
  candidateType: MemoryCandidateType;
  verification: EvidenceVerification;
  risk: EvidenceRisk;
  activation: EvidenceActivation;
  eligible: boolean;
  confidence: number;
  subject: string;
  claim: string;
  sourceText: string;
  stableKey: string;
  evidenceIds: string[];
  reasons: string[];
}

export interface ProjectEvidenceInput {
  id: string;
  userText?: string;
  agentText?: string;
  reflection?: string | null;
  toolCalls?: ToolCallPayload[];
  tags?: string[];
  value?: number;
}

const INJECTED_CONTEXT_RE = /<\/?(?:codex_internal_context|memmy_memory_context|objective|current_user_request)\b/i;
const CHILD_AGENT_RE = /(?:focused child agent|spawned by a parent agent|child-agent instruction|subagent instruction)/i;
const META_NOISE_RE = /^(?:continue|keep working|go on|看看|继续|再看看|有了吗|什么情况|下一步(?:怎么|是什么)?工作|下一步什么工作|the next task is to continue)\s*[?？!！。.]?$/i;
const USER_PROCESS_NOISE_RE = /(?:看看|检查|查看|阅读|调研|考虑|比较|look at|inspect|read|explore|consider|compare)/i;
const QUESTION_RE = /[?？]\s*$/;
const RESULT_RE = /(?:成功|失败|通过|报错|error|failed|passed|fixed|修复|完成|created|updated|deleted|exit code|status\s*[:=])/i;
const PROCEDURE_RE = /(?:run|执行|使用|调用|install|测试|部署|重启|patch|修改|命令|procedure|步骤|must|should|不要|必须)/i;
const DECISION_RE = /(?:we (?:will|decided)|adopt|采用|决定|约定|规范|架构事实)/i;
const AVOIDANCE_RE = /(?:do not|don't|never|avoid|must not|should not|不要|不得|禁止|避免)/i;
const POLICY_RE = /(?:always|whenever|when\b|before|after|must|should|每次|始终|当.+时|之前|之后|必须|应当)/i;
const PURE_PROCESS_RE = /(?:inspect|read|look at|explore|consider|compare|检查|查看|阅读|调研|考虑|比较)/i;
const DESTRUCTIVE_RE = /(?:rm\s+-rf|delete (?:the )?(?:database|repository)|drop\s+(?:database|table)|reset\s+--hard|force[- ]?push|清空数据库|删除(?:数据库|仓库)|强制推送)/i;

export function extractProjectEvidence(input: ProjectEvidenceInput): ProjectEvidence {
  const user = normalize(input.userText);
  const agent = normalize(input.agentText);
  const reflection = normalize(input.reflection);
  const tools = input.toolCalls ?? [];
  const reasons: string[] = [];
  const sourceText = [user && `USER: ${user}`, agent && `AGENT: ${agent}`, reflection && `REFLECTION: ${reflection}`]
    .filter(Boolean)
    .join("\n");
  const combined = `${user}\n${agent}\n${reflection}`;
  const toolVerified = tools.some((tool) => tool.success !== false && !tool.error && tool.output !== undefined);
  const hasResult = RESULT_RE.test(`${agent}\n${reflection}`) || toolVerified;

  let candidateType: MemoryCandidateType;
  if (!sourceText || INJECTED_CONTEXT_RE.test(sourceText)) {
    reasons.push("injected_or_empty");
    candidateType = "noise";
  } else if (CHILD_AGENT_RE.test(sourceText)) {
    reasons.push("agent_instruction_noise");
    candidateType = "noise";
  } else if ((META_NOISE_RE.test(user) || USER_PROCESS_NOISE_RE.test(user) || QUESTION_RE.test(user)) && !agent && tools.length === 0 && !reflection) {
    reasons.push("question_or_meta_noise");
    candidateType = "noise";
  } else if (DECISION_RE.test(combined)) {
    candidateType = "decision";
  } else if (/^IRRELEVANT$/i.test(reflection)) {
    candidateType = "pure_process";
    reasons.push("reflection_not_reusable");
  } else if (AVOIDANCE_RE.test(combined)) {
    candidateType = "avoidance";
  } else if (POLICY_RE.test(combined) || PROCEDURE_RE.test(combined)) {
    candidateType = "policy";
  } else if (hasResult) {
    candidateType = "fact";
  } else if (!hasResult && PURE_PROCESS_RE.test(combined)) {
    candidateType = "pure_process";
    reasons.push("process_without_reusable_verified_result");
  } else {
    candidateType = "fact";
  }

  const verification: EvidenceVerification = toolVerified
    ? "tool_verified"
    : user && !agent
      ? "user_asserted"
      : agent || reflection
        ? "agent_inferred"
        : "unverified";
  const risk: EvidenceRisk = DESTRUCTIVE_RE.test(combined)
    ? "high"
    : candidateType === "decision"
      ? "medium"
      : "low";
  let activation: EvidenceActivation = "rejected";
  if (candidateType === "decision") {
    activation = "review_candidate";
    reasons.push("decision_requires_authoritative_review");
  } else if ((candidateType === "policy" || candidateType === "avoidance") && risk === "low" && verification === "tool_verified") {
    activation = "active_memory";
  } else if (candidateType === "fact" && risk === "low" && (verification === "tool_verified" || verification === "user_asserted")) {
    activation = "active_memory";
  } else if ((candidateType === "policy" || candidateType === "avoidance") && risk !== "high") {
    activation = "review_candidate";
    reasons.push("reusable_rule_requires_verification");
  } else if (risk === "high") {
    reasons.push("high_risk_automation_blocked");
  }

  const eligible = activation === "active_memory";
  const confidence = candidateType === "noise" || candidateType === "pure_process"
    ? 0
    : verification === "tool_verified"
      ? 0.9
      : verification === "user_asserted"
        ? 0.8
        : 0.6;
  const kind: ProjectEvidenceKind = candidateType === "noise" || candidateType === "pure_process"
    ? "noise"
    : candidateType === "decision"
      ? "decision"
      : hasResult
        ? "outcome"
        : candidateType === "policy" || candidateType === "avoidance"
          ? "procedure"
          : "fact";
  const claim = normalize(agent || user);
  const subject = normalize(user).slice(0, 160);
  const stableKey = `evidence:${stableHash(stableStringify({ candidateType, subject, claim }))}`;
  return {
    kind,
    candidateType,
    verification,
    risk,
    activation,
    eligible,
    confidence,
    subject,
    claim,
    sourceText,
    stableKey,
    evidenceIds: [input.id],
    reasons
  };
}

function normalize(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}
