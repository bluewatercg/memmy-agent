# Task 2 Recovery Cycle 1 Report

Base: `40fbeac2fc1c113b22db8905864c2c698a49d555`

## Files Changed

- `Memory/src/storage/schema.ts`
- `Memory/src/storage/repositories.ts`
- `Memory/src/service/topic-inbox/topic-analysis.ts`
- `Memory/src/service/topic-inbox/project-topic-inbox.ts`
- `Memory/tests/repository/sqlite-schema.test.ts`
- `Memory/tests/repository/project-topic-repository.test.ts`
- `Memory/tests/service/evolution/project-topic-inbox.test.ts`

## Behavioral Decisions

1. Migration recovery changes only legacy `claimed` analysis rows whose lease is NULL to `failed`, clears the owner, and records a deterministic recovery error. Terminal `succeeded` and `failed` rows remain unchanged. Repository claims also directly reclaim NULL-lease legacy rows.
2. Refresh captures the canonical namespace's eligible activated L1 IDs in a private temporary snapshot table, then traverses that fixed ID set with bounded ID keyset pages. Concurrent inserts are outside the snapshot; concurrent ordering-field updates cannot skip or duplicate captured IDs. Snapshot rows are released in `finally`.
3. Analysis input hashes include every persisted vector field, vector content, model, and provider. Vector-only changes therefore rerun analysis and update centroid metadata through a metadata-only repository operation without advancing the topic version or changing candidate lifecycle/version state.
4. Validated `stableKey`, normalized with NFKC and Unicode-aware lowercase, is the primary slot identity with layer. The deterministic fallback hashes normalized Unicode title, sorted evidence IDs, and sorted normalized sensitive categories. Duplicate slots in one model response are rejected during validation, before topic, evidence, or candidate writes.
5. Approval remains one repository transaction. The focused injected-failure test proves rollback after replacement-memory upsert and predecessor supersession: replacement memory absent, predecessor active, no supersedes relation, candidate pending, and audit count unchanged.

## Verification

From `Memory`:

```text
$ npm run typecheck
> tsc -p tsconfig.json --noEmit
(exit 0)

$ npm test -- --run tests/service/evolution/project-topic-inbox.test.ts tests/service/evolution/project-topic-worker.test.ts tests/service/evolution/orchestration.test.ts tests/service/evolution/policy-induction.test.ts tests/repository/project-topic-repository.test.ts tests/repository/sqlite-schema.test.ts tests/service/worker/worker-runtime.test.ts
Test Files  7 passed (7)
Tests  61 passed (61)
Duration  21.18s
(exit 0)

$ git diff --check
(exit 0)
```

## Concerns

None. The unrelated untracked `docs/superpowers/plans/2026-08-11-project-topic-inbox.md` was not modified or staged.
