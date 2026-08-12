# Topic Multi-Agent Decision Design

## Problem

The Topic Inbox currently asks a person to inspect topic evidence and candidate-level model reviews. This does not scale: the person still performs information compression and must infer the next action from many records.

The system must instead turn each topic into a bounded decision process. Multiple agents analyze a frozen evidence set, challenge one another, request missing information, and produce at most three actionable proposals. The person reviews the compressed decision surface and approves one proposal. Approved reversible work may run automatically; irreversible work always requires a second confirmation.

## Goals

- Let a person decide what to do next without reading all topic evidence or debate transcripts.
- Recommend three to five agents per topic while allowing the person to adjust the roster before starting.
- Run an adaptive debate of at most three rounds without hiding unresolved disagreement.
- Detect missing or contradictory premises before generating an approvable proposal.
- Obtain missing information automatically when possible, then ask the person at most three consolidated questions.
- Preserve evidence provenance, agent positions, user answers, approvals, and execution results for audit.
- Automatically execute approved reversible work and stop before irreversible effects.

## Non-Goals

- Autonomous approval of a proposal without a person.
- Unbounded agent debate or debate until consensus.
- Treating a majority vote as proof that evidence is sufficient.
- Replacing Topic Inbox ingestion, matching, candidate promotion, merge, or split semantics.
- Building a general-purpose agent runtime unrelated to topic decisions.
- Letting agents invent facts not present in the evidence snapshot or an explicitly recorded answer.

## User Experience

### Topic Decision Surface

The default layout is action-first. The first viewport shows:

1. Topic state summary.
2. Material risks, unresolved high-risk disagreements, low confidence, or stale status.
3. At most three action proposals.
4. For each proposal: expected benefit, risk, dependencies, reversible automatic actions, and actions requiring confirmation.
5. The primary command to approve one proposal.

Initial positions, debate rounds, complete evidence references, and model responses are collapsed by default. They remain available for inspection and audit.

When critical information is missing, the proposal surface is replaced by an evidence-blocked surface. It shows the blocking gaps, the minimum evidence-gathering plan, any safe temporary action, and up to three questions for the person.

### Agent Selection

The system recommends three to five agents based on topic signals. The person may add or remove agents before starting. The default role contracts are:

- `evidence_analyst`: validates facts, source quality, freshness, and contradictions.
- `domain_analyst`: interprets domain constraints and impact.
- `risk_challenger`: searches for invalid premises, counterexamples, and irreversible risk.
- `action_planner`: converts supported conclusions into bounded actions, acceptance criteria, and rollback conditions.
- `specialist`: optional topic-specific expertise such as code, security, product, or operations.

Models may vary, but every selected agent has one explicit role. Duplicate roles require an explicit reason.

## Decision Session Model

A topic decision is represented by six persistent object types rather than embedded chat transcripts in topic metadata.

### DecisionSession

Binds the decision to:

- Namespace and topic ID.
- Topic version.
- Evidence snapshot ID and deterministic input hash.
- Selected agent identities, models, and roles.
- Current state and debate round.
- Maximum round count, fixed at three.
- Creation, update, completion, and stale timestamps.
- Initiating and approving actors.

### AgentPosition

Stores one structured position for one agent and round:

- Judgment and confidence.
- Cited evidence IDs.
- Known facts.
- Explicit assumptions.
- Missing information.
- Whether each gap blocks a reliable decision.
- Risks and counterarguments.
- Suggested actions.
- Structured error when the agent fails.

The original first-round position remains immutable so later convergence cannot erase initial disagreement.

### DebateRound

Stores targeted challenges and responses:

- Round number and status.
- Conflicts selected for challenge.
- Agent-to-agent questions.
- Structured responses with evidence citations.
- Resolved and unresolved disagreements.
- Stop reason.

Raw provider responses belong in the existing audit/logging substrate, not the decision read model.

### EvidenceRequest

Represents information required to proceed:

- Missing fact or conflicting premise.
- Blocking or non-blocking severity.
- Why it matters and which proposals it may change.
- Automatic acquisition plan and result.
- Consolidated user question when automatic acquisition fails.
- User answer, provenance, timestamp, and verification status.

User-provided goals, preferences, business rules, and constraints are authoritative inputs. User-provided claims about externally verifiable facts are recorded as `user_supplied_unverified` until corroborated.

### ActionProposal

Stores one of at most three proposals:

- Title and concise rationale.
- Evidence IDs and assumptions.
- Expected benefit and material risks.
- Dependencies and evidence gaps.
- Ordered actions.
- Acceptance criteria and rollback conditions.
- Confidence and supporting/opposing agents.
- Rank and recommended flag.

Every action declares its effect class, required permission, expected artifact, acceptance condition, and recovery point.

### ExecutionRun

Tracks execution of one approved proposal:

- Proposal version and approving actor.
- Ordered action states.
- Produced artifacts and task IDs.
- Pending confirmation checkpoints.
- Failure, cancellation, and recovery state.
- Final outcome.

Partial completion must remain visible. A run cannot report success while any required action is failed, blocked, or awaiting confirmation.

## State Machine

Primary states:

```text
draft
  -> gathering_evidence
  -> debating
  -> ready_for_decision
  -> executing
  -> completed
```

Side states:

- `awaiting_user_input`: automatic evidence gathering cannot answer one or more blocking questions.
- `blocked_by_evidence`: required information is unavailable or contradictory after allowed gathering.
- `stale`: topic version or evidence snapshot changed after analysis.
- `failed`: orchestration or execution failed and may resume from the latest durable boundary.
- `cancelled`: a person explicitly stopped the session.

A user answer appends evidence to the session and creates a new evidence snapshot. It does not discard completed positions. The session resumes from the earliest stage invalidated by the new evidence. A materially changed topic creates a new session; the old session remains immutable audit history.

## Evidence and Debate Flow

### Evidence Snapshot

Before analysis, the system freezes:

- Topic title, summary, version, and signals.
- Eligible topic evidence and content hashes.
- Relevant project context constraints.
- Recorded user-supplied evidence.
- Agent roster and model configuration.

New evidence does not enter an active round. It marks the result stale and requires a new snapshot before further approval or execution.

### Round 1: Independent Positions

All agents analyze the same snapshot independently. They cannot read other positions. Each response must satisfy the `AgentPosition` contract and cite evidence IDs.

### Decisionability Gate

Before debate, the orchestrator checks:

- Required evidence citations exist in the snapshot.
- Blocking gaps are explicit.
- Agent assumptions do not masquerade as facts.
- Material premise conflicts are identified.

If a critical gap exists, normal debate stops. The system attempts authorized read-only acquisition first. Remaining questions are deduplicated, ranked by expected decision impact, and limited to three for the person.

### Round 2: Cross-Examination

Agents receive only the structured conflicting claims relevant to their role. They challenge evidence, assumptions, and proposed actions. General repetition is rejected.

### Round 3: Targeted Resolution

A third round runs only when unresolved disagreement is both material and high risk. It targets those disagreements exclusively. The session stops after round three regardless of consensus.

### Synthesis

A separate synthesizer:

- May summarize positions and disagreements.
- May rank supported proposals.
- May not introduce facts absent from cited evidence or recorded answers.
- May not suppress unresolved high-risk disagreement.
- May not produce more than three proposals.
- May not mark a proposal approvable while blocking evidence gaps remain.

## Evidence Acquisition and User Questions

For each blocking gap:

1. Search existing topic evidence, project context, memory, code, logs, and authorized read-only tools.
2. Record the query, source, result, and freshness.
3. Merge equivalent unanswered gaps.
4. Ask the person at most three questions, ordered by expected impact on available proposals.
5. Explain why each answer is needed and which decision it may change.
6. Record the answer with provenance and scope.
7. Rebuild the evidence snapshot and resume from the invalidated decision stage.

The system must not ask the person for information already available through authorized sources.

## Execution Policy

### Automatically Executable After Proposal Approval

- Search and read operations.
- Analysis and read-only checks.
- Draft generation.
- Candidate task creation.
- Test plan and change plan preparation.
- Preparation of a proposed configuration or patch that is not applied.

### Requires Second Confirmation

- Applying code or configuration changes.
- Writing production or authoritative project data.
- Publishing, sending, or invoking an external write API.
- Deleting records or artifacts.
- Merging or splitting topics.
- Approving or promoting higher-layer Memory.
- Any action classified irreversible or lacking a tested rollback path.

Each confirmation displays the exact pending effect, target, inputs, rollback availability, and artifacts produced so far. Confirmation applies only to that effect or explicitly enumerated batch, never to future unspecified actions.

## Failure, Concurrency, and Idempotency

- Session creation is idempotent for the same namespace, topic version, evidence hash, and agent roster.
- Agent calls execute independently; one failure is recorded and does not erase successful positions.
- Decision synthesis requires enough valid role coverage, not merely a model count.
- Durable round boundaries allow retries without repeating successful model calls.
- Proposal approval uses optimistic version checks.
- Execution actions have deterministic idempotency keys scoped to execution run and action ID.
- Failure stops at the current action. Resume starts from the latest successful durable action.
- New evidence or topic mutation prevents approval and stops not-yet-started execution actions by marking the session stale.
- No retry may bypass a pending confirmation checkpoint.

## API Boundary

The feature extends the namespace-scoped Topic Inbox API with conceptual operations:

- Create or reuse a decision session for a topic.
- Read session summary, positions, rounds, evidence requests, proposals, and execution state.
- Update the proposed agent roster before analysis starts.
- Start or resume analysis.
- Submit answers to consolidated evidence questions.
- Approve one versioned proposal.
- Confirm or reject one pending execution effect.
- Cancel a session or execution run.

All reads require panel read permission. Session creation, answers, approval, confirmation, cancellation, and execution require panel write permission. Every operation asserts principal namespace scope. Responses expose structured decision data and sanitized provider errors, never credentials or raw hidden prompts.

## Integration With Existing Topic Inbox

- Existing topic ingestion and topic candidate generation continue unchanged.
- A decision session belongs to a topic, not to one candidate.
- Existing candidate-level AI review remains available as a narrow governance tool; topic decisions supersede it as the normal human workflow.
- A proposal may recommend candidate approval, rejection, merge, split, or evidence gathering, but those existing operations retain their own version and confirmation rules.
- Topic cards show latest decision state and recommended next action. The detailed decision surface opens from the topic card.

## Observability and Audit

Audit records must connect:

- Session and evidence snapshot.
- Agent role, model, round, position, and cited evidence.
- Automated evidence acquisition and user answers.
- Synthesis inputs and proposal versions.
- Approving actor and timestamp.
- Every automatic action, confirmation, artifact, failure, and recovery.

Operational metrics include session duration, model calls by round, evidence-block rate, user-question count, stale rate, proposal approval rate, execution failure rate, and irreversible confirmation rate. Metrics must not include raw sensitive evidence or user answers.

## Acceptance Criteria

1. A person can start a topic decision with a system-recommended roster and adjust it before execution.
2. Round-one positions are independent, structured, immutable, and evidence-cited.
3. Round two targets conflicts; round three occurs only for unresolved high-risk disagreements; no fourth round is possible.
4. Blocking evidence gaps prevent generation of an approvable proposal.
5. Automatic evidence acquisition runs before asking the person.
6. The person receives no more than three deduplicated questions, each with decision impact.
7. User goals and constraints are authoritative; externally verifiable user claims remain marked unverified until corroborated.
8. Synthesis produces at most three proposals and exposes unresolved high-risk disagreement.
9. The default UI shows proposals before debate details and displays stale, blocked, low-confidence, and high-risk states in the first viewport.
10. Approving a proposal automatically executes only actions classified reversible by policy.
11. Irreversible actions cannot execute without a versioned second confirmation.
12. A failed run reports partial state and can resume without duplicating successful actions.
13. Topic or evidence changes invalidate old approval and stop pending actions.
14. Namespace scope, optimistic concurrency, and idempotency are enforced for every mutation.
15. Complete evidence, debate, answer, approval, and execution provenance is auditable without exposing secrets.

## Rollout

1. Add decision-session persistence and read APIs behind a disabled feature flag.
2. Add evidence snapshot, independent positions, and decisionability gate.
3. Add adaptive debate and synthesis without execution.
4. Add action-first Topic Inbox UI and user evidence questions.
5. Add reversible execution and confirmation checkpoints.
6. Enable for selected namespaces, measure evidence-block and stale rates, then expand.

Candidate-level AI review remains available during rollout. Automatic proposal execution stays disabled until confirmation-policy tests and audit verification pass.
