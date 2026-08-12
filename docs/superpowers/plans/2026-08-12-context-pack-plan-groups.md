# Context Pack Plan Groups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add durable multi-Goal Plans, reviewed Observed Groups, evidence-backed status derivation, paginated group APIs, and V2 context injection without breaking legacy project-context consumers. Desktop client and viewer adoption are excluded from this phase.

**Architecture:** SQLite remains the source of truth through focused repositories and namespace-scoped transactions. `ProjectContextService` owns Goal/Plan/WorkItem invariants and review operations; a separate read-model module combines persisted records with memory/session evidence into `ContextGroup`. REST/local contracts expose mutations and snapshot-paginated reads, while the existing `/state` and stable renderer remain compatibility projections until callers opt into V2.

**Tech Stack:** TypeScript 6, Node.js 20+, better-sqlite3, Zod, Vitest, Fastify backend proxy.

## Global Constraints

- Goal is the durable intended outcome; Plan is the durable execution strategy; Work Item belongs to exactly one Plan after migration.
- Plan belongs to zero or one Goal. Unassigned Plans remain visibly unassigned.
- Observed Groups are persisted candidates and never become confirmed Plans without review.
- Completion requires covering verification evidence or explicit user acceptance; an Agent completion claim produces `verification_pending`.
- Owner, priority, dates, dependencies, milestones, and Goal placement are declared values and are never overwritten by inferred activity.
- Every read and write is namespace scoped; namespace mismatch fails closed.
- Review mutations are atomic, optimistic-versioned, audited, and idempotent.
- Legacy `/api/v1/project-context/state` and `ProjectContextStableResult` remain available throughout this rollout.
- Do not introduce indefinite Goal/Plan dual writes, automatic weak-similarity merges, or percentages without a Work Item denominator.
- Each group exposes deterministic compiled truth plus an evidence timeline ordered by `observedAt ASC, id ASC`; conflicts and multiple active supersession heads remain visible.
- This rollout does not create `MEMORY.md`/`BRAIN.md`, a repo knowledge directory, or brain.md compatibility. That requires a separate approved protocol design and must not be added through the skill installer in these tasks.
- Do not modify `App/frontend/desktop`; desktop API consumption, viewer UI, styling, localization, interaction tests, and browser smoke are deferred to a separately approved phase.

---

## File Map

- `Memory/src/service/project-context/project-context-types.ts`: authoritative domain records, mutation inputs, V2 read shapes, cursor/error types.
- `Memory/src/storage/schema.ts`: SQLite v8 schema and deterministic imported-Plan backfill.
- `Memory/src/storage/repositories.ts`: namespace-scoped Goal/Plan/WorkItem/ObservedGroup/evidence/migration-ledger persistence.
- `Memory/src/service/project-context/project-context-service.ts`: durable mutations, optimistic concurrency, focus compatibility, atomic review operations.
- `Memory/src/service/project-context/group-read-model.ts`: evidence classification, grouping, status derivation, progress, Agent/session activity.
- `Memory/src/service/project-context/group-pagination.ts`: immutable read-revision cursor creation and replay.
- `Memory/src/service/memory-service.ts`: facade methods and existing idempotency/audit integration.
- `Memory/src/server/http.ts`: Memory REST routes, parsing, HTTP 409/422/cursor errors.
- `App/backend/local-api-contracts/src/memory-runtime.ts`: shared Zod contracts and inferred public types.
- `App/backend/src/adapters/outbound/memory-client/{types.ts,http-memory-client.ts,memory-layer-endpoints.ts}`: Memory client methods.
- `App/backend/src/services/panel-service.ts` and `App/backend/src/adapters/inbound/local-api/routes/agent-runtime/panel.ts`: backend proxy routes.

---

### Task 1: Domain Contracts and Shared Schemas

**Files:**
- Modify: `Memory/src/service/project-context/project-context-types.ts`
- Modify: `App/backend/local-api-contracts/src/memory-runtime.ts`
- Modify: `App/backend/local-api-contracts/src/index.ts`
- Create: `App/backend/src/tests/project-context-contracts.test.ts`

**Interfaces:**
- Produces: `ProjectPlanRecord`, `ProjectObservedGroupRecord`, `ProjectAcceptanceCriterion`, `ProjectContextTimelineEntry`, `ContextGroup`, `ProjectContextPackV2`, `ProjectPlanCreateInputSchema`, `ProjectPlanPatchInputSchema`, `ProjectGroupListInputSchema`, and four review input schemas.
- Consumes: existing `RuntimeNamespaceSchema`, mutation provenance, actor references, and project-context records.

- [ ] **Step 1: Write failing schema contract tests**

Add cases proving: criterion IDs are required and unique; Plan `goalId` is nullable; Plan mutation requires `expectedVersion`; review mutations require `expectedVersion` plus `idempotencyKey`; group sections/status filters reject unknown values; cursor is opaque; `progress` is absent when no denominator exists; `compiledTruth` carries authority/source evidence; timeline entries require stable IDs and valid chronological fields.

```ts
expect(ProjectPlanCreateInputSchema.parse({
  ...mutation(), stableKey: "context-pack-groups", title: "Context groups",
  acceptanceCriteria: [{ id: "rest-contract", text: "REST contract passes" }]
}).acceptanceCriteria[0]?.id).toBe("rest-contract");
expect(() => ProjectGroupMergeInputSchema.parse({ ...mutation(), targetId: "plan-2" }))
  .toThrow(/expectedVersion|idempotencyKey/);
```

- [ ] **Step 2: Run the contract test and confirm RED**

Run: `npm --prefix App/backend test -- src/tests/project-context-contracts.test.ts`
Expected: FAIL because the Plan/Group schemas are not exported.

- [ ] **Step 3: Add exact domain and API types**

Define the design fields without generic metadata substitutes. Use discriminated unions for `kind: "plan" | "observed"`, literal status/timeline enums, `ProjectAcceptanceCriterion[]`, deterministic `compiledTruth`, ordered `ProjectContextTimelineEntry[]`, optional `progress`, and explicit truncation/evidence availability structures. Keep legacy schemas unchanged.

- [ ] **Step 4: Run contract tests and typecheck**

Run: `npm --prefix App/backend test -- src/tests/project-context-contracts.test.ts && npm --prefix App/backend/local-api-contracts run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add Memory/src/service/project-context/project-context-types.ts App/backend/local-api-contracts/src/memory-runtime.ts App/backend/local-api-contracts/src/index.ts App/backend/src/tests/project-context-contracts.test.ts
git commit -m "feat(context): define plan group contracts"
```

### Task 2: SQLite v8 Migration and Durable Repositories

**Files:**
- Modify: `Memory/src/storage/schema.ts`
- Modify: `Memory/src/storage/repositories.ts`
- Test: `Memory/tests/repository/sqlite-schema.test.ts`
- Test: `Memory/tests/service/project-context/project-context-service.test.ts`

**Interfaces:**
- Consumes: Task 1 domain records.
- Produces: repository methods `insertPlan`, `getPlan`, `listPlans`, `updatePlan`, `archivePlan`, `insertObservedGroup`, `updateObservedGroup`, `listObservedGroups`, `replaceGroupEvidence`, `getMigrationBatch`, and `transaction`-protected dependency validation.

- [ ] **Step 1: Write failing v7-to-v8 migration tests**
Seed v7 Goals and Work Items, open `MemoryDb`, then assert one deterministic imported Plan per namespace, every legacy Work Item has a valid `plan_id`, Goal ownership is preserved, migration ledger is succeeded, rerunning migration creates no duplicate Plan, and the pre-v8 backup remains readable.

```ts
expect(db.prepare("SELECT COUNT(*) count FROM project_plans").get()).toEqual({ count: 1 });
expect(db.prepare("SELECT plan_id FROM project_context_work_items WHERE id='work-1'").get())
  .toEqual({ plan_id: expectedImportedPlanId(namespaceId) });
```

- [ ] **Step 2: Run the migration test and confirm RED**

Run: `npm --prefix Memory test -- tests/repository/sqlite-schema.test.ts`
Expected: FAIL because schema version 8 and Plan tables do not exist.

- [ ] **Step 3: Implement schema v8 and deterministic backfill**

Add normalized tables for Plans, Plan dependencies, phases, milestones, acceptance criteria, Observed Groups, group evidence ownership, read revisions, and migration ledger. Add `plan_id` to Work Items, backfill inside the existing schema transaction, validate ownership, then enforce the required relation using SQLite's table-rebuild pattern. Index every namespace/status/order lookup and enforce `UNIQUE(namespace_id, stable_key)`.

- [ ] **Step 4: Add repository tests for namespace isolation, optimistic versions, and cycles**

Cover same stable key in different namespaces, stale expected version rejection, atomic dependency-cycle rejection under one transaction, and unavailable evidence references remaining readable.

- [ ] **Step 5: Implement repository methods with tight SQL projections**

Parse JSON columns once at the repository boundary. Mutations must include `namespace_id` in lookup predicates; updates use `WHERE id=? AND namespace_id=? AND version=?` and distinguish missing records from version conflicts.

- [ ] **Step 6: Run repository and schema tests**

Run: `npm --prefix Memory test -- tests/repository/sqlite-schema.test.ts tests/service/project-context/project-context-service.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add Memory/src/storage/schema.ts Memory/src/storage/repositories.ts Memory/tests/repository/sqlite-schema.test.ts Memory/tests/service/project-context/project-context-service.test.ts
git commit -m "feat(context): persist plans and observed groups"
```

### Task 3: Plan Mutations and Atomic Review Operations

**Files:**
- Modify: `Memory/src/service/project-context/project-context-service.ts`
- Modify: `Memory/src/service/memory-service.ts`
- Test: `Memory/tests/service/project-context/project-context-service.test.ts`

**Interfaces:**
- Consumes: Task 2 repositories and existing `MemoryService.idempotent()` / audit infrastructure.
- Produces: `createPlan`, `patchPlan`, `archivePlan`, `confirmGroup`, `mergeGroup`, `splitGroup`, `dismissGroup`, and deterministic legacy primary/focus projection.

- [ ] **Step 1: Write failing service tests for Plan invariants**

Cover unassigned Plan creation, Goal namespace mismatch, immutable stable-key uniqueness, Work Item requiring `planId`, Plan reassignment retaining Work Items, dependency cycle conflict, stale `expectedVersion`, and archive behavior.

- [ ] **Step 2: Write failing atomic review tests**

Assert merge closes the source and attaches all evidence in one transaction; split rejects missing/duplicated evidence IDs without changing state; failed destination writes leave source state untouched; retrying the same idempotency key returns the original result; key reuse with a changed payload fails.

- [ ] **Step 3: Run focused service tests and confirm RED**

Run: `npm --prefix Memory test -- tests/service/project-context/project-context-service.test.ts`
Expected: FAIL on missing Plan and review methods.

- [ ] **Step 4: Implement Plan and review commands**

Use `Repositories.transaction()` around each review operation. Resolve every record by `(id, namespaceId)`, validate expected versions before changes, use normalized sorted evidence IDs in idempotency fingerprints, write one audit entry with before/after versions and actor/request IDs, and retire merged stable keys through `mergedIntoId`.

- [ ] **Step 5: Preserve deterministic legacy behavior**

Keep `read().activeGoal` and `focusedWorkItem`; select primary Goal by explicit namespace metadata then `updatedAt DESC, id ASC`. Preserve explicit caller focus; never infer focus from Agent activity.

- [ ] **Step 6: Run service tests and Memory typecheck**

Run: `npm --prefix Memory test -- tests/service/project-context/project-context-service.test.ts && npm --prefix Memory run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add Memory/src/service/project-context/project-context-service.ts Memory/src/service/memory-service.ts Memory/tests/service/project-context/project-context-service.test.ts
git commit -m "feat(context): add atomic plan review commands"
```

### Task 4: Evidence-Backed Group Read Model

**Files:**
- Create: `Memory/src/service/project-context/group-read-model.ts`
- Modify: `Memory/src/service/project-context/project-context-service.ts`
- Test: `Memory/tests/service/project-context/group-read-model.test.ts`

**Interfaces:**
- Consumes: persisted Plans/Observed Groups/Work Items, memory provenance, session and Topic evidence.
- Produces: `buildContextGroups(input: GroupReadInput): ContextGroup[]` as a pure deterministic function, including compiled truth and timeline projections.

- [ ] **Step 1: Write table-driven status tests**

Cover `planned`, `in_progress`, `verification_pending`, `completed`, `blocked`, cleared blocker, `stale`, `unknown`, and `abandoned`. Include the plausible bug where an unrelated newer passing test must not clear an older focused failure.

```ts
expect(statusFor([failure("test:A"), success("test:B")])).toBe("blocked");
expect(statusFor([failure("test:A"), fix("test:A"), success("test:A")])).toBe("completed");
```

- [ ] **Step 2: Write grouping, Agent activity, and dual-track tests**

Assert priority order: explicit Plan/Work Item ID, stable key, reviewed alias, strong same-scope intent, then candidate. Weak matches create conflicts. Session identity comes from provenance; unknown sources are retained; one activity belongs to one Plan. Assert confirmed compiled truth is derived from declared Plan authority, observed compiled truth from reviewed candidate fields, timeline ordering is `observedAt ASC, id ASC`, supersession reasons remain linked, and multiple active heads/equal-coverage contradictions produce conflicts instead of concatenated truth.

- [ ] **Step 3: Run the new test and confirm RED**

Run: `npm --prefix Memory test -- tests/service/project-context/group-read-model.test.ts`
Expected: FAIL because `buildContextGroups` does not exist.

- [ ] **Step 4: Implement pure evidence normalization and status derivation**

Normalize stable criterion, Work Item, command/test, and affected-scope IDs before grouping. Sort evidence deterministically by observed time and ID. Build compiled truth without an LLM rewrite, and project immutable evidence/review/status events into the timeline. Free-text similarity may emit `possible_duplicate` only; it cannot merge truths, prove coverage, or clear failures. Compute progress from completed/non-archived Work Items and omit it at zero denominator.

- [ ] **Step 5: Implement evidence availability and conflict explanations**

Return `available`, `partial`, or `unavailable`; downgrade a status dependent on missing evidence to `unknown`; populate `reason`, `evidenceIds`, and conflicts so the UI can explain every effective status.

- [ ] **Step 6: Run focused tests**

Run: `npm --prefix Memory test -- tests/service/project-context/group-read-model.test.ts tests/service/project-context/project-context-service.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add Memory/src/service/project-context/group-read-model.ts Memory/src/service/project-context/project-context-service.ts Memory/tests/service/project-context/group-read-model.test.ts
git commit -m "feat(context): derive evidence backed group status"
```

### Task 5: Snapshot Pagination and V2 Stable Rendering

**Files:**
- Create: `Memory/src/service/project-context/group-pagination.ts`
- Modify: `Memory/src/service/project-context/project-context-service.ts`
- Modify: `Memory/src/service/memory-service.ts`
- Modify: `Memory/src/service/read-model/panel-read.ts`
- Test: `Memory/tests/service/project-context/group-pagination.test.ts`
- Test: `Memory/tests/service/project-context/project-context-service.test.ts`

**Interfaces:**
- Consumes: Task 4 `ContextGroup[]`.
- Produces: `listGroups(request): ProjectContextGroupPage`, `renderGroupAudit(group): ProjectContextGroupAudit`, and `renderStableV2(namespace, budget): ProjectContextPackV2`.

- [ ] **Step 1: Write failing snapshot traversal tests**

Fetch page 1, mutate an item, fetch page 2 with the cursor, and assert no duplicate/omission from the original revision. Assert new refresh sees the mutation; expired, unknown-revision, and filter-mismatched cursors fail with distinct stable codes.

- [ ] **Step 2: Implement immutable revision cursors**

Persist ordered group IDs plus normalized filter hash and expiry in the read-revision table. Encode only revision ID and last tuple in the opaque cursor; never trust caller-provided sort/filter state. Delete expired revisions opportunistically after reads.

- [ ] **Step 3: Write failing renderer budget tests**

Assert active Goals precede blocked high-priority Plans, group summaries and compiled truth are never split, newest timeline entries appear only after their group summary, timeline detail is reduced before a group is omitted, raw evidence is excluded, and truncation counts/cursor are accurate at the existing minimum renderer budget.

- [ ] **Step 4: Implement `ProjectContextPackV2` rendering**

Reuse the current budget fitter but render confirmed and observed sections independently. Render each included group's compiled truth before optional newest timeline entries; complete timelines remain detail/audit-only. Keep existing `renderStable()` unchanged as the compatibility projection; add explicit V2 facade methods rather than changing legacy return types in place.

Add a separate deterministic read-only group audit renderer with `## Current Truth` and `## Timeline`, provenance/evidence references, read revision, generated time, availability, and conflicts. Do not change `renderMemoryMarkdownBundle()` or make this audit projection importable through the general memory Markdown importer.

- [ ] **Step 5: Run focused pagination/render tests**

Run: `npm --prefix Memory test -- tests/service/project-context/group-pagination.test.ts tests/service/project-context/project-context-service.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add Memory/src/service/project-context/group-pagination.ts Memory/src/service/project-context/project-context-service.ts Memory/src/service/memory-service.ts Memory/src/service/read-model/panel-read.ts Memory/tests/service/project-context/group-pagination.test.ts Memory/tests/service/project-context/project-context-service.test.ts
git commit -m "feat(context): add paginated V2 group views"
```

### Task 6: Memory REST Contract

**Files:**
- Modify: `Memory/src/server/http.ts`
- Test: `Memory/tests/contract/memory-rest-service.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 3, and 5 facade methods and Zod schemas.
- Produces: `/plans`, `/groups`, review actions, and V2 context-pack routes while retaining `/state`.

- [ ] **Step 1: Write failing end-to-end REST tests**

Exercise authenticated Plan CRUD/archive, group filters/detail/audit, all review actions, snapshot cursor traversal, `Idempotency-Key`, expected-version 409 body, dependency-cycle 409, invalid input 422, namespace mismatch, and legacy `/state` compatibility. Assert the group audit has deterministic truth/timeline sections and the existing memory Markdown export/import shape remains unchanged.

- [ ] **Step 2: Run the REST contract and confirm RED**

Run: `npm --prefix Memory test -- tests/contract/memory-rest-service.test.ts`
Expected: FAIL with route-not-found responses.

- [ ] **Step 3: Add strict route parsers and error mapping**

Parse shared schemas at the HTTP boundary. Map `PROJECT_CONTEXT_VERSION_CONFLICT` to 409 with expected/current versions, dependency cycles to 409, semantic validation to 422, cursor errors to 400/410 as specified by the shared error schema, and namespace/auth failures through existing policy.

- [ ] **Step 4: Implement routes without duplicating service logic**

Pass header idempotency keys and principal/request provenance into `MemoryService`; return typed public records. Expose the group audit as a read-only route and never pass it to general memory Markdown import. Keep existing Goal/Work Item/focus routes operational.

- [ ] **Step 5: Run REST and type checks**

Run: `npm --prefix Memory test -- tests/contract/memory-rest-service.test.ts && npm --prefix Memory run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add Memory/src/server/http.ts Memory/tests/contract/memory-rest-service.test.ts
git commit -m "feat(context): expose plan group REST APIs"
```

### Task 7: Backend Proxy

**Files:**
- Modify: `App/backend/src/adapters/outbound/memory-client/types.ts`
- Modify: `App/backend/src/adapters/outbound/memory-client/http-memory-client.ts`
- Modify: `App/backend/src/adapters/outbound/memory-client/memory-layer-endpoints.ts`
- Modify: `App/backend/src/services/panel-service.ts`
- Modify: `App/backend/src/adapters/inbound/local-api/routes/agent-runtime/panel.ts`
- Test: `App/backend/src/adapters/outbound/memory-client/tests/http-memory-client.test.ts`
- Test: `App/backend/src/adapters/inbound/local-api/tests/agent-runtime-routes.test.ts`

**Interfaces:**
- Consumes: shared schemas and Memory REST routes.
- Produces: typed backend methods and local runtime routes for Plan and Group reads/actions.

- [ ] **Step 1: Write failing endpoint inventory and serialization tests**

Assert every new endpoint, including group audit, is registered once, IDs are URL encoded, query filters/cursors are schema-normalized, version/idempotency fields survive proxying, and responses are rejected when they violate shared schemas.

- [ ] **Step 2: Run focused client/route tests and confirm RED**

Run: `npm --prefix App/backend test -- src/adapters/outbound/memory-client/tests/http-memory-client.test.ts src/adapters/inbound/local-api/tests/agent-runtime-routes.test.ts`
Expected: FAIL because backend client methods and routes are absent.

- [ ] **Step 3: Implement outbound client and panel service methods**

Use the endpoint registry rather than hard-coded duplicate paths. Preserve Memory HTTP status/error envelopes so backend consumers can distinguish version conflict, expired cursor, and validation failure.

- [ ] **Step 4: Implement local runtime routes**

Validate request and response with Task 1 schemas. Add V2 capability selection while keeping old state methods callable. Do not add or modify a desktop runtime client.

- [ ] **Step 5: Run backend tests**

Run: `npm --prefix App/backend test -- src/adapters/outbound/memory-client/tests/http-memory-client.test.ts src/adapters/inbound/local-api/tests/agent-runtime-routes.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add App/backend/src/adapters/outbound/memory-client App/backend/src/services/panel-service.ts App/backend/src/adapters/inbound/local-api/routes/agent-runtime/panel.ts App/backend/src/adapters/outbound/memory-client/tests/http-memory-client.test.ts App/backend/src/adapters/inbound/local-api/tests/agent-runtime-routes.test.ts
git commit -m "feat(app): proxy plan group APIs"
```

### Task 8: Incremental Observed-Group Extraction

**Files:**
- Create: `Memory/src/service/project-context/group-extraction.ts`
- Modify: `Memory/src/service/memory-service.ts`
- Modify: `Memory/src/service/project-context/project-context-service.ts`
- Test: `Memory/tests/service/project-context/group-extraction.test.ts`

**Interfaces:**
- Consumes: new memory/Topic evidence and existing LLM structured-completion client.
- Produces: idempotent `refreshObservedGroups(namespace, evidenceIds)` with one schema-directed repair.

- [ ] **Step 1: Write failing extraction tests**

Cover explicit IDs/stable keys, reviewed aliases, candidate creation for unknown work, weak-similarity duplicate conflict, dismissed group staying dismissed on reordered evidence, reactivation on changed evidence-ID set, malformed output repair once, second failure preserving prior groups, and no mutation of confirmed Plan fields.

- [ ] **Step 2: Run extraction tests and confirm RED**

Run: `npm --prefix Memory test -- tests/service/project-context/group-extraction.test.ts`
Expected: FAIL because the extraction module is absent.

- [ ] **Step 3: Implement structured extraction as candidate proposals only**

Use a strict output schema. Resolve deterministic identifiers before any model suggestion. Store model-suggested owner/priority/dates/dependencies only in `proposedFields`; never write them to a confirmed Plan. Fingerprint normalized evidence IDs so repeated refresh is idempotent.

- [ ] **Step 4: Implement failure preservation and audit**

Perform one schema-directed repair; after the second malformed result record the failed run and return the previous view. A failed extraction cannot delete or empty confirmed records or reviewed candidates.

- [ ] **Step 5: Run extraction and regression tests**

Run: `npm --prefix Memory test -- tests/service/project-context/group-extraction.test.ts tests/service/evolution/project-topic-inbox.test.ts tests/service/project-context/group-read-model.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add Memory/src/service/project-context/group-extraction.ts Memory/src/service/memory-service.ts Memory/src/service/project-context/project-context-service.ts Memory/tests/service/project-context/group-extraction.test.ts
git commit -m "feat(context): extract observed plan groups"
```

### Task 9: End-to-End Compatibility and Replay Verification

**Files:**
- Modify: `Memory/tests/contract/memory-rest-service.test.ts`
- Modify: `Memory/tests/service/project-context/project-context-service.test.ts`
- Modify: `App/backend/src/adapters/inbound/local-api/tests/agent-runtime-routes.test.ts`
- Modify: relevant project-context documentation only where existing public API docs enumerate routes.

**Interfaces:**
- Consumes: all prior tasks.
- Produces: release evidence for the complete contract and no new runtime API.

- [ ] **Step 1: Add the real cross-Agent replay fixture**

Replay Codex, Pi, and Claude sessions contributing to two Plans under one Goal plus one unassigned Plan. Include an error/fix/verification chain, one claimed-but-unverified completion, a weak duplicate, unknown-source evidence, an archived evidence reference, and a supersession branch with two active heads.

- [ ] **Step 2: Assert end-to-end outcomes**

Verify separate groups, deterministic compiled truth, chronological timeline with supersession provenance, deterministic read-only group audit, unchanged general memory Markdown round-trip, explicit active-head conflict, Agent/session attribution, `completed` only for covered criteria, `verification_pending` for the unsupported claim, cleared blocker for matching verification, explicit missing-evidence availability, and stable legacy `/state` projection. Also assert this implementation creates no `MEMORY.md`, `BRAIN.md`, repo knowledge directory, or skill-installer mutation.

- [ ] **Step 3: Run focused cross-layer suites**

Run: `npm --prefix Memory test -- tests/repository/sqlite-schema.test.ts tests/service/project-context tests/contract/memory-rest-service.test.ts`
Expected: PASS.

Run: `npm --prefix App/backend test -- src/adapters/outbound/memory-client/tests/http-memory-client.test.ts src/adapters/inbound/local-api/tests/agent-runtime-routes.test.ts`
Expected: PASS.


- [ ] **Step 4: Run affected package typechecks**

Run: `npm --prefix Memory run typecheck && npm --prefix App/backend/local-api-contracts run typecheck && npm --prefix App/backend run typecheck`
Expected: PASS.

- [ ] **Step 5: Smoke the running API stack**

Start the existing Memory and backend services, create two Plans and one candidate through REST, traverse group pages, retry one review mutation with the same idempotency key, load V2 context through the backend route, and verify legacy state. Record exact observed responses in the execution report; do not claim unexercised routes or desktop behavior.

- [ ] **Step 6: Update existing API documentation and commit**

Document route inputs, cursor/error semantics, V2 opt-in, and compatibility behavior only in existing public API docs that currently list project-context routes.

```bash
git add Memory/tests App/backend/src/adapters docs
git commit -m "test(context): verify multi-agent plan groups"
```
