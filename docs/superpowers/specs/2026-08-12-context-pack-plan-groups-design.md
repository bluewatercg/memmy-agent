# Context Pack Plan Groups Design

## 1. Purpose

Memmy must let a user understand concurrent development across agents without reading raw sessions:

- what goals exist;
- which plans are active under each goal;
- what each agent and session is doing;
- which work is planned, active, blocked, awaiting verification, or complete;
- why each status was assigned;
- where inferred work conflicts with confirmed project intent.

A context pack remains scoped to one runtime namespace. The pack contains multiple goals and plans rather than assuming one active goal and one focused work item.

## 2. Authority Model

The model has five distinct concepts. They must not share identities or silently substitute for one another.

1. **Goal**: the outcome the project intends to achieve. Goals are durable, user-confirmed, and relatively few. Multiple goals may be active.
2. **Plan**: how work advances one goal. Plans are durable execution strategies. A plan belongs to at most one goal and may temporarily be unassigned.
3. **Work Item**: a concrete unit of work under one plan.
4. **Observed Group**: a candidate grouping inferred from agent memories. It is visible but not authoritative until reviewed.
5. **Topic and Memory**: evidence and evidence clusters. They do not carry project intent or execution authority.

The context pack has two visible sections:

```text
ContextPack (one workspace namespace)
├── goals[]
│   └── plans[]
│       └── workItems[]
│           └── agentActivities[] + evidence[]
└── observedGroups[]
```

Confirmed plans and observed work must never be mixed without a section and `kind` marker.

## 3. Persistent Domain Records

### 3.1 Goal

`ProjectGoalRecord` remains the authority for intended outcomes. It is not replaced by Plan. The model must evolve from a single active goal to multiple active goals while retaining a primary-goal compatibility projection.

The namespace stores an optional `primaryGoalId` for legacy consumers and compact context injection. Primary selection is presentation metadata; it does not make other active Goals inactive.

### 3.2 Plan

```ts
type ProjectPlanDeclaredStatus =
  | "proposed"
  | "active"
  | "blocked"
  | "verification_pending"
  | "completed"
  | "abandoned"
  | "archived";

interface ProjectAcceptanceCriterion {
  id: string;
  text: string;
}

interface ProjectPlanRecord {
  id: string;
  namespaceId: string;
  goalId?: string;
  stableKey: string;
  title: string;
  summary: string;
  detail: string;
  declaredStatus: ProjectPlanDeclaredStatus;
  priority: "critical" | "high" | "normal" | "low";
  owner?: ProjectActorRef;
  contributors: ProjectActorRef[];
  acceptanceCriteria: ProjectAcceptanceCriterion[];
  constraints: string[];
  phases: ProjectPlanPhase[];
  milestones: ProjectPlanMilestone[];
  dependencies: ProjectPlanDependency[];
  targetStartAt?: string;
  targetEndAt?: string;
  actualStartAt?: string;
  actualEndAt?: string;
  sourceMemoryIds: string[];
  sourceTopicIds: string[];
  provenance: Record<string, unknown>;
  version: number;
  createdAt: string;
  updatedAt: string;
}
```

Invariants:

- `stableKey` is unique within a namespace.
- A Plan belongs to zero or one Goal, never multiple Goals.
- A Goal may have multiple Plans, including parallel plans and alternatives.
- A Plan with no `goalId` is shown as "unassigned", never attached to the current Goal by inference.
- Owner, priority, and target dates are declared values. Agent activity cannot overwrite them.
- Plan dependency writes that create a cycle are rejected.
- Updates use optimistic concurrency through `version`.
- Plan creation accepts an idempotency key scoped to the namespace. Replaying the same key and semantically identical request returns the original result; reusing it with a different request fails.
- Dependency cycle validation and the dependency write commit in one transaction. Concurrent writes cannot each pass validation and jointly introduce a cycle.

### 3.3 Work Item

`ProjectWorkItemRecord` gains a required `planId` after migration. New work items cannot be created without a Plan. Existing unassigned items are migrated into an explicit imported Plan per namespace rather than silently attached to a current Goal.

Work items retain their status and acceptance criteria. Completion is not inferred solely from an agent statement.

### 3.4 Observed Group

Observed Groups are persisted candidates so their review state, merges, splits, dismissals, and stable cross-session identity survive refreshes.

```ts
interface ProjectObservedGroupRecord {
  id: string;
  namespaceId: string;
  stableKey?: string;
  title: string;
  aliases: string[];
  summary: string;
  proposedGoalId?: string;
  mergedIntoId?: string;
  proposedPlanId?: string;
  proposedFields: ProjectPlanFieldCandidates;
  status: "candidate" | "confirmed" | "merged" | "split" | "dismissed";
  confidence: "low" | "medium" | "high";
  sourceMemoryIds: string[];
  sourceTopicIds: string[];
  provenance: Record<string, unknown>;
  version: number;
  firstSeenAt: string;
  lastActivityAt: string;
  updatedAt: string;
}
```

A dismissed group reappears only when its stable key changes or its normalized evidence-ID set changes. Metadata refreshes and reordered evidence do not reactivate it. A merged group records `mergedIntoId`, retires its stable key from automatic matching, and remains readable for audit.

## 4. Unified Group Read Model

Confirmed Plans and Observed Groups use one explanatory read shape while retaining their authority marker.

```ts
type ContextGroupStatus =
  | "planned"
  | "in_progress"
  | "blocked"
  | "verification_pending"
  | "completed"
  | "stale"
  | "unknown"
  | "abandoned";

interface ContextGroup {
  id: string;
  kind: "plan" | "observed";
  identity: {
    stableKey?: string;
    title: string;
    aliases: string[];
  };
  placement: {
    goalId?: string;
    planId?: string;
    parentGroupId?: string;
  };
  intent: {
    summary: string;
    acceptanceCriteria: ProjectAcceptanceCriterion[];
    constraints: string[];
  };
  management: {
    priority?: "critical" | "high" | "normal" | "low";
    owner?: ProjectActorRef;
    contributors: ProjectActorRef[];
    phases: ProjectPlanPhaseView[];
    milestones: ProjectPlanMilestoneView[];
    dependencies: ProjectPlanDependencyView[];
    targetStartAt?: string;
    targetEndAt?: string;
    actualStartAt?: string;
    actualEndAt?: string;
  };
  status: {
    declared?: ProjectPlanDeclaredStatus;
    derived: ContextGroupStatus;
    effective: ContextGroupStatus;
    confidence: "low" | "medium" | "high";
    reason: string;
    evidenceIds: string[];
  };
  compiledTruth: {
    summary: string;
    sourceEvidenceIds: string[];
    generatedFrom: "declared_plan" | "reviewed_observation";
  };
  timeline: ProjectContextTimelineEntry[];
  progress?: {
    completed: number;
    total: number;
    percent: number;
  };
  agents: AgentActivityGroup[];
  workItems: ProjectWorkItemView[];
  evidenceSummary: {
    planning: number;
    execution: number;
    errors: number;
    fixes: number;
    verification: number;
  };
  evidenceAvailability: "available" | "partial" | "unavailable";
  conflicts: ProjectContextConflict[];
  firstSeenAt: string;
  lastActivityAt: string;
}
```

### 4.1 Compiled Truth and Evidence Timeline

Each group is presented on two tracks:

- `compiledTruth` is the current best supported understanding of that Plan or Observed Group. For a confirmed Plan it is a deterministic projection of the declared Plan intent, current effective status, next step, blocker, and covering evidence. For an Observed Group it is a deterministic projection of the reviewed candidate fields and currently assigned evidence. It is never an LLM-authored rewrite and never overwrites declared management fields.
- `timeline` is the ordered evidence trail explaining how the current understanding changed. Entries are projected from immutable evidence, supersession relations, review operations, and status transitions. They are ordered by `observedAt ASC, id ASC`; pagination and truncation preserve this order.

```ts
interface ProjectContextTimelineEntry {
  id: string;
  observedAt: string;
  kind: "planning" | "execution" | "error" | "fix" | "verification" | "observation" | "review" | "status_change";
  summary: string;
  sourceAgent: string;
  sessionId?: string;
  evidenceIds: string[];
  supersedesEntryIds: string[];
}
```

This borrows the useful `compiled_truth + timeline` reading pattern from [brain.md](https://github.com/mindmuxai/brain.md) without claiming protocol compatibility. brain.md stores a rewritable truth and append-only timeline in each repository page; Memmy keeps SQLite records and immutable evidence as authority, so both tracks here are read-model projections. Supersession connected components and stable fact/Plan identifiers define identity. `memoryKind + tags` similarity may suggest a candidate but cannot merge independent truths. Multiple active heads or equal-coverage contradictions remain explicit conflicts rather than being concatenated into a false consensus.

Context-pack summaries include `compiledTruth` and only the newest timeline entries that fit after all higher-priority group summaries. Group detail and the read-only group audit projection expose the complete available timeline. Existing general memory Markdown import/export remains byte-structure compatible and is not repurposed for this view. Prompt injection does not include raw memories or full timelines by default.

Progress is emitted only when at least one non-archived Work Item exists. It is the unweighted ratio `completed Work Items / non-archived Work Items`; when the denominator is zero, the `progress` object is omitted. The system must not invent a percentage from message counts, token use, elapsed time, file churn, priority, or estimated effort.

## 5. Agent Activity Standard

Agents are shown first by source and then by session.

```ts
interface AgentActivityGroup {
  source: string; // codex, pi, claude, or another adapter source
  agentId?: string;
  role: "owner" | "contributor" | "observer" | "unknown";
  sessions: Array<{
    sessionId: string;
    workItemId?: string;
    activity: "planning" | "execution" | "verification" | "research" | "idle" | "blocked";
    summary: string;
    lastSeenAt: string;
    evidenceIds: string[];
  }>;
}
```

Rules:
- Agent role is declared through the Plan's owner/contributor assignments or an explicit reviewed activity assignment. Recent activity does not make an agent the owner.
- Session identity comes from captured provenance, not model-generated labels.
- Missing source/session information is retained as `unknown`; its evidence is not dropped.
- One session activity belongs to one Plan and optionally one Work Item. Evidence may later be moved through a reviewed group merge or split.

## 6. Evidence Classification and Grouping

Evidence is classified as planning, execution, error, fix, verification, or observation. Questions, injected context, continuation controls, tool intentions, and unexecuted plans do not prove execution or completion.

Grouping priority:

1. explicit Plan or Work Item ID;
2. explicit stable key;
3. an exact reviewed alias;
4. same namespace plus module/file scope and strong intent similarity;
5. otherwise create or update an Observed Group.

Weak similarity never merges groups automatically. It creates a possible-duplicate conflict for review.

Evidence precedence:

1. current executable behavior and direct tool results;
2. stable project contracts;
3. focused verification results;
4. current Git state and history;
5. reviewed design and planning artifacts;
6. agent or user conversation claims.

Recent evidence generally supersedes stale evidence, but only when it covers the same contract. A newer unrelated test does not invalidate an older focused failure.

Evidence coverage is based on stable acceptance-criterion, Work Item, command/test, and affected-scope identifiers captured in provenance. Each Plan acceptance criterion receives a stable ID when persisted; read views expose those IDs alongside display text. A fix matches a failure only when it addresses the same failing contract or scope; successful verification supersedes that failure only when it covers the same identifier. Free-text similarity may propose a relationship but cannot clear a failure or prove an acceptance criterion. When evidence has equal coverage and contradictory outcomes, the later directly observed result wins; otherwise the conflict remains explicit.

## 7. Status Derivation

The read model retains both `declared` and `derived` status. Derivation is a pure evaluation over a versioned evidence snapshot. Rules are evaluated in this precedence order and produce one result; `effective` equals that result except that an authoritative user-declared `abandoned` or `archived` Plan maps to `abandoned`. Any disagreement with another declared status is exposed as a conflict rather than fed back into derivation.

1. `unknown`: evidence with the same coverage is contradictory and cannot be ordered by the evidence rules.
2. `blocked`: an explicit blocker or unresolved covered failure prevents the next step. Inactivity alone cannot produce this status.
3. `completed`: every applicable acceptance criterion has covering verification evidence, or the user explicitly accepts the Plan.
4. `verification_pending`: an agent claims completion, or implementation evidence appears complete, but acceptance criteria lack covering verification evidence.
5. `in_progress`: execution evidence exists and completion has not been claimed or verified.
6. `stale`: a non-completed group has no activity beyond the namespace-configured threshold.
7. `planned`: a confirmed or inferred intent exists, but there is no execution evidence.

Additional rules:

- A completed claim without verification never becomes `completed`.
- A failure followed by a matching fix and successful covering verification no longer keeps the group blocked.
- User-declared abandoned/archived status is authoritative.
- Declared and derived disagreement is always visible; it is never silently normalized.
- The stale threshold is namespace configuration with a documented service default; changing it invalidates affected read-model projections without rewriting historical evidence.

## 8. Review Operations

Observed Groups support four reviewed transitions:

- `confirm`: create a Goal, Plan, and/or Work Items according to the reviewed proposal; preserve all source IDs.
- `merge`: attach the evidence to an existing Plan or Observed Group and close the source group.
- `split`: partition by explicit evidence IDs; every source evidence item must appear in exactly one resulting group.
- `dismiss`: suppress the current candidate evidence set without deleting evidence.

Candidate fields such as owner, priority, dates, dependencies, milestones, and Goal placement require explicit review. They cannot overwrite declared Plan values automatically.

Every extraction, merge, split, status derivation, and review action records provenance and audit data.

Each review operation is one namespace-scoped transaction over the candidate, destination records, evidence ownership, versions, and audit entry. `split` commits only if every source evidence ID occurs in exactly one result. `merge` commits the destination attachment and source closure together. Review mutations require the candidate's expected version and an idempotency key; a retry returns the original committed result. Authorization follows the existing namespace mutation policy and the audit record includes actor, request ID, idempotency key, before/after versions, source/destination IDs, and reason.

## 9. Interfaces

### 9.1 Persistent Plan Interfaces

- `GET /api/v1/project-context/plans`
- `POST /api/v1/project-context/plans`
- `GET /api/v1/project-context/plans/:id`
- `PATCH /api/v1/project-context/plans/:id`
- `POST /api/v1/project-context/plans/:id/archive`

List filters include Goal, declared status, priority, owner, contributor, and activity time. Mutations require expected version. Version mismatches return HTTP `409` with a stable error code, the expected and current versions, and the current resource reference. Invalid dependency cycles return `409`; invalid request shapes return `422`. Creation and non-idempotent action routes require a namespace-scoped `Idempotency-Key`.

### 9.2 Group Read Interfaces

- `GET /api/v1/project-context/groups`
- `GET /api/v1/project-context/groups/:id`
- `GET /api/v1/project-context/groups/:id/audit`
- `POST /api/v1/project-context/groups/:id/confirm`
- `POST /api/v1/project-context/groups/:id/merge`
- `POST /api/v1/project-context/groups/:id/split`
- `POST /api/v1/project-context/groups/:id/dismiss`

List filters include `section=confirmed|observed`, Goal, effective status, owner, Agent source, priority, and last activity. The default order is `updatedAt DESC, id ASC`. The first page binds the filter and ordered result IDs to an immutable read-model revision; subsequent opaque cursors contain that revision and the last `(updatedAt, id)` tuple. The service must replay that revision for the cursor lifetime, so concurrent mutations neither duplicate nor omit entries from the traversal. Mutations appear on the next refresh. Expired, unknown-revision, or filter-mismatched cursors fail with a stable cursor error instead of silently restarting. List rows expose compiled truth plus timeline counts/latest activity; group detail expands the full available timeline and raw evidence only on request.

The audit route returns deterministic Markdown with `## Current Truth` followed by `## Timeline`, provenance/evidence references, generated-at/read-revision metadata, and explicit conflict/availability notices. It is read-only and not accepted by the existing general memory Markdown importer.

### 9.3 Context Pack Output

The context pack exposes:

```ts
interface ProjectContextPackV2 {
  namespace: RuntimeNamespace;
  goals: ProjectGoalView[];
  groups: ContextGroup[];
  observedGroups: ContextGroup[];
  facts: ProjectFactRecord[];
  conflicts: ProjectContextConflict[];
  markdown: string;
  cursor?: string;
  truncation: {
    occurred: boolean;
    omittedConfirmed: number;
    omittedObserved: number;
    omittedByStatus: Partial<Record<ContextGroupStatus, number>>;
  };
  generatedAt: string;
}
```


`groups` contains confirmed Plan groups; `observedGroups` contains candidate groups. A group appears in exactly one collection.
Stable injected context is budgeted in this order:

1. active Goals;
2. critical/high-priority blocked Plans;
3. active Plans ordered by priority and activity;
4. each included Plan's compiled truth, next step, blocker, responsible actors, and verification state;
5. newest timeline entries for already-included groups;
6. authoritative facts and unresolved conflicts.

Raw evidence and full session transcripts are never injected by default.

The caller supplies a context budget subject to the renderer's existing minimum and maximum limits. Rendering reserves space for the namespace header and truncation metadata, then applies the ordering above without splitting a group summary. Per-group detail is reduced before a whole higher-priority group is omitted. The result reports whether truncation occurred, omitted group counts by section/status, and the continuation cursor; raw evidence never displaces a group summary.

## 10. Compatibility and Migration

Existing `/api/v1/project-context/state` and `ProjectContextStableResult` remain available during migration.

Compatibility projections:

- `activeGoal` is the Goal selected by `primaryGoalId`. If no valid primary selection exists, choose deterministically from active Goals by `updatedAt DESC, id ASC`.
- `focusedWorkItem` preserves the caller's valid explicit focus. Otherwise select from the primary Goal's active Plans by priority (`critical` to `low`), then `updatedAt DESC, id ASC`, and use that Plan's explicit focused Work Item if one exists. If no such item exists, return `null`; never infer focus from recent activity.
- V2 opt-in is an explicit consumer capability or API version, recorded per caller. Existing stable-context consumers receive the compatibility projection until they opt in; compatibility retirement requires a separate approved migration.

Migration sequence:

1. add Plan, Plan dependency/milestone/phase, Observed Group storage, and a durable migration ledger;
2. add nullable `planId` to Work Items while old readers and writers remain valid;
3. for each namespace transactionally create deterministic imported Plans, attach existing Goal-linked or unscoped Work Items, and record the batch ID and pre-migration associations;
4. verify that every migrated Work Item has exactly one valid Plan before making `planId` required; a failed namespace batch rolls back without removing its legacy associations;
5. expose Plan and Group interfaces in Memory REST, local contracts, and the backend proxy;
6. add incremental extraction from new memories and Topic evidence;
7. switch context-pack consumers to V2 behind an explicit consumer capability/version flag while retaining compatibility projections; desktop client and viewer adoption are explicitly excluded from this phase;
8. stop creating unscoped legacy Work Items only after telemetry or an exhaustive caller inventory confirms migration;
9. retire compatibility projections in a separately approved migration, not implicitly in this rollout.

Migration batches are resumable and idempotent. The ledger records namespace, schema version, batch status, deterministic imported Plan IDs, counts, validation results, and failure details. Rollback is supported until the `planId`-required cutover by restoring recorded associations and deleting only records created by that batch. After cutover, recovery uses a forward repair migration; no runtime dual-write is introduced.

There is no indefinite dual write between Goal and Plan because they represent different concepts. Goal mutations update Goals; Plan mutations update Plans.

## 11. Failure Handling

- Malformed extraction output receives one schema-directed repair. A second failure preserves the previous group view and records the failed run.
- Missing or archived evidence remains as an unavailable reference and sets evidence availability to `partial` or `unavailable`; historical completion is not silently recomputed. A status requiring unavailable evidence becomes `unknown` unless independent covering evidence remains.
- Dependency cycles are rejected atomically on persistent writes and shown as conflicts in observed candidates.
- Concurrent mutations fail with the version-conflict contract defined in section 9.1; clients refetch before retrying and reuse the same idempotency key for the same logical action.
- Namespace mismatch fails closed for reads and writes.
- An extraction failure cannot delete or empty confirmed Goals, Plans, or Work Items.
- A failed review transaction leaves candidate state, evidence ownership, and audit history unchanged except for a failed-attempt audit entry.

## 12. Verification

Permanent contract coverage must include:

- multiple active Goals and multiple Plans in one namespace;
- Plans with and without Goal assignment;
- cross-Agent source and session grouping;
- stable-key grouping across sessions;
- weak similarity producing a review conflict rather than an automatic merge;
- `verification_pending` becoming `completed` only after covering evidence;
- error, fix, and verification ordering clearing a blocker;
- status conflicts becoming `unknown`;
- progress omitted when no Work Item denominator exists;
- dependency cycle rejection;
- split evidence conservation and merge provenance;
- optimistic version conflicts;
- namespace isolation;
- malformed extraction failure preserving prior state;
- legacy state and stable-context compatibility;
- atomic and idempotent confirm, merge, split, and dismiss retries;
- snapshot pagination under concurrent updates, cursor expiry, and filter mismatch;
- interrupted migration rollback, idempotent resume, and post-cutover forward repair;
- concurrent dependency writes cannot jointly create a cycle;
- Plan reassignment between Goals preserves Work Item and evidence ownership;
- stable-context budget truncation preserves ordering and reports omissions;
- archived or unavailable evidence produces explicit availability and status behavior;
- a real Codex/Pi/Claude memory replay reconstructing several concurrent plans with evidence-backed status.
- deterministic compiled truth from declared/reviewed authority without LLM rewriting;
- timeline ordering by `observedAt ASC, id ASC`, supersession provenance, active-head conflicts, and budget truncation that never displaces a group summary;

## 13. Non-Goals

- General-purpose project management or issue tracking.
- Automatic assignment of owners, priorities, or delivery commitments.
- Treating Topic Inbox candidates as confirmed plans.
- Deriving progress from tokens, elapsed time, commit count, or activity volume.
- Injecting full raw memories or session transcripts into every Agent context.
- Implementing or claiming compatibility with the external brain.md file protocol in this phase. A future interoperability design must use its actual git-tracked `BRAIN.md` entry point, one CLI-resolved `brainRoot`, CLI-only atomic truth/timeline writes, and repo-portable Markdown data; a local ignored `MEMORY.md` connection snapshot is not equivalent.
