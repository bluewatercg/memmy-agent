# Task 1 Report

## Files
- `Memory/src/storage/schema.ts`: schema v7 migration, topic tables, constraints, and indexes.
- `Memory/src/storage/repositories.ts`: topic repository, repository wiring, bundle table registration, and restored `ProjectContextRepository.supersedeFact`.
- `Memory/src/service/memory-service.ts`: namespace-scoped topic bundle export/import filtering.
- `Memory/src/types.ts`: topic, evidence, candidate, and analysis-run records.
- `Memory/tests/repository/sqlite-schema.test.ts`: schema v7 and topic-table migration assertions.
- `Memory/tests/repository/project-topic-repository.test.ts`: topic CRUD/versioning, namespace isolation, evidence deduplication, candidate supersession, and analysis-run idempotency.

## Decisions
- Evidence uniqueness is enforced by `(topic_id, memory_id)` and repository attachment returns the existing record on duplicate attachment.
- Topic and candidate updates use namespace plus expected version predicates and report conflicts when no row is updated.
- Candidate insertion supersedes the referenced predecessor in the same namespace.
- Analysis runs are idempotent by `(namespace_id, input_hash)`.
- Topic bundle rows are filtered by canonical namespace; child rows are also tied to scoped topics, preserving namespace isolation.

## Verification
Command:

```bash
cd Memory
npm test -- --run tests/repository/sqlite-schema.test.ts tests/repository/project-topic-repository.test.ts
```

Output:

```text
Test Files  2 passed (2)
Tests       10 passed (10)
Duration    8.62s
```

Additional check:

```text
npm run typecheck -- --pretty false
completed successfully
```

## Concerns
None.

## Fix Round 1

Addressed review findings by enforcing L1 and namespace evidence validation, atomic candidate supersession and analysis-run idempotency, strictly monotonic optimistic versions, consistent bundle parent/child scoping, and explicit v6-to-v7 index migration coverage. Reformatted the topic repository methods.

Focused command:

```bash
cd Memory
npm test -- --run tests/repository/sqlite-schema.test.ts tests/repository/project-topic-repository.test.ts tests/service/bundle/bundle.test.ts
```

Output:

```text
Test Files  3 passed (3)
Tests       13 passed (13)
Duration    10.83s
```

Type check:

```bash
cd Memory
npm run typecheck -- --pretty false
```

Output: completed successfully.

## Fix Round 2

Changed idempotent inserts to targeted SQLite conflict clauses so primary-key collisions remain errors, added explicit non-optional readback checks, proved candidate supersession rollback on insert failure, restored separate v5-to-current migration coverage, and retained v6-to-v7 index coverage. SQLite serializes the targeted unique-index insert, so the single-statement `ON CONFLICT(namespace_id, input_hash) DO NOTHING` closes the analysis-run competing-writer race without a read-before-write window.

```bash
cd Memory
npm test -- --run tests/repository/sqlite-schema.test.ts tests/repository/project-topic-repository.test.ts tests/service/bundle/bundle.test.ts
```

```text
Test Files  3 passed (3)
Tests       14 passed (14)
Duration    12.68s
```

```bash
cd Memory
npm run typecheck -- --pretty false
```

Output: completed successfully.

## Fix Round 3

Added a deterministic two-connection test against one temporary SQLite database. The synchronous better-sqlite3 API cannot overlap calls within one JavaScript thread, so the test exercises independent connection state and sequential competing writes through the same targeted unique-index conflict path. Both repositories return the first canonical row, and the database contains exactly one logical run without a constraint error.

```bash
cd Memory
npm test -- --run tests/repository/project-topic-repository.test.ts
```

```text
Test Files  1 passed (1)
Tests       6 passed (6)
Duration    4.05s
```

```bash
cd Memory
npm run typecheck -- --pretty false
```

Output: completed successfully.

## Fix Round 4

Replaced the sequential two-connection check with two Node worker threads. Each worker opens an independent `better-sqlite3` connection to the same temporary database, waits until both connections are ready, and then rendezvous on a shared atomic barrier immediately before each of 32 calls to the actual `ProjectTopicRepository.recordAnalysisRun` method. For every shared namespace/input hash, both calls complete and return the same canonical row; a final independent connection observes exactly 32 rows.

This distinguishes the atomic upsert from the old find-then-insert implementation because both workers begin each repository call concurrently. With no row present at the barrier, repeated rounds provide genuine read/write overlap: the old implementation can let both connections observe absence and then race plain inserts, exposing a unique-constraint error, while the targeted `ON CONFLICT(namespace_id, input_hash) DO NOTHING` serializes the conflicting writes and reads back the winner.

```bash
cd Memory
npm test -- --run tests/repository/project-topic-repository.test.ts
```

```text
Test Files  1 passed (1)
Tests       6 passed (6)
Duration    4.71s
```

```bash
cd Memory
npm run typecheck -- --pretty false
```

Output: completed successfully.

## Fix Round 5

Retained both `Worker` handles and added bounded ready, result, and exit promises. Every worker promise has an immediate rejection handler so a startup failure cannot become an unhandled rejection while the peer is still starting. Cleanup now sets and notifies a shared abort flag, terminates every worker, awaits termination and exit settlement, and only then removes the temporary database. The worker checks the abort flag before starting and on both sides of every per-round barrier, so a parent failure releases a peer blocked at startup or rendezvous.

The observable-contract stress was increased from 32 to 64 synchronized rounds; the focused test remained stable at 4.80 seconds. A deterministic transaction arrangement cannot force both old internal read-before-write `SELECT`s to observe absence while preserving the production method's locking behavior: an external deferred transaction that establishes both read snapshots causes the later write upgrade to fail with SQLite `SQLITE_BUSY_SNAPSHOT`, including for the current atomic insert, while `BEGIN IMMEDIATE` serializes the workers before method entry. Intercepting the internal statement would require source inspection or a production test hook. The test therefore makes no false determinism claim: its exact limit is that the barrier synchronizes method entry, not the internal statements, while 64 real two-connection rounds assert the production contract that both calls return one canonical row without unique errors.

```bash
cd Memory
npm test -- --run tests/repository/project-topic-repository.test.ts
```

```text
Test Files  1 passed (1)
Tests       6 passed (6)
Duration    4.80s
```

```bash
cd Memory
npm run typecheck -- --pretty false
```

```text
completed successfully (exit 0)
```
