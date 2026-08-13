# Task 5 Report: Approval And Execution Policy

## Status
**GREEN** — All tests pass, typecheck clean, committed. Fix Round 1 applied.

## Commit
`9dca9dd` — `feat(memory): execute approved reversible topic actions`
`efd34b2` — `fix(memory): require two confirmations for irreversible execution effects`

## Fix Round 1: Irreversible Two-Confirmation Flow

**Finding:** Irreversible effects (delete/topic_mutation/memory_promotion/authoritative_write/external_write) previously executed after a single confirmation. Policy contract requires a separately recorded second confirmation before execution.

**Changes:**
- `execution-policy.ts`: Added `IRREVERSIBLE_EFFECTS` set and `isIrreversibleEffect()` export. Confirmation-required reason now distinguishes irreversible (two confirmations) from other confirmation effects.
- `proposal-executor.ts`: `confirmExecutionAction` now accepts `idempotencyKey` parameter. Irreversible effects track `confirmationOrdinal` (1→2) in `pendingAction`. First confirmation persists `ConfirmationEvent` (eventId, ordinal, actor, timestamp, actionId, idempotencyKey) and transitions to `awaiting_second_confirmation`. Second distinct confirmation executes handler. Replay of same `idempotencyKey` is a no-op. Rejection at either stage cancels run. `ActionResult` now stores `confirmationEvents[]` array.
- `topic-decision-service.ts` / `memory-service.ts`: Updated `confirmExecutionAction` signatures to accept `idempotencyKey`.

**Tests added (7 new, 43 total execution tests):**
1. First confirmation does not invoke handler; second does
2. Replay of first confirmation (same idempotencyKey) does not count twice
3. Persisted provenance has two events with ordinals 1 and 2
4. Rejection after first confirmation cancels the run
5. Rejection at first confirmation cancels the run
6. Policy: `isIrreversibleEffect` returns true for all 5 irreversible effects
7. Policy: confirmation_required reason mentions "irreversible" and "two separate confirmations"

**Idempotency:** Same `idempotencyKey` replay returns current run unchanged — no confirmation count increment, no handler invocation.

**Audit trail:** Each `ConfirmationEvent` records `eventId`, `ordinal` (1|2), `actor`, `timestamp`, `actionId`, `idempotencyKey` in `ActionResult.confirmationEvents[]`.

## Files
- **Created:**
  - `Memory/src/service/topic-decision/execution-policy.ts` — Policy matrix (automatic/confirmation/forbidden)
  - `Memory/src/service/topic-decision/proposal-executor.ts` — Execution lifecycle (approve/resume/confirm), handlers (draft/create_candidate_task)
  - `Memory/tests/service/topic-decision/execution-policy.test.ts` — 14 policy tests
  - `Memory/tests/service/topic-decision/execution.test.ts` — 16 lifecycle tests
- **Modified:**
  - `Memory/src/service/topic-decision/topic-decision-service.ts` — Exposed `approveProposal`, `resumeExecution`, `confirmExecutionAction`, `registerActionHandler`
  - `Memory/src/service/memory-service.ts` — Injected `projectContextService` into `TopicDecisionService`, exposed execution methods
  - `Memory/src/storage/repositories.ts` — Added `getRun` to `TopicDecisionRepository`

## Tests
- **RED:** 16/16 failed (missing modules)
- **GREEN:** 43/43 pass (21 policy + 22 lifecycle, including 7 new two-confirmation tests)
- **Regressions:** 179/179 pass (topic-decision + project-context)
- **Typecheck:** Clean

## Commands
```bash
# RED
cd Memory && npx vitest run tests/service/topic-decision/execution-policy.test.ts tests/service/topic-decision/execution.test.ts
# Expected: 16 failed

# GREEN
cd Memory && npx vitest run tests/service/topic-decision/ tests/service/project-context/
# Expected: 179 passed

# Typecheck
cd Memory && npx tsc --noEmit
# Expected: clean

# Diff check
git diff --check
# Expected: clean
```

## Decisions
1. **Policy matrix:** Automatic (read/analyze/draft/create_candidate_task), confirmation (authoritative_write/external_write/delete/topic_mutation/memory_promotion), forbidden (unknown/missing recovery/acceptance).
2. **Execution lifecycle:** `approveProposal` validates session/proposal/version/recommended, creates run, executes automatic actions, pauses at confirmation. `resumeExecution` resumes from checkpoint. `confirmExecutionAction` confirms/rejects pending action.
3. **Idempotency:** Action results stored in `run.result.actions[]`; succeeded actions skipped on resume.
4. **Dependency order:** Topological sort before execution.
5. **Checkpoint:** Each action result persisted before starting next.
6. **Rollback metadata:** Confirmation-required actions store `pendingAction` with `rollbackMetadata` (recoveryPoint/effect/target/input).
7. **Stale snapshot:** `resumeExecution` checks session state; marks pending actions as skipped if stale.
8. **Handlers:** `draft` persists artifact via `repos.runtime.insertArtifact`. `create_candidate_task` creates non-focused pending work item with proposal/session provenance via `projectContextService.createWorkItem`.
9. **Namespace:** Topic decisions use `stableHash(namespace)`; project context uses `namespaceIdFromContext(namespace)`. Tests use both appropriately.

## Concerns
1. **No HTTP/UI:** Execution methods exposed on `MemoryService` but not wired to HTTP routes (out of scope).
2. **No staleness detection:** Session marked stale externally; executor checks but does not auto-detect.
3. **Limited handlers:** Only `draft` and `create_candidate_task` implemented; confirmation-only effects (authoritative_write/external_write/delete/topic_mutation/memory_promotion) have no handlers (require real external writes).
4. **Actor validation:** `actor` parameter accepted but not validated (no auth/permission system).
5. **Recovery:** Rollback metadata stored but no automatic rollback on failure (manual intervention required).
