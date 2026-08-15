# Agent Memory Assets & Cross-Task Evolution Implementation Plan

> **Execution:** Implement phase by phase with focused tests. Preserve existing `MemoryRow`, Episode `rTask`, Topic Decision, and Context Pack contracts.

**Goal:** Add governed, versioned Agent assets; temporal memory validity; explicit loadouts and recall usage; cross-task experience sequences and transfer reward; then add Wiki/CodeGraph asset read APIs without changing current Memory facts or project authority.

**Architecture:** SQLite remains the source of truth. New namespace-scoped repositories store immutable asset versions, temporal-validity versions, loadout bindings, recall events, experience sequences, and transfer reward evidence. Services own lifecycle, authorization, optimistic concurrency, idempotency, temporal projections, and reward eligibility. Existing Memory, Episode, SkillPipeline, Project Context, and Topic Decision records remain evidence sources and compatibility surfaces.

**Compatibility invariants:**

- `MemoryRow`, Markdown import/export, and existing memory relations remain compatible.
- Episode `rTask` remains current-task reward; transfer and risk values are separate evidence.
- Goal/Plan/Work Item authority remains in `ProjectContextService`.
- Topic evidence snapshots, stale sessions, approval, and confirmation rules remain unchanged.
- Namespace checks precede every asset mutation/read; agent visibility checks additionally govern loadout and content reads.
- Asset-version content and historical recall/reward evidence are immutable.

## Phase A: Asset And Temporal Read Model

### Task A1: Add schema v9 governance tables

**Files:**
- Modify: `Memory/src/storage/schema.ts`
- Test: `Memory/tests/repository/memory-asset-repository.test.ts`
- Test: `Memory/tests/repository/memory-temporal-validity-repository.test.ts`

**Steps:**
1. Write migration tests for v8 to v9 and clean database creation.
2. Add `memory_assets`, `memory_temporal_validity`, and `memory_temporal_events` tables plus namespace/status/query indexes.
3. Enforce unique `(namespace_id, stable_key, version)` and immutable source/content fields through repository behavior.
4. Keep foreign keys to existing memories where strict references are valid; keep Episode/Trace/Topic provenance as JSON IDs because evidence may be retained independently.
5. Verify old v8 databases migrate without changing existing records.

### Task A2: Add asset and temporal repositories

**Files:**
- Modify: `Memory/src/storage/repositories.ts`
- Test: `Memory/tests/repository/memory-asset-repository.test.ts`
- Test: `Memory/tests/repository/memory-temporal-validity-repository.test.ts`

**Steps:**
1. Define `MemoryAssetRecord`, applicability, validation stats, and temporal-validity records in the storage contract.
2. Add namespace-scoped create/get/list/version lookup methods for assets.
3. Add create/get/list and optimistic `memoryId + version` update methods for temporal validity.
4. Reject duplicate immutable asset versions with conflicting content.
5. Persist append-only temporal review/invalidation/supersession events with actor, reason, evidence IDs, and project-state references.
6. Add repositories to `Repositories` without changing existing constructors at call sites.

### Task A3: Implement asset lifecycle and temporal projections

**Files:**
- Create: `Memory/src/service/assets/asset-lifecycle-service.ts`
- Create: `Memory/src/service/assets/temporal-validity-service.ts`
- Create: `Memory/src/service/assets/asset-types.ts`
- Test: `Memory/tests/service/assets/asset-lifecycle-service.test.ts`
- Test: `Memory/tests/service/assets/temporal-validity-service.test.ts`

**Steps:**
1. Implement candidate asset creation and version reads with namespace isolation.
2. Implement temporal initialization, review, invalidation, and supersession with optimistic concurrency.
3. Reject supersession across namespaces, to invisible/missing memories, self-links, and relation cycles.
4. Derive `Current Truth`, `Review Queue`, and `Historical Evidence` from storage status, effective interval, review deadline, invalidation, scope, and supersession.
5. Ensure time alone only yields `review_due`; it never proves stale/deprecated.
6. Preserve `createdAt`, `updatedAt`, `observedAt`, effective interval, and review timestamps as separate semantics.

### Phase A verification

Run:

```bash
npm --prefix Memory test -- tests/repository/memory-asset-repository.test.ts tests/repository/memory-temporal-validity-repository.test.ts tests/service/assets/asset-lifecycle-service.test.ts tests/service/assets/temporal-validity-service.test.ts
npm --prefix Memory run typecheck
```

## Phase B: Skill Lifecycle

### Task B1: Implement governed Skill asset state machine

**Files:**
- Modify: `Memory/src/service/assets/asset-lifecycle-service.ts`
- Create: `Memory/src/service/assets/skill-asset-validator.ts`
- Test: `Memory/tests/service/assets/skill-asset-lifecycle.test.ts`

**Steps:**
1. Require invocation guide, normalized procedure JSON, applicability, acceptance/rollback rules, policy/evidence references, support/gain/eta, and trial provenance.
2. Implement `candidate -> reviewing -> active`, rejection, deprecation, and rollback transitions.
3. Require successful Episode/Trace/Policy provenance, explicit validation, minimum trial count, configured threshold, and no unresolved high-risk conflict before activation.
4. Atomically activate one version and deprecate the prior active version.
5. Preserve rejected/deprecated versions and lifecycle audit events.
6. Require stronger evidence for scope expansion and create a new version rather than mutating applicability.

### Task B2: Integrate SkillPipeline output

**Files:**
- Modify: `Memory/src/service/evolution/skill-pipeline.ts`
- Modify: `Memory/src/service/evolution/evolution-job-processor.ts`
- Test: `Memory/tests/service/evolution/skill-pipeline-assets.test.ts`

**Steps:**
1. Map existing SkillPipeline candidate output to a governed Skill asset version.
2. Preserve existing Skill memory creation and callers during the cutover.
3. Store source Memory/Episode/Trace/Policy IDs and narrow initial applicability.
4. Do not auto-activate candidates before lifecycle validation.
5. Make retries idempotent by stable key and content fingerprint.

### Phase B verification

```bash
npm --prefix Memory test -- tests/service/assets/skill-asset-lifecycle.test.ts tests/service/evolution/skill-pipeline-assets.test.ts tests/service/evolution/skill-pipeline.test.ts
npm --prefix Memory run typecheck
```

## Phase C: Agent Loadout And Recall Events

### Task C1: Add loadout and recall schema/repositories

**Files:**
- Modify: `Memory/src/storage/schema.ts`
- Modify: `Memory/src/storage/repositories.ts`
- Test: `Memory/tests/repository/agent-loadout-repository.test.ts`
- Test: `Memory/tests/repository/asset-recall-event-repository.test.ts`

**Steps:**
1. Add version-pinned loadout bindings with mode, priority, scope, retirement rule, and enabled state.
2. Add append-only recall events with offered/used/ignored/failed outcome.
3. Enforce the recall idempotency key `(namespace, episode, asset, version, mode, eventKey)`.
4. Persist temporal-validity version, freshness at recall, eligibility evaluation time, score inputs, and failure reason.

### Task C2: Implement loadout authorization and retirement

**Files:**
- Create: `Memory/src/service/assets/agent-loadout-service.ts`
- Test: `Memory/tests/service/assets/agent-loadout-service.test.ts`

**Steps:**
1. Check namespace, visibility, allowed agents, project/plan/work-item scope, active lifecycle, and fixed asset version.
2. Reject candidate/reviewing/rejected assets and invisible versions.
3. Automatically disable bindings whose `retireWhen` condition is met without changing asset trust status.
4. Support bootstrap, recall, and tool modes with stable priority ordering.

### Task C3: Integrate recall eligibility and usage recording

**Files:**
- Modify: `Memory/src/service/retrieval-service.ts` or the existing retrieval owner identified at implementation time
- Modify: `Memory/src/service/memory-service.ts`
- Test: `Memory/tests/service/assets/asset-recall-flow.test.ts`

**Steps:**
1. Filter by temporal eligibility before semantic ranking.
2. Exclude `review_due` from bootstrap and high-risk execution; exclude stale/superseded/historical from current guidance.
3. Record offered events and expose explicit used/ignored/failed updates.
4. Keep existing ungoverned Memory recall compatible until an asset binding exists.
5. Freeze recall-time validity/freshness in the event; later changes never rewrite it.

### Phase C verification

```bash
npm --prefix Memory test -- tests/repository/agent-loadout-repository.test.ts tests/repository/asset-recall-event-repository.test.ts tests/service/assets/agent-loadout-service.test.ts tests/service/assets/asset-recall-flow.test.ts
npm --prefix Memory run typecheck
```

## Phase D: Experience Sequence And Transfer Reward

### Task D1: Add sequence and transfer evidence persistence

**Files:**
- Modify: `Memory/src/storage/schema.ts`
- Modify: `Memory/src/storage/repositories.ts`
- Test: `Memory/tests/repository/experience-sequence-repository.test.ts`
- Test: `Memory/tests/repository/asset-reward-evidence-repository.test.ts`

**Steps:**
1. Add namespace-scoped sequence metadata and immutable Episode positions.
2. Enforce unique `(namespace, sequence, position)` and one Episode per sequence position.
3. Store solve/curate/verify role plus task/topic/plan/work-item references as non-authoritative provenance.
4. Add append-only asset reward evidence linked to source/target Episode, asset version, recall event, relation confidence, and reward components.

### Task D2: Implement transfer reward calculation

**Files:**
- Create: `Memory/src/service/evolution/asset-reward-service.ts`
- Modify: `Memory/src/service/evolution/reward-pipeline.ts`
- Test: `Memory/tests/service/evolution/asset-transfer-reward.test.ts`

**Steps:**
1. Preserve current `rTask` calculation and Episode reward detail.
2. Compute transfer evidence only for explicit sequences and assets recorded as `used`.
3. Treat Topic/embedding similarity only as discovery signals, never authorization.
4. Apply relation confidence, applicability, usage, and risk factors as specified; negative verification updates failures/risk while preserving raw evidence.
5. Update derived asset validation statistics transactionally from append-only evidence.
6. Never infer reward from offered/ignored/failed recall or merely adjacent Episodes.

### Task D3: Expose lifecycle, loadout, sequence, recall, and reward APIs

**Files:**
- Modify: `Memory/src/service/memory-service.ts`
- Modify: `Memory/src/server/http.ts`
- Modify: `Memory/src/client/rest-client.ts`
- Test: `Memory/tests/contract/memory-asset-rest.test.ts`

**Steps:**
1. Add namespace-scoped list/detail/mutation endpoints with optimistic version and idempotency inputs.
2. Map domain errors to stable HTTP error codes.
3. Keep read endpoints paginated and deterministic.
4. Verify unauthorized namespace/agent reads fail closed.
5. Add audit traversal from active asset to version, source evidence, recall, and reward.

### Phase D verification

```bash
npm --prefix Memory test -- tests/repository/experience-sequence-repository.test.ts tests/repository/asset-reward-evidence-repository.test.ts tests/service/evolution/asset-transfer-reward.test.ts tests/contract/memory-asset-rest.test.ts
npm --prefix Memory run typecheck
```

## Phase E: Wiki And CodeGraph Extensions

### Task E1: Add governed Wiki and CodeGraph content readers

**Files:**
- Create focused service/repository modules under `Memory/src/service/assets/`
- Modify asset REST contracts
- Test: `Memory/tests/service/assets/wiki-codegraph-assets.test.ts`

**Steps:**
1. Add Wiki section reads and CodeGraph symbol/caller/callee/impact-path reads.
2. Reuse the same namespace, visibility, fixed-version, loadout, and recall-event checks.
3. Keep the optional asset types isolated so missing content providers do not affect ChatMemory or Skill flows.

## Final Verification And Review

1. Review the implementation against this plan and the design acceptance criteria.
2. Run all focused asset tests, existing Topic Decision and Project Context contracts, the full Memory suite, and typecheck.
3. Run the Memory service and exercise one end-to-end flow: create candidate Skill asset, review/activate, bind loadout, offer/use it in a later explicit sequence Episode, record target reward, and trace validation evidence back to the asset.
4. Confirm legacy memory search, Episode `rTask`, Context Pack state, and Topic Decision behavior remain unchanged.

```bash
npm --prefix Memory test
npm --prefix Memory run typecheck
```

## Delivery Boundary

Each phase is independently reviewable. Phase A changes no recall behavior. Phase B governs Skill promotion. Phase C changes recall only for explicitly bound assets. Phase D enables transfer validation only through explicit sequence plus actual usage. Phase E remains optional and cannot block Skill or ChatMemory operation.
