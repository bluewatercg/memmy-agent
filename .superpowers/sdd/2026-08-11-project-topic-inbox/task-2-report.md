# Task 2 Report

## Files

- Added `Memory/src/service/topic-inbox/project-topic-inbox.ts`
- Added `Memory/src/service/topic-inbox/topic-matcher.ts`
- Added `Memory/src/service/topic-inbox/topic-analysis.ts`
- Added `Memory/src/service/topic-inbox/auto-approval-policy.ts`
- Added `Memory/src/service/topic-inbox/topic-inbox-types.ts`
- Updated `Memory/src/service/worker/job-handlers.ts`
- Updated `Memory/src/service/evolution/reward-pipeline.ts`
- Updated `Memory/src/service/embedding/embedding-job-processor.ts`
- Updated `Memory/src/service/memory-service.ts`
- Updated `Memory/src/types.ts` and `Memory/src/index.ts`
- Added focused inbox and worker tests.

## Decisions

- Topic analysis validates the complete model result before opening the repository transaction; invalid output leaves the prior topic and candidate state intact.
- Analysis input hashes include the prior topic version and material evidence identity/version/content hash, making unchanged ingest idempotent while quality/reward changes re-run analysis.
- Matching uses private thresholds over normalized semantic signals from trace text, tags, tools, error signatures, and persisted topic signals. Ambiguous matches remain unassigned.
- Candidate replacement uses repository supersession. Pending candidates do not create memories. Approved candidates use the existing memory builder and evolution-memory upsert, with source L1 provenance and an audit record.
- Automatic approval is restricted to verified, high-confidence, low-risk, non-sensitive, conflict-free L2 candidates with concrete successful verification evidence. L3 and Skill never auto-approve.
- Durable jobs reuse the existing worker lease, retry, failure, and dead-letter behavior. Dedupe keys include memory content hash for ingest and namespace plus evidence cursor for refresh.

## Verification

### RED

`cd Memory && npm test -- --run tests/service/evolution/project-topic-inbox.test.ts tests/service/evolution/project-topic-worker.test.ts`

Failed as expected because `project-topic-inbox.js` did not exist.

### Focused Task 2

`cd Memory && npm test -- --run tests/service/evolution/project-topic-inbox.test.ts tests/service/evolution/project-topic-worker.test.ts`

Result: 2 files passed, 11 tests passed.

### Required Evolution Suite

`cd Memory && npm test -- --run tests/service/evolution/project-topic-inbox.test.ts tests/service/evolution/project-topic-worker.test.ts tests/service/evolution/orchestration.test.ts tests/service/evolution/policy-induction.test.ts`

Result: 4 files passed, 25 tests passed.

### Memory Typecheck

`cd Memory && npm run typecheck`

Result: TypeScript completed successfully with no diagnostics.

## Concerns

- None within Task 2 scope. API, UI, and backfill were intentionally not implemented.

## Review Fix Round 1

- Grounded automatic approval in explicit cited L1 evidence IDs and persisted successful verification facts; failed, negated, mixed, security, destructive, release, credential, access-control, and migration evidence fails closed.
- Required canonical runtime namespace for candidate decisions and namespace-scoped lookup.
- Added correct manual L3/Skill materialization, deterministic multi-candidate pairing, authoritative-memory supersession, embedding/structured matcher signals, multi-role evidence metadata, and quality-rating ingest triggers.

`cd Memory && npm test -- --run tests/service/evolution/project-topic-inbox.test.ts tests/service/evolution/project-topic-worker.test.ts`

Result: 2 files passed, 12 tests passed.

`cd Memory && npm test -- --run tests/service/evolution/project-topic-inbox.test.ts tests/service/evolution/project-topic-worker.test.ts tests/service/evolution/orchestration.test.ts tests/service/evolution/policy-induction.test.ts`

Result: 4 files passed, 26 tests passed.

`cd Memory && npm run typecheck`

Result: TypeScript completed successfully with no diagnostics.

## Review Fix Round 2

- Restored the strict model `verified` gate alongside persisted cited verification evidence and added failed/unverified regressions.
- Refresh dedupe now hashes the canonical namespace's eligible L1 corpus, including content/version/quality/verification, and performs a true unchanged no-op.
- Propagated every evidence role to analysis, added embedding centroid consumption, stable semantic candidate identities, reorder-independent supersession, atomic approval transactions, and cross-namespace decision rejection.

`cd Memory && npm test -- --run tests/service/evolution/project-topic-inbox.test.ts tests/service/evolution/project-topic-worker.test.ts`

Result: 2 files passed, 15 tests passed.

`cd Memory && npm test -- --run tests/service/evolution/project-topic-inbox.test.ts tests/service/evolution/project-topic-worker.test.ts tests/service/evolution/orchestration.test.ts tests/service/evolution/policy-induction.test.ts`

Result: 4 files passed, 29 tests passed.

`cd Memory && npm run typecheck`

Result: TypeScript completed successfully with no diagnostics.

## Review Fix Round 3

- Added a durable unique analysis claim before the model call; only the owner may atomically persist results, failures release the claim for retry, and concurrent losers return unchanged.
- Persisted topic embedding centroids from evidence, added Unicode-safe stable candidate slots independent of conclusion text, and retained atomic approval rollback behavior.
- Refresh uses durable job state and corpus cursor dedupe; failed active jobs are requeued by the existing repository enqueue semantics.

`cd Memory && npm test -- --run tests/service/evolution/project-topic-inbox.test.ts tests/service/evolution/project-topic-worker.test.ts`

Result: 2 files passed, 15 tests passed.

`cd Memory && npm test -- --run tests/service/evolution/project-topic-inbox.test.ts tests/service/evolution/project-topic-worker.test.ts tests/service/evolution/orchestration.test.ts tests/service/evolution/policy-induction.test.ts`

Result: 4 files passed, 29 tests passed.

`cd Memory && npm run typecheck`

Result: TypeScript completed successfully with no diagnostics.

## Fix Round 4

- Added explicit owner and lease expiry columns for analysis claims, compatible migration of existing v7 databases, deterministic expired-claim recovery, and stale-owner completion guards.
- Refresh now paginates the complete eligible L1 corpus through an injected bounded page size and only treats queued, leased, or succeeded same-cursor jobs as unchanged; failed jobs are durably requeued.
- Topic centroids update whenever vector evidence changes, independently from text/source changes. Mixed dimensions deterministically use the most common dimension (largest dimension breaks ties).
- Candidate slots accept a validated Unicode-normalized model `stableKey`; absent a key, source evidence and category form the deterministic discriminator, preserving changed-conclusion lineage while separating same-title candidates.

`cd Memory && npm run typecheck && npm test -- --run tests/service/evolution/project-topic-inbox.test.ts tests/service/evolution/project-topic-worker.test.ts tests/service/evolution/orchestration.test.ts tests/service/evolution/policy-induction.test.ts tests/repository/project-topic-repository.test.ts tests/repository/sqlite-schema.test.ts`

Result: TypeScript completed successfully with no diagnostics. 6 test files passed, 46 tests passed.

Dedicated WorkerRunner retry/dead-letter tests and an injected approval rollback test remain to be added; existing production worker failure handling and transaction behavior are unchanged and the focused suites pass.
