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
  acceptanceCriteria: string[];
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

A dismissed group reappears only if its stable key changes or its evidence set materially changes.

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
    acceptanceCriteria: string[];
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
  progress: {
    completed: number;
    total: number;
    percent?: number;
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
  conflicts: ProjectContextConflict[];
  firstSeenAt: string;
  lastActivityAt: string;
}
```

Progress is emitted only when a concrete work-item list exists. The system must not invent a percentage from message counts, token use, elapsed time, or file churn.

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

- Session identity comes from captured provenance, not model-generated labels.
- Agent role is declared. Recent activity does not make an agent the owner.
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

## 7. Status Derivation

The read model retains both `declared` and `derived` status. `effective` follows the rules below and exposes disagreements as conflicts.

- `planned`: a confirmed or inferred intent exists, but there is no execution evidence.
- `in_progress`: execution evidence exists and completion has not been claimed or verified.
- `verification_pending`: an agent claims completion, or implementation evidence appears complete, but acceptance criteria lack verification evidence.
- `completed`: every applicable acceptance criterion has covering verification evidence, or the user explicitly accepts the Plan.
- `blocked`: an explicit blocker or unresolved failure prevents the next step. Inactivity alone cannot produce this status.
- `stale`: a non-completed group has no activity beyond a configurable threshold. Staleness is separate from blockage.
- `unknown`: evidence is insufficient or contradictory.
- `abandoned`: the Plan was explicitly abandoned.

Additional rules:

- A completed claim without verification never becomes `completed`.
- A failure followed by a matching fix and successful verification no longer keeps the group blocked.
- Conflicting success/failure evidence produces `unknown` until evidence coverage or user review resolves it.
- User-declared abandoned/archived status is authoritative.
- Declared and derived disagreement is always visible; it is never silently normalized.

## 8. Review Operations

Observed Groups support four reviewed transitions:

- `confirm`: create a Goal, Plan, and/or Work Items according to the reviewed proposal; preserve all source IDs.
- `merge`: attach the evidence to an existing Plan or Observed Group and close the source group.
- `split`: partition by explicit evidence IDs; every source evidence item must appear in exactly one resulting group.
- `dismiss`: suppress the current candidate evidence set without deleting evidence.

Candidate fields such as owner, priority, dates, dependencies, milestones, and Goal placement require explicit review. They cannot overwrite declared Plan values automatically.

Every extraction, merge, split, status derivation, and review action records provenance and audit data.

## 9. Interfaces

### 9.1 Persistent Plan Interfaces

- `GET /api/v1/project-context/plans`
- `POST /api/v1/project-context/plans`
- `GET /api/v1/project-context/plans/:id`
- `PATCH /api/v1/project-context/plans/:id`
- `POST /api/v1/project-context/plans/:id/archive`

List filters include Goal, declared status, priority, owner, contributor, and activity time. Mutations require expected version.

### 9.2 Group Read Interfaces

- `GET /api/v1/project-context/groups`
- `GET /api/v1/project-context/groups/:id`
- `POST /api/v1/project-context/groups/:id/confirm`
- `POST /api/v1/project-context/groups/:id/merge`
- `POST /api/v1/project-context/groups/:id/split`
- `POST /api/v1/project-context/groups/:id/dismiss`

List filters include `section=confirmed|observed`, Goal, effective status, owner, Agent source, priority, and last activity. Pagination uses a stable `(updatedAt, id)` cursor. Details expand raw evidence only on request.

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
  generatedAt: string;
}
```

Stable injected context is budgeted in this order:

1. active Goals;
2. critical/high-priority blocked Plans;
3. active Plans ordered by priority and activity;
4. each included Plan's next step, blocker, responsible actors, and verification state;
5. authoritative facts and unresolved conflicts.

Raw evidence and full session transcripts are never injected by default.

## 10. Compatibility and Migration

Existing `/api/v1/project-context/state` and `ProjectContextStableResult` remain available during migration.

Compatibility projections:

- `activeGoal` is the Goal selected by `primaryGoalId`. If no valid primary selection exists, choose deterministically from active Goals by `updatedAt DESC, id ASC`.
- `focusedWorkItem` is the caller Agent's focus when known, otherwise the primary Plan's focused Work Item.
- Existing stable-context consumers receive the compatibility projection until they opt into V2.

Migration sequence:

1. add Plan, Plan dependency/milestone/phase, and Observed Group storage;
2. add `planId` to Work Items;
3. migrate existing Goal-linked Work Items into generated imported Plans while retaining Goal ownership;
4. expose Plan and Group interfaces in Memory REST, local contracts, backend proxy, and clients;
5. add incremental extraction from new memories and Topic evidence;
6. switch context pack and viewer to V2 while retaining compatibility projections;
7. stop creating unscoped legacy Work Items after all callers migrate.

There is no indefinite dual write between Goal and Plan because they represent different concepts. Goal mutations update Goals; Plan mutations update Plans.

## 11. Failure Handling

- Malformed extraction output receives one schema-directed repair. A second failure preserves the previous group view and records the failed run.
- Missing or archived evidence remains as an unavailable reference; historical completion is not silently recomputed.
- Dependency cycles are rejected on persistent writes and shown as conflicts in observed candidates.
- Concurrent mutations fail with version conflict.
- Namespace mismatch fails closed for reads and writes.
- An extraction failure cannot delete or empty confirmed Goals, Plans, or Work Items.

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
- a real Codex/Pi/Claude memory replay reconstructing several concurrent plans with evidence-backed status.

## 13. Non-Goals

- General-purpose project management or issue tracking.
- Automatic assignment of owners, priorities, or delivery commitments.
- Treating Topic Inbox candidates as confirmed plans.
- Deriving progress from tokens, elapsed time, commit count, or activity volume.
- Injecting full raw memories or session transcripts into every Agent context.
