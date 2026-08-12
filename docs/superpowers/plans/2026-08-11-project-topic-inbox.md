# Project Topic Inbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace routine per-L1 review with project-scoped, incrementally updated topic packages and governed candidate conclusions.

**Architecture:** Add a deep `ProjectTopicInbox` module inside Memory. It owns matching, incremental model analysis, candidate lifecycle, automatic L2 approval, audit writes, and projections behind `ingest`, `list`, `decide`, and `refresh`. Persist topic state in the existing database, route work through the existing worker, expose one shared Zod contract, and add one Memory inbox sub-page.

**Tech Stack:** TypeScript 6, Node.js 24, better-sqlite3, Vitest, Zod, React, existing Memory worker/governance modules

## Global Constraints

- L1 remains source evidence and is never replaced or deleted by topic analysis.
- Every read and write uses the existing canonical project namespace ID.
- Unchanged refreshes create no topic, candidate, or memory versions.
- Only verified, high-confidence, low-risk, non-sensitive L2 may auto-approve.
- L3, Skill, security, destructive, release, credential, access-control, and migration conclusions never auto-approve.
- Pending candidates never enter authoritative project context.
- Approved conclusions are ordinary L2/L3/Skill memories with source relations, audit history, and reversible versions.
- Clustering thresholds and approval rules remain internal to `ProjectTopicInbox`.

---

### Task 1: Topic Persistence And Repository

**Files:**
- Modify: `Memory/src/storage/schema.ts`
- Modify: `Memory/src/storage/repositories.ts`
- Modify: `Memory/src/storage/backend.ts`
- Modify: `Memory/src/types.ts`
- Modify: `Memory/tests/repository/sqlite-schema.test.ts`
- Create: `Memory/tests/repository/project-topic-repository.test.ts`

**Interfaces:**
- Produces: `ProjectTopicRecord`, `ProjectTopicCandidateRecord`, `ProjectTopicEvidenceRecord`, and `ProjectTopicRepository`.
- Invariant: every repository query requires `namespaceId`; evidence uniqueness is `(topicId, memoryId)`.

- [ ] **Step 1: Write failing schema and repository tests**

Require schema version `7`, migration ID `007_project_topic_inbox`, and tables:

```text
project_topics
project_topic_evidence
project_topic_candidates
project_topic_analysis_runs
```

Test insert/get/list/update with optimistic `version`, evidence deduplication, candidate supersession, analysis-run idempotency by `inputHash`, and cross-namespace exclusion.

- [ ] **Step 2: Run RED tests**

Run:

```bash
cd Memory
npm test -- --run tests/repository/sqlite-schema.test.ts tests/repository/project-topic-repository.test.ts
```

Expected: fail because schema v7 and `ProjectTopicRepository` do not exist.

- [ ] **Step 3: Implement schema v7 and repository**

Add normalized records with JSON only for bounded arrays/metadata. Add indexes for namespace/status/update ordering, topic evidence lookup, candidate topic/status lookup, and unique analysis input hashes. Expose repository methods:

```ts
insertTopic(topic: ProjectTopicRecord): ProjectTopicRecord;
getTopic(id: string, namespaceId: string): ProjectTopicRecord | undefined;
listTopics(namespaceId: string, status?: ProjectTopicStatus[]): ProjectTopicRecord[];
updateTopic(topic: ProjectTopicRecord, expectedVersion: number): ProjectTopicRecord;
attachEvidence(evidence: ProjectTopicEvidenceRecord): ProjectTopicEvidenceRecord;
listEvidence(topicId: string, namespaceId: string): ProjectTopicEvidenceRecord[];
insertCandidate(candidate: ProjectTopicCandidateRecord): ProjectTopicCandidateRecord;
listCandidates(topicId: string, namespaceId: string): ProjectTopicCandidateRecord[];
updateCandidate(candidate: ProjectTopicCandidateRecord, expectedVersion: number): ProjectTopicCandidateRecord;
recordAnalysisRun(run: ProjectTopicAnalysisRunRecord): ProjectTopicAnalysisRunRecord;
findAnalysisRun(namespaceId: string, inputHash: string): ProjectTopicAnalysisRunRecord | undefined;
```

Register `topics` on `Repositories` and include new tables in bundle export/import with namespace scoping.

- [ ] **Step 4: Run GREEN tests and commit**

Run the Task 1 command; expect all pass. Commit:

```bash
git add Memory/src/storage Memory/src/types.ts Memory/tests/repository
git commit -m "feat(memory): persist project topic inbox"
```

### Task 2: Deep Topic Inbox Module And Worker Integration

**Files:**
- Create: `Memory/src/service/topic-inbox/project-topic-inbox.ts`
- Create: `Memory/src/service/topic-inbox/topic-matcher.ts`
- Create: `Memory/src/service/topic-inbox/topic-analysis.ts`
- Create: `Memory/src/service/topic-inbox/auto-approval-policy.ts`
- Create: `Memory/src/service/topic-inbox/topic-inbox-types.ts`
- Modify: `Memory/src/service/evolution/evolution-job-processor.ts`
- Modify: `Memory/src/service/worker/job-handlers.ts`
- Modify: `Memory/src/service/memory-service.ts`
- Modify: `Memory/src/types.ts`
- Create: `Memory/tests/service/evolution/project-topic-inbox.test.ts`
- Create: `Memory/tests/service/evolution/project-topic-worker.test.ts`

**Interfaces:**
- Produces:

```ts
interface ProjectTopicInbox {
  ingest(memoryId: string): Promise<TopicIngestResult>;
  list(namespace: RuntimeNamespace, query?: TopicInboxQuery): TopicInboxView;
  decide(candidateId: string, decision: TopicCandidateDecision): Promise<TopicDecisionResult>;
  refresh(namespace: RuntimeNamespace): Promise<TopicRefreshResult>;
}
```

- Adds durable job types `topic_ingest` and `topic_refresh`.

- [ ] **Step 1: Write failing matching and lifecycle tests**

Cover: related traces across episodes join one topic; error/fix/verification ordering; unrelated generic terms stay separate; ambiguous evidence remains unassigned; new evidence increments one topic; identical refresh is idempotent; changed conclusions supersede candidates; failed model output preserves the prior version.

Use a deterministic `LlmClient.completeJson` stub that returns explicit topic and candidate JSON. Assert observable topic/candidate records, not prompt text.

- [ ] **Step 2: Write failing automatic approval tests**

Use a table test over layer/risk/confidence/verification/sensitive category/conflict. Require only this shape to auto-approve:

```ts
{
  proposedLayer: "L2",
  risk: "low",
  confidence: "high",
  verificationStatus: "verified",
  conflicts: [],
  sensitiveCategories: []
}
```

Also require a concrete successful verification evidence marker and deduplication against active/pending memory.

- [ ] **Step 3: Run RED tests**

```bash
cd Memory
npm test -- --run tests/service/evolution/project-topic-inbox.test.ts tests/service/evolution/project-topic-worker.test.ts
```

Expected: fail because the module and job handlers do not exist.

- [ ] **Step 4: Implement `ProjectTopicInbox`**

Use embeddings plus normalized tags/files/modules/tools/error signatures and episode relations inside `topic-matcher.ts`. Keep thresholds private. In `topic-analysis.ts`, hash previous topic version plus materially changed evidence, call the Evolution model with `operation: "topic.inbox.analyze"`, validate the full result before a transaction, then update topic/evidence/candidates atomically.

`auto-approval-policy.ts` returns a decision object with policy version and rejection reasons. Approved L2 writes through existing memory construction/governance methods, preserves `sourceMemoryIds`, and records audit metadata `{ topicId, candidateId, model, policyVersion, automatic: true }`.

- [ ] **Step 5: Wire durable jobs and triggers**

Add processor callbacks and job dedupe keys. Enqueue `topic_ingest` after L1 summary/embedding readiness and after reward/quality/verification changes. `refresh(namespace)` enqueues one `topic_refresh` job keyed by namespace plus evidence cursor. Reuse existing retry/dead-letter behavior.

- [ ] **Step 6: Run GREEN tests and commit**

Run Task 2 tests, then focused existing evolution tests:

```bash
cd Memory
npm test -- --run tests/service/evolution/project-topic-inbox.test.ts tests/service/evolution/project-topic-worker.test.ts tests/service/evolution/orchestration.test.ts tests/service/evolution/policy-induction.test.ts
```

Commit:

```bash
git add Memory/src/service Memory/src/types.ts Memory/tests/service/evolution
git commit -m "feat(memory): aggregate L1 traces into project topics"
```

### Task 3: Shared Contract And HTTP Boundary

**Files:**
- Modify: `App/backend/local-api-contracts/src/memory-runtime.ts`
- Modify: `App/backend/local-api-contracts/src/index.ts`
- Modify: `Memory/src/server/http.ts`
- Modify: `Memory/src/client/rest-client.ts`
- Modify: `Memory/tests/contract/memory-rest-service.test.ts`
- Modify: `App/backend/src/adapters/outbound/memory-client/types.ts`
- Modify: `App/backend/src/adapters/outbound/memory-client/memory-layer-endpoints.ts`
- Modify: `App/backend/src/adapters/outbound/memory-client/http-memory-client.ts`
- Modify: `App/backend/src/adapters/outbound/memory-client/tests/http-memory-client.test.ts`
- Modify: `App/backend/src/adapters/inbound/local-api/routes/agent-runtime/panel.ts`
- Modify: `App/backend/src/tests/memory-runtime-contracts.test.ts`

**Interfaces:**
- Produces shared Zod schemas/types for list, refresh, decision, topic merge/split, and evidence expansion.
- Routes:

```text
GET  /api/v1/topic-inbox
POST /api/v1/topic-inbox/refresh
POST /api/v1/topic-inbox/candidates/:id/decision
POST /api/v1/topic-inbox/topics/:id/merge
POST /api/v1/topic-inbox/topics/:id/split
GET  /api/v1/topic-inbox/topics/:id/evidence
```

- [ ] **Step 1: Write failing contract tests**

Define fixtures containing project group, topic summary/counts/version, candidate cards, bounded evidence summaries, stale/conflict states, and refresh result. Require malformed enum/version/namespace inputs to fail Zod validation.

- [ ] **Step 2: Write failing REST tests**

Assert auth scopes, namespace fail-closed behavior, optimistic candidate version conflict (`409` with current version), refresh idempotency, decision audit metadata, and bounded evidence response. Assert pending candidates are absent from stable project context.

- [ ] **Step 3: Run RED tests**

```bash
cd Memory
npm test -- --run tests/contract/memory-rest-service.test.ts
cd ../App/backend
npx vitest run src/tests/memory-runtime-contracts.test.ts src/adapters/outbound/memory-client/tests/http-memory-client.test.ts
```

Expected: fail on missing schemas/routes/client methods.

- [ ] **Step 4: Implement shared schemas and adapters**

Use discriminated unions for candidate decision:

```ts
type TopicCandidateDecision =
  | { action: "approve"; expectedVersion: number }
  | { action: "edit_and_approve"; expectedVersion: number; title: string; conclusion: string; proposedLayer: "L2" | "L3" | "Skill" }
  | { action: "reject"; expectedVersion: number; reason?: string }
  | { action: "defer"; expectedVersion: number; reason?: string };
```

Keep evidence raw text out of list responses; return it only from the evidence route. Extend Memory REST client and desktop backend proxy with the same method names.

- [ ] **Step 5: Run GREEN tests and commit**

Run Task 3 command; expect pass. Commit:

```bash
git add App/backend/local-api-contracts App/backend/src/adapters App/backend/src/tests Memory/src/server Memory/src/client Memory/tests/contract
git commit -m "feat(api): expose project topic inbox"
```

### Task 4: Desktop Topic Inbox, Backfill, And End-to-End Verification

**Files:**
- Modify: `App/frontend/desktop/src/api/memory-runtime-client.ts`
- Modify: `App/frontend/desktop/src/pages/memory-page.tsx`
- Modify: `App/frontend/desktop/src/analytics/page-view.ts`
- Modify: `App/frontend/desktop/src/i18n/messages.ts`
- Create: `App/frontend/desktop/src/pages/memory/topic-inbox-sub-page.tsx`
- Create: `App/frontend/desktop/src/pages/memory/tests/topic-inbox-sub-page.test.tsx`
- Modify: `App/frontend/desktop/src/pages/memory/tests/memory-runtime-fixtures.ts`
- Modify: `App/frontend/desktop/src/pages/memory/tests/fixtures.ts`
- Modify: `Memory/src/service/topic-inbox/project-topic-inbox.ts`
- Create: `Memory/tests/service/evolution/project-topic-backfill.test.ts`
- Create: `tests/smoke/project-topic-inbox-smoke.test.ts`

**Interfaces:**
- Adds Memory sub-page ID `topic-inbox` and runtime client methods matching Task 3.
- Backfill uses `refresh(namespace)` plus durable analysis cursors; no external state file.

- [ ] **Step 1: Write failing UI tests**

Cover project then topic grouping, collapsed raw evidence, topic counts/status, expand candidate cards, approve/edit/reject/defer, optimistic conflict reload, manual refresh busy/error/success states, merge/split controls, and evidence expansion only after click. Verify L3/Skill have no automatic-approval presentation.

- [ ] **Step 2: Write failing backfill tests**

Create many historical L1 rows across two namespaces. Require bounded batches, resumable cursor, no cross-project topic, restart safety, and no duplicates after a second full refresh.

- [ ] **Step 3: Run RED tests**

```bash
cd App/frontend/desktop
npx vitest run src/pages/memory/tests/topic-inbox-sub-page.test.tsx
cd ../../../Memory
npm test -- --run tests/service/evolution/project-topic-backfill.test.ts
```

Expected: fail because the sub-page and backfill path do not exist.

- [ ] **Step 4: Implement the inbox UI**

Add `topic-inbox` first in the Memory work navigation with an inbox icon and pending count. Use full-width topic rows, not nested cards. Each topic expands to candidate cards with explicit action buttons and a separate evidence drawer. The refresh button uses a refresh icon and tooltip. Keep list dimensions stable during loading and action states.

- [ ] **Step 5: Implement bounded backfill**

`refresh(namespace)` reads historical eligible L1 IDs after the stored cursor, enqueues bounded `topic_ingest` jobs, persists cursor/progress in the analysis-run table, and resumes after interruption. A completed refresh reuses the final input hash until evidence changes.

- [ ] **Step 6: Run GREEN tests, type checks, and full suites**

```bash
cd App/frontend/desktop
npx vitest run src/pages/memory/tests/topic-inbox-sub-page.test.tsx
cd ../../../Memory
npm test -- --run tests/service/evolution/project-topic-backfill.test.ts
cd ..
npm run typecheck
npm test -w @memmy/memory
npm test -w @memmy/backend
npm test -w @memmy/frontend-desktop
```

Expected: all pass with zero type errors.

- [ ] **Step 7: Run browser and service smoke verification**

Start the stack on available ports. Seed one project with related migration L1 traces and another with unrelated traces. Trigger refresh, open Memory -> Topic Inbox in Chromium, and verify:

- one migration topic contains configuration, failure, fix, and verification evidence;
- raw L1 is collapsed initially;
- eligible L2 shows an auto-approved audit state;
- L3 remains pending and can be approved;
- adding contradictory evidence blocks auto-approval and shows conflict;
- a second refresh creates no duplicate topic/candidate/memory;
- the second project remains isolated.

Capture desktop and narrow viewport screenshots and confirm no overlap, clipped actions, or blank states.

- [ ] **Step 8: Update skill integration and commit**

Update `skills/memmy-project-summarize/SKILL.md` so Full Summary calls topic-inbox refresh/list and presents the same candidate projection, while retaining its evidence fallback when the endpoint is unavailable. Run the skill validator already used by the repository, then commit:

```bash
git add App/frontend/desktop Memory/src/service/topic-inbox Memory/tests tests/smoke skills/memmy-project-summarize
git commit -m "feat: add project topic inbox"
```

## Final Verification

Run from repository root:

```bash
npm run typecheck
npm test
npm run build
```

Then rerun the real service/browser smoke scenario. Completion requires all spec criteria: project isolation, incremental grouping, error/fix/verification chains, idempotency, automatic L2 hard boundaries, mandatory L3/Skill review, conflict blocking, audit/source provenance, reversible decisions, and resumable backfill.
