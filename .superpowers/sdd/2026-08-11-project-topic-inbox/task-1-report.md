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
