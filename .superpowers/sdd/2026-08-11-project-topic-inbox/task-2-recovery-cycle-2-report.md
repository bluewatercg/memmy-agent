# Task 2 Recovery Cycle 2 Report

## Scope

Cycle 2 fixes are present in the focused Task 2 implementation and tests after commit `e3c1845`. The user-owned untracked plan document was left untouched. No frontend or Task 3 API files were changed.

## Exact fixes and regression coverage

- Legacy claimed analysis rows with null leases are recovered during migration without rewriting terminal rows; repository reclaim is verified after recovery. Covered by `Memory/tests/repository/sqlite-schema.test.ts` and `Memory/tests/repository/project-topic-repository.test.ts`.
- Refresh captures one eligible L1 corpus boundary, uses bounded keyset pages, reads captured rows, and keeps canonical namespace filtering. Concurrent insert, namespace/layer/status/content mutation, and page traversal are covered by `Memory/tests/service/evolution/project-topic-inbox.test.ts`.
- Analysis hashing includes vector identity/content through the centroid input hash path. Vector-only changes update centroid metadata without semantic analysis, topic version, candidate versions, or lifecycle churn. Covered by `Memory/tests/service/evolution/project-topic-inbox.test.ts`.
- Validated stable keys are primary slot identity, with deterministic Unicode-safe fallback. Duplicate model slots fail before topic, evidence, or candidate writes. Title-edit lineage, Chinese/Unicode fallback, and duplicate rollback are covered by `Memory/tests/service/evolution/project-topic-inbox.test.ts`.
- Approval work remains transactional across new-memory upsert, predecessor supersession/relation, candidate update, and audit insertion, so injected post-upsert failures roll back all writes. Existing focused approval/rollback coverage is included in the exact suite.

## Verification

From `Memory`:

```text
$ npm run typecheck
> @memmy/memory@1.0.4 typecheck
> tsc -p tsconfig.json --noEmit

[passed]

$ npm test -- --run tests/service/evolution/project-topic-inbox.test.ts tests/service/evolution/project-topic-worker.test.ts tests/service/evolution/orchestration.test.ts tests/service/evolution/policy-induction.test.ts tests/repository/project-topic-repository.test.ts tests/repository/sqlite-schema.test.ts tests/service/worker/worker-runtime.test.ts

Test Files  7 passed (7)
Tests       69 passed (69)
Duration    23.65s

[passed]
```

No formatter, linter, or project-wide test suite was run.

## Residual risks

The exact focused suite and Memory typecheck pass. No additional project-wide validation was run by instruction; unrelated areas outside the scoped Task 2 files remain covered only by their existing tests.
