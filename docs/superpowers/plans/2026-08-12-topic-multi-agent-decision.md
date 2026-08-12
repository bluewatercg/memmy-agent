# Topic Multi-Agent Decision Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn each project topic into a bounded, auditable multi-agent decision session that asks for missing evidence, produces at most three action proposals, and executes only approved reversible work.

**Architecture:** Add a deep `topic-decision` module beside the existing Topic Inbox. It owns immutable evidence snapshots, role-based agent positions, adaptive three-round debate, evidence requests, synthesis, proposal approval, and policy-gated execution. Persist normalized decision state in SQLite, expose namespace-scoped HTTP operations through `MemoryService`, and render an action-first decision surface in the existing Docker Web Console.

**Tech Stack:** TypeScript 6, Node.js 24, better-sqlite3, Vitest 4, existing `LlmClient`, Memory `Repositories`, Memory HTTP server, static Web Console

## Global Constraints

- The feature is disabled by default behind `MEMMY_TOPIC_DECISIONS_ENABLED=false` until rollout.
- A session belongs to one canonical namespace and one topic version.
- Round one is independent and immutable; no agent may read another first-round position.
- Round two targets explicit conflicts; round three runs only for unresolved high-risk conflict; round four is impossible.
- Every factual model claim cites evidence IDs from the active snapshot; assumptions remain separate from facts.
- Blocking evidence gaps prevent an approvable proposal.
- Automatic evidence acquisition runs before asking the person; at most three deduplicated questions are exposed.
- User goals, preferences, business rules, and constraints are authoritative. Externally verifiable user claims remain `user_supplied_unverified` until corroborated.
- Synthesis produces zero to three proposals and never hides unresolved high-risk disagreement.
- Proposal approval is always human and versioned.
- Automatic execution uses an explicit reversible-action allowlist. Applying code/configuration, authoritative writes, external writes, deletion, topic merge/split, and higher-layer Memory approval always require a second confirmation.
- Topic or evidence mutation marks prior proposals stale and stops not-yet-started actions.
- Every repository query includes `namespaceId`; every mutation uses optimistic versioning or a deterministic idempotency key.
- No credentials, hidden prompts, raw provider responses, or sensitive evidence enter metrics or list responses.

---

### Task 1: Decision Persistence And Repository

**Files:**
- Modify: `Memory/src/storage/schema.ts`
- Modify: `Memory/src/storage/repositories.ts`
- Modify: `Memory/src/storage/backend.ts`
- Modify: `Memory/src/types.ts`
- Modify: `Memory/tests/repository/sqlite-schema.test.ts`
- Create: `Memory/tests/repository/topic-decision-repository.test.ts`

**Interfaces:**
- Produces: `TopicDecisionSessionRecord`, `TopicDecisionSnapshotRecord`, `TopicAgentPositionRecord`, `TopicDebateRoundRecord`, `TopicEvidenceRequestRecord`, `TopicActionProposalRecord`, `TopicExecutionRunRecord`, and `TopicDecisionRepository`.
- Invariant: first-round positions and snapshot payloads are immutable; mutable records use `version` with compare-and-swap.

- [ ] **Step 1: Write failing schema migration tests**

Require schema version `8`, migration ID `008_topic_decisions`, and these normalized tables:

```text
project_topic_decision_sessions
project_topic_decision_snapshots
project_topic_agent_positions
project_topic_debate_rounds
project_topic_evidence_requests
project_topic_action_proposals
project_topic_execution_runs
```

Assert all tables appear in a fresh database and an existing schema-v7 fixture upgrades without changing topic rows.

- [ ] **Step 2: Write failing repository contract tests**

Test the following signatures and behavior:

```ts
interface TopicDecisionRepository {
  createSession(input: TopicDecisionSessionRecord): TopicDecisionSessionRecord;
  findReusableSession(namespaceId: string, topicId: string, inputHash: string): TopicDecisionSessionRecord | undefined;
  getSession(namespaceId: string, sessionId: string): TopicDecisionSessionRecord | undefined;
  updateSession(next: TopicDecisionSessionRecord, expectedVersion: number): TopicDecisionSessionRecord;
  insertSnapshot(snapshot: TopicDecisionSnapshotRecord): TopicDecisionSnapshotRecord;
  getSnapshot(namespaceId: string, snapshotId: string): TopicDecisionSnapshotRecord | undefined;
  insertPosition(position: TopicAgentPositionRecord): TopicAgentPositionRecord;
  listPositions(namespaceId: string, sessionId: string, snapshotId: string): TopicAgentPositionRecord[];
  upsertRound(round: TopicDebateRoundRecord, expectedVersion?: number): TopicDebateRoundRecord;
  listRounds(namespaceId: string, sessionId: string): TopicDebateRoundRecord[];
  upsertEvidenceRequest(request: TopicEvidenceRequestRecord, expectedVersion?: number): TopicEvidenceRequestRecord;
  listEvidenceRequests(namespaceId: string, sessionId: string): TopicEvidenceRequestRecord[];
  insertProposal(proposal: TopicActionProposalRecord): TopicActionProposalRecord;
  listProposals(namespaceId: string, sessionId: string): TopicActionProposalRecord[];
  updateProposal(next: TopicActionProposalRecord, expectedVersion: number): TopicActionProposalRecord;
  createExecutionRun(run: TopicExecutionRunRecord): TopicExecutionRunRecord;
  updateExecutionRun(next: TopicExecutionRunRecord, expectedVersion: number): TopicExecutionRunRecord;
}
```

Cover namespace exclusion, reusable-session uniqueness by `(namespace_id, topic_id, input_hash)`, immutable duplicate position rejection by `(session_id, snapshot_id, round, agent_id)`, proposal rank limited to `1..3`, optimistic conflicts, JSON validity, and cascade cleanup only when a session is explicitly deleted.

- [ ] **Step 3: Run RED tests**

```bash
cd Memory
npx vitest run tests/repository/sqlite-schema.test.ts tests/repository/topic-decision-repository.test.ts
```

Expected: FAIL because schema v8 and `TopicDecisionRepository` do not exist.

- [ ] **Step 4: Implement records, schema, and repository**

Use discriminated string unions rather than free-form states:

```ts
type TopicDecisionState =
  | "draft" | "gathering_evidence" | "debating" | "ready_for_decision"
  | "awaiting_user_input" | "blocked_by_evidence" | "executing"
  | "completed" | "stale" | "failed" | "cancelled";

type TopicEvidenceVerification =
  | "repository_verified" | "tool_verified" | "user_authoritative"
  | "user_supplied_unverified" | "contradicted";

type TopicActionEffect = "read" | "analyze" | "draft" | "create_candidate_task" | "authoritative_write" | "external_write" | "delete" | "topic_mutation" | "memory_promotion";
```

Store bounded structured arrays in checked JSON columns; keep queryable state, versions, rank, round, namespace, topic, and timestamps in columns. Register `topicDecisions` on `Repositories`. Add all seven tables to namespace-aware bundle export/import only after repository tests prove round-trip isolation.

- [ ] **Step 5: Run GREEN tests and commit**

```bash
cd Memory
npx vitest run tests/repository/sqlite-schema.test.ts tests/repository/topic-decision-repository.test.ts tests/repository/bundle.test.ts
```

Expected: PASS. Commit:

```bash
git add Memory/src/storage Memory/src/types.ts Memory/tests/repository
git commit -m "feat(memory): persist topic decision sessions"
```

### Task 2: Feature Flag, Roster Recommendation, And Evidence Snapshots

**Files:**
- Modify: `Memory/src/config/index.ts`
- Modify: `.env.example`
- Modify: `compose.yaml`
- Create: `Memory/src/service/topic-decision/decision-types.ts`
- Create: `Memory/src/service/topic-decision/agent-roster.ts`
- Create: `Memory/src/service/topic-decision/evidence-snapshot.ts`
- Create: `Memory/src/service/topic-decision/topic-decision-service.ts`
- Modify: `Memory/src/service/memory-service.ts`
- Modify: `Memory/tests/config.test.ts`
- Create: `Memory/tests/service/topic-decision/session-start.test.ts`

**Interfaces:**
- Consumes: `TopicDecisionRepository` from Task 1 and existing topic/evidence/project-context repositories.
- Produces:

```ts
type TopicAgentRole = "evidence_analyst" | "domain_analyst" | "risk_challenger" | "action_planner" | "specialist";
interface TopicAgentSpec { id: string; role: TopicAgentRole; model: string; reason: string; }
interface TopicDecisionStartInput { namespace: RuntimeNamespace; topicId: string; agents?: TopicAgentSpec[]; }
interface TopicDecisionStartResult { session: TopicDecisionSessionRecord; snapshot: TopicDecisionSnapshotRecord; reused: boolean; }

class TopicDecisionService {
  recommendAgents(namespace: RuntimeNamespace, topicId: string): TopicAgentSpec[];
  start(input: TopicDecisionStartInput): TopicDecisionStartResult;
  read(namespace: RuntimeNamespace, sessionId: string): TopicDecisionDetail;
}
```

- [ ] **Step 1: Write failing configuration and roster tests**

Require:

```text
MEMMY_TOPIC_DECISIONS_ENABLED=false
MEMMY_TOPIC_DECISION_MODELS=MiniMax-M2.5,qwen3.7-plus,kimi-k2.5,glm-5
```

Test trim/dedupe behavior. Verify recommendation returns four default roles in stable order, adds at most one `specialist` from topic signals, returns three to five agents, and never duplicates `(role, model)` without a non-empty reason.

- [ ] **Step 2: Write failing snapshot and session tests**

Build a topic with evidence and active project-context constraints. Assert the snapshot contains topic version, evidence IDs/content hashes, bounded evidence text, project constraints, roster, and deterministic `inputHash`. Assert:

```ts
start(same namespace + topic version + evidence + roster) => reused: true
start(changed evidence hash) => new session
start(cross namespace topic) => throws not found
start(flag disabled) => throws feature disabled
```

- [ ] **Step 3: Run RED tests**

```bash
cd Memory
npx vitest run tests/config.test.ts tests/service/topic-decision/session-start.test.ts
```

Expected: FAIL on missing config and service.

- [ ] **Step 4: Implement roster and frozen snapshots**

`agent-roster.ts` maps existing topic metadata signals to an optional specialist role without an LLM call. `evidence-snapshot.ts` reads only repository-backed sources in this task and hashes canonical JSON with stable key ordering. It must reject missing or cross-namespace evidence rather than silently drop it.

Expose the feature through `MemoryService`, but do not add HTTP routes yet. The service remains unusable when disabled.

- [ ] **Step 5: Run GREEN tests and commit**

```bash
cd Memory
npx vitest run tests/config.test.ts tests/service/topic-decision/session-start.test.ts tests/service/evolution/project-topic-inbox.test.ts
```

Expected: PASS. Commit:

```bash
git add .env.example compose.yaml Memory/src/config Memory/src/service/topic-decision Memory/src/service/memory-service.ts Memory/tests/config.test.ts Memory/tests/service/topic-decision
git commit -m "feat(memory): start frozen topic decision sessions"
```

### Task 3: Independent Positions, Decisionability, And User Evidence

**Files:**
- Create: `Memory/src/service/topic-decision/agent-position.ts`
- Create: `Memory/src/service/topic-decision/decisionability.ts`
- Create: `Memory/src/service/topic-decision/evidence-acquisition.ts`
- Modify: `Memory/src/service/topic-decision/topic-decision-service.ts`
- Create: `Memory/tests/service/topic-decision/agent-position.test.ts`
- Create: `Memory/tests/service/topic-decision/evidence-gaps.test.ts`

**Interfaces:**
- Consumes: active snapshot and roster from Task 2, configured `LlmClient` factory, existing Memory/topic/project-context read repositories.
- Produces:

```ts
interface AgentPositionResult {
  judgment: string;
  confidence: number;
  evidenceIds: string[];
  facts: Array<{ claim: string; evidenceIds: string[] }>;
  assumptions: string[];
  missingInformation: Array<{ key: string; question: string; blocking: boolean; decisionImpact: string }>;
  risks: Array<{ severity: "low" | "medium" | "high"; description: string }>;
  counterarguments: string[];
  suggestedActions: string[];
}

interface EvidenceSource {
  id: string;
  acquire(request: TopicEvidenceRequestRecord, snapshot: TopicDecisionSnapshotRecord): Promise<TopicEvidenceAcquisitionResult>;
}

runIndependentPositions(namespace: RuntimeNamespace, sessionId: string): Promise<TopicDecisionDetail>;
submitEvidenceAnswers(namespace: RuntimeNamespace, sessionId: string, expectedVersion: number, answers: TopicUserEvidenceAnswer[]): Promise<TopicDecisionDetail>;
```

- [ ] **Step 1: Write failing independent-position tests**

Use four deterministic `LlmClient` stubs and capture their inputs. Assert every call receives the same snapshot, no call receives another position, operations are role-specific, calls run independently, one failure is stored as a structured failed position, valid responses cite known evidence IDs, unknown citations fail validation, and rerun reuses persisted successful positions.

- [ ] **Step 2: Write failing decisionability and evidence-question tests**

Cover:

```text
blocking gap -> no debate/proposal; automatic acquisition attempted
repository answer found -> snapshot rebuilt; no user question
unresolved equivalent gaps -> one deduplicated question
four distinct gaps -> only top three by decision impact
user preference -> user_authoritative
user external fact -> user_supplied_unverified
contradicted premise -> blocked_by_evidence
```

Require each surfaced question to contain `question`, `whyNeeded`, and `decisionImpact`.

- [ ] **Step 3: Run RED tests**

```bash
cd Memory
npx vitest run tests/service/topic-decision/agent-position.test.ts tests/service/topic-decision/evidence-gaps.test.ts
```

Expected: FAIL because position parsing and evidence acquisition do not exist.

- [ ] **Step 4: Implement strict position parsing and decisionability gate**

Call agents with `temperature: 0`, JSON mode, and operation `topic.decision.position.<role>`. Parse `unknown` once with type guards. Separate facts from assumptions. Reject unknown evidence citations and confidence outside `[0,1]`.

`decisionability.ts` groups gaps by normalized key, marks the session `gathering_evidence`, invokes built-in read-only `EvidenceSource`s in stable order, then transitions to `awaiting_user_input`, `blocked_by_evidence`, or `debating`. Built-in sources may query existing Memory, topic evidence, and project context only; code/log/tool providers remain optional injected `EvidenceSource`s, not a new generic runtime.

- [ ] **Step 5: Implement answer submission and snapshot invalidation**

Validate that answers address open questions in the same namespace/session. Append provenance, rebuild a snapshot, mark positions from the old snapshot historical, and resume from independent analysis only when the answer changes decision inputs. Use optimistic session versioning.

- [ ] **Step 6: Run GREEN tests and commit**

```bash
cd Memory
npx vitest run tests/service/topic-decision/agent-position.test.ts tests/service/topic-decision/evidence-gaps.test.ts tests/service/topic-decision/session-start.test.ts
```

Expected: PASS. Commit:

```bash
git add Memory/src/service/topic-decision Memory/tests/service/topic-decision
git commit -m "feat(memory): gate topic decisions on evidence"
```

### Task 4: Adaptive Debate And Proposal Synthesis

**Files:**
- Create: `Memory/src/service/topic-decision/debate-orchestrator.ts`
- Create: `Memory/src/service/topic-decision/proposal-synthesis.ts`
- Modify: `Memory/src/service/topic-decision/topic-decision-service.ts`
- Create: `Memory/tests/service/topic-decision/debate.test.ts`
- Create: `Memory/tests/service/topic-decision/proposals.test.ts`

**Interfaces:**
- Consumes: valid current-snapshot positions from Task 3.
- Produces:

```ts
interface TopicConflict {
  id: string;
  severity: "low" | "medium" | "high";
  claim: string;
  positionIds: string[];
  evidenceIds: string[];
  resolved: boolean;
}

runDebate(namespace: RuntimeNamespace, sessionId: string): Promise<TopicDecisionDetail>;
synthesizeProposals(namespace: RuntimeNamespace, sessionId: string): Promise<TopicDecisionDetail>;
```

- [ ] **Step 1: Write failing debate-boundary tests**

Assert round two receives only structured conflicting claims and cited positions. Assert round three runs only when a high-risk conflict remains after round two. Assert low/medium disagreement stops after round two, unresolved high-risk disagreement remains visible, failed responders do not erase prior positions, and every attempt to create round four is rejected.

- [ ] **Step 2: Write failing synthesis tests**

Use a deterministic synthesizer stub. Require zero proposals when a blocking gap exists; otherwise require one to three proposals. Reject output that cites unknown evidence, omits unresolved high-risk conflict, creates rank `4`, marks multiple proposals recommended, or declares an action without effect class, permission, artifact, acceptance condition, and recovery point.

Test a majority-wrong scenario: three agents share one unsupported assumption and `risk_challenger` identifies it. Expected: session remains blocked or proposal explicitly depends on resolving the assumption; majority cannot override it.

- [ ] **Step 3: Run RED tests**

```bash
cd Memory
npx vitest run tests/service/topic-decision/debate.test.ts tests/service/topic-decision/proposals.test.ts
```

Expected: FAIL on missing orchestrator and synthesizer.

- [ ] **Step 4: Implement bounded debate**

Persist a durable round before calling models, then persist each response independently. Derive conflicts deterministically from contradictory judgments, assumptions, risks, and action effects. Use operation names `topic.decision.debate.round2.<role>` and `topic.decision.debate.round3.<role>`. The stop reason is one of:

```ts
type DebateStopReason = "no_material_conflict" | "resolved_after_round2" | "max_rounds" | "blocked_by_evidence" | "insufficient_role_coverage";
```

- [ ] **Step 5: Implement constrained synthesis**

The synthesizer receives current snapshot evidence, current valid positions, and unresolved conflicts. It does not receive raw hidden prompts. Validate all citations and action contracts before one transaction inserts proposals and moves the session to `ready_for_decision`.

- [ ] **Step 6: Run GREEN tests and commit**

```bash
cd Memory
npx vitest run tests/service/topic-decision/debate.test.ts tests/service/topic-decision/proposals.test.ts tests/service/topic-decision/evidence-gaps.test.ts
```

Expected: PASS. Commit:

```bash
git add Memory/src/service/topic-decision Memory/tests/service/topic-decision
git commit -m "feat(memory): synthesize bounded topic decisions"
```

### Task 5: Policy-Gated Proposal Approval And Execution

**Files:**
- Create: `Memory/src/service/topic-decision/execution-policy.ts`
- Create: `Memory/src/service/topic-decision/proposal-executor.ts`
- Modify: `Memory/src/service/topic-decision/topic-decision-service.ts`
- Modify: `Memory/src/service/project-context/project-context-service.ts`
- Create: `Memory/tests/service/topic-decision/execution-policy.test.ts`
- Create: `Memory/tests/service/topic-decision/execution.test.ts`

**Interfaces:**
- Consumes: versioned proposals from Task 4 and existing project-context work-item APIs.
- Produces:

```ts
type TopicActionPolicyDecision = { mode: "automatic" } | { mode: "confirmation_required"; reason: string } | { mode: "forbidden"; reason: string };

approveProposal(namespace: RuntimeNamespace, sessionId: string, proposalId: string, expectedProposalVersion: number, actor: Record<string, unknown>): Promise<TopicExecutionRunRecord>;
resumeExecution(namespace: RuntimeNamespace, runId: string): Promise<TopicExecutionRunRecord>;
confirmExecutionAction(namespace: RuntimeNamespace, runId: string, actionId: string, expectedRunVersion: number, approved: boolean, actor: Record<string, unknown>): Promise<TopicExecutionRunRecord>;
```

- [ ] **Step 1: Write failing policy matrix tests**

Require this exact default policy:

```ts
const automaticEffects = new Set(["read", "analyze", "draft", "create_candidate_task"]);
const confirmationEffects = new Set(["authoritative_write", "external_write", "delete", "topic_mutation", "memory_promotion"]);
```

A proposed patch or config is a `draft`; applying it is `authoritative_write`. Unknown effects are forbidden. An action lacking a recovery point or acceptance condition cannot be automatic.

- [ ] **Step 2: Write failing execution lifecycle tests**

Cover human versioned approval, deterministic run/action idempotency, automatic read/analyze/draft/task creation, pause before confirmation, exact-effect confirmation, rejection cancellation, failure with partial state, resume without repeating successful actions, stale snapshot stopping pending actions, and inability to confirm a different action or namespace.

Use injected handlers rather than real external writes:

```ts
interface TopicActionHandler {
  effect: TopicActionEffect;
  execute(action: TopicProposalAction, context: TopicExecutionContext): Promise<TopicActionOutcome>;
}
```

Register concrete handlers only for `draft` and `create_candidate_task` in this task. Confirmation-only effects remain paused; they do not get fake implementations.

- [ ] **Step 3: Run RED tests**

```bash
cd Memory
npx vitest run tests/service/topic-decision/execution-policy.test.ts tests/service/topic-decision/execution.test.ts
```

Expected: FAIL on missing policy and executor.

- [ ] **Step 4: Implement approval and reversible handlers**

Approval rejects stale sessions, blocking gaps, proposal version conflicts, and non-human actors. `draft` persists a bounded artifact through the existing artifact repository. `create_candidate_task` creates a non-focused pending project-context work item with proposal/session provenance; it does not silently change the active project goal.

Persist action success before starting the next action. At confirmation-required actions, store exact target/input/artifacts/rollback metadata and stop with `awaiting_confirmation`.

- [ ] **Step 5: Run GREEN tests and commit**

```bash
cd Memory
npx vitest run tests/service/topic-decision/execution-policy.test.ts tests/service/topic-decision/execution.test.ts tests/service/project-context/project-context-service.test.ts
```

Expected: PASS. Commit:

```bash
git add Memory/src/service/topic-decision Memory/src/service/project-context Memory/tests/service/topic-decision
git commit -m "feat(memory): execute approved reversible topic actions"
```

### Task 6: Namespace-Scoped HTTP API And Contracts

**Files:**
- Modify: `Memory/src/server/http.ts`
- Modify: `Memory/src/types.ts`
- Modify: `Memory/src/client/rest-client.ts`
- Modify: `Memory/tests/contract/memory-rest-service.test.ts`
- Create: `Memory/tests/contract/topic-decision-rest.test.ts`

**Interfaces:**
- Consumes: `TopicDecisionService` methods from Tasks 2–5.
- Produces these routes:

```text
POST  /api/v1/topic-inbox/topics/:topicId/decisions
GET   /api/v1/topic-inbox/decisions/:sessionId
PATCH /api/v1/topic-inbox/decisions/:sessionId/agents
POST  /api/v1/topic-inbox/decisions/:sessionId/run
POST  /api/v1/topic-inbox/decisions/:sessionId/answers
POST  /api/v1/topic-inbox/decisions/:sessionId/proposals/:proposalId/approve
POST  /api/v1/topic-inbox/decisions/:sessionId/executions/:runId/resume
POST  /api/v1/topic-inbox/decisions/:sessionId/executions/:runId/actions/:actionId/confirm
POST  /api/v1/topic-inbox/decisions/:sessionId/cancel
```

- [ ] **Step 1: Write failing REST contract tests**

For every route, assert panel scope (`read` only for GET; `write` for all mutations), principal namespace enforcement, unknown-field rejection, bounded strings/arrays, optimistic conflict as HTTP `409`, disabled feature behavior, idempotent exact replay, and sanitized model errors. Assert list/read responses omit raw provider payloads and credentials.

- [ ] **Step 2: Write failing client tests**

Require matching `MemoryRestClient` methods with exact request/response types. Verify URL segment encoding, namespace body/query placement, bearer token propagation, and `409` error detail preservation.

- [ ] **Step 3: Run RED tests**

```bash
cd Memory
npx vitest run tests/contract/topic-decision-rest.test.ts tests/contract/memory-rest-service.test.ts
```

Expected: FAIL on missing routes and client methods.

- [ ] **Step 4: Implement strict parsers and routes**

Use the existing `asObject`, `assertNamespaceScope`, `requirePanelRead`, `requirePanelWrite`, and `service.idempotent` patterns. Route bodies include `namespace`, `requestId`, `adapterId`, and mutation-specific fields. Approval and confirmation actors come from authenticated request provenance, never caller-supplied arbitrary actor objects.

Map repository version conflicts to `409` with `{ entityId, currentVersion, currentState }`. Map disabled feature to `404` or the existing capability-disabled response so disabled deployments do not advertise a partially working surface.

- [ ] **Step 5: Run GREEN tests and commit**

```bash
cd Memory
npx vitest run tests/contract/topic-decision-rest.test.ts tests/contract/memory-rest-service.test.ts tests/client/rest-client.test.ts
```

Expected: PASS. Commit:

```bash
git add Memory/src/server Memory/src/client Memory/src/types.ts Memory/tests/contract Memory/tests/client
git commit -m "feat(api): expose topic decision sessions"
```

### Task 7: Action-First Web Console

**Files:**
- Modify: `Memory/src/viewer/static.ts`
- Modify: `Memory/tests/viewer-static.test.ts`
- Create: `Memory/tests/viewer-topic-decision.test.ts`

**Interfaces:**
- Consumes: Task 6 HTTP responses.
- Produces: one topic-level decision drawer/panel reachable from each topic card.

- [ ] **Step 1: Write failing static and interaction tests**

Use the existing VM harness. Require:

```text
Start analysis
Agent roster (3-5, editable before start)
Decision summary
At most three proposal cards
Approve proposal
Missing information
Submit answers
Unresolved high-risk disagreement
Stale result
Awaiting confirmation
Resume execution
```

Test action-first ordering by DOM order: summary and proposals precede collapsed agent positions/debate. Test blocked state replaces proposal approval with up to three questions. Test approval never calls an execution route without an explicit click. Test irreversible confirmation displays exact effect and requires a second click.

- [ ] **Step 2: Run RED tests**

```bash
cd Memory
npx vitest run tests/viewer-static.test.ts tests/viewer-topic-decision.test.ts
```

Expected: FAIL on missing decision surface.

- [ ] **Step 3: Implement topic decision UI**

Keep topic cards un-nested. Add a full-width detail surface with these sections in order:

```text
status/risk banner
summary
proposal list or evidence-blocked questions
execution progress / confirmation checkpoint
collapsed debate details
```

Use compact role/model rows, native checkbox/select controls for roster, and existing button/pill styles. Do not expose raw prompts. Disable approval when stale, blocked, low role coverage, or request in flight. Preserve selection and refetch after every mutation; on `409`, reload instead of retrying stale input.

- [ ] **Step 4: Run GREEN tests**

```bash
cd Memory
npx vitest run tests/viewer-static.test.ts tests/viewer-topic-decision.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run real browser verification**

Start the production build against a temporary SQLite database with decisions enabled and deterministic fixture rows. Verify at desktop `1440x1000` and mobile `390x844`:

```text
no page errors
no incoherent overlap
proposal summary visible before debate
blocked questions limited to three
stale and high-risk banners visible
second confirmation cannot be skipped
horizontal navigation remains usable on mobile
```

Capture screenshots under `output/playwright/` only if needed for evidence; do not add screenshots to source control.

- [ ] **Step 6: Commit**

```bash
git add Memory/src/viewer/static.ts Memory/tests/viewer-static.test.ts Memory/tests/viewer-topic-decision.test.ts
git commit -m "feat(memory): add topic decision console"
```

### Task 8: Staleness, Audit Metrics, Rollout, And End-To-End Verification

**Files:**
- Modify: `Memory/src/service/topic-inbox/project-topic-inbox.ts`
- Modify: `Memory/src/service/topic-decision/topic-decision-service.ts`
- Modify: `Memory/src/service/read-model/panel-read.ts`
- Modify: `Memory/src/server/http.ts`
- Modify: `Memory/src/viewer/static.ts`
- Modify: `Memory/readme.md`
- Create: `Memory/tests/service/topic-decision/staleness.test.ts`
- Create: `Memory/tests/service/topic-decision/audit-metrics.test.ts`
- Create: `Memory/tests/contract/topic-decision-smoke.test.ts`

**Interfaces:**
- Produces automatic stale marking when topic version/evidence changes, audit-linked metrics, capability reporting, and one end-to-end service scenario.

- [ ] **Step 1: Write failing staleness and audit tests**

Assert new attached evidence or topic mutation marks active `ready_for_decision`/`executing` sessions stale, prevents proposal approval, and stops pending execution without changing successful action history. Assert audit linkage from session → snapshot → positions → questions/answers → proposal approval → execution actions. Assert metrics contain counts/durations only, never evidence text or user answers.

- [ ] **Step 2: Write failing end-to-end contract test**

Run one real HTTP server with deterministic LLM clients:

```text
create topic decision
adjust roster
round 1 finds blocking gap
automatic repository acquisition fails
user receives one consolidated question
submit authoritative constraint
new snapshot runs two debate rounds
synthesize two proposals
approve proposal
execute draft and candidate task
pause before authoritative write
confirm exact action
complete and read audit trail
```

Also cover a changed-topic branch that returns stale before approval.

- [ ] **Step 3: Run RED tests**

```bash
cd Memory
npx vitest run tests/service/topic-decision/staleness.test.ts tests/service/topic-decision/audit-metrics.test.ts tests/contract/topic-decision-smoke.test.ts
```

Expected: FAIL on missing stale hooks, metrics, or complete flow.

- [ ] **Step 4: Implement stale hooks, metrics, and capabilities**

After successful topic/evidence mutation, call a namespace/topic-scoped stale marker in the same transaction where possible. Expose aggregate metrics in panel metrics/config only when the feature is enabled. Advertise decision routes in health capabilities only when enabled. Document the two environment variables, rollout flag, model cost implications, maximum three rounds, and confirmation boundary in `Memory/readme.md`.

- [ ] **Step 5: Run focused GREEN verification**

```bash
cd Memory
npx vitest run tests/service/topic-decision tests/contract/topic-decision-rest.test.ts tests/contract/topic-decision-smoke.test.ts tests/viewer-topic-decision.test.ts
npm run typecheck
npm run build
```

Expected: all commands exit `0`.

- [ ] **Step 6: Run full project verification**

```bash
cd ..
npm run memory:lint
npm run memory:test
docker compose config --quiet
git diff --check
```

Expected: Memory typecheck/build passes, all Memory tests pass, Compose config is valid, and no whitespace errors exist.

- [ ] **Step 7: Verify disabled and enabled production smoke paths**

With `MEMMY_TOPIC_DECISIONS_ENABLED=false`, start the production server and verify decision capability/routes are unavailable while existing Topic Inbox remains functional. With the flag `true`, run the end-to-end browser scenario from Task 7 and verify the health/config response reports the feature and configured models without exposing API keys.

- [ ] **Step 8: Commit**

```bash
git add Memory/src/service/topic-inbox Memory/src/service/topic-decision Memory/src/service/read-model Memory/src/server Memory/src/viewer Memory/readme.md Memory/tests
git commit -m "feat(memory): complete governed topic decisions"
```

## Completion Gate

The implementation is complete only when all fifteen acceptance criteria in `docs/superpowers/specs/2026-08-12-topic-multi-agent-decision-design.md` have direct test evidence, the disabled path preserves current behavior, the enabled browser flow is exercised at desktop and mobile widths, and no irreversible effect can execute without a versioned second confirmation.
