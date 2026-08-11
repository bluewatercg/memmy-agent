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

## Fix Round 1

### Findings Addressed

1. Refresh now snapshots complete serialized `MemoryRow` values and attached vector entries, not only IDs. Keyset pages read only immutable snapshot rows, and `processRefresh` ingests those captured rows. The deterministic boundary test mutates namespace, layer, status, and content after page one and inserts a new row; all and only captured rows are processed once with captured content.
2. Semantic and centroid hashes are separate. The semantic hash excludes vectors and analysis output; the centroid hash includes vector field/content/model/provider. A vector-only delta updates centroid metadata before analysis claiming and returns through the existing successful semantic run without invoking the LLM or candidate reconciliation.
3. `stableKey` remains the title-independent slot identity, while title is now material candidate lifecycle content. A title-only edit creates a replacement candidate and supersedes its predecessor. Unicode fallback without `stableKey` remains deterministic.

### Exact Verification

From `Memory`:

```text
$ npm run typecheck
> tsc -p tsconfig.json --noEmit
(exit 0)

$ npm test -- --run tests/service/evolution/project-topic-inbox.test.ts tests/service/evolution/project-topic-worker.test.ts tests/service/evolution/orchestration.test.ts tests/service/evolution/policy-induction.test.ts tests/repository/project-topic-repository.test.ts tests/repository/sqlite-schema.test.ts tests/service/worker/worker-runtime.test.ts
Test Files  7 passed (7)
Tests  62 passed (62)
Duration  20.23s
(exit 0)
```

### Concerns

None. Snapshot storage is connection-private and released in `finally`; the unrelated untracked plan remains untouched.

## Fix Round 2

### Findings Addressed

1. Captured rows retain snapshot content, but each row is revalidated against the live canonical namespace, L1 layer, activated status, and existence before analysis or persistence. Moved, archived, or deleted rows are skipped and never enter evidence or model input.
2. Snapshot rows are inserted directly with `INSERT ... SELECT`; no full corpus is hydrated. Vector capture runs in bounded 250-ID keyset pages inside the same SQLite transaction/read snapshot as row capture. Traversal remains bounded keyset pagination.
3. Snapshot row and vector capture share one database transaction. The refresh mutation seam proves later content changes do not alter captured analysis input while live eligibility changes still exclude persistence.
4. Removing the final summary vector deletes `embeddingCentroid` while persisting the new centroid input hash.
5. Centroid metadata is updated early only for a vector-only delta with an already successful semantic run. When semantic evidence changed, centroid metadata is staged inside the same transaction as validated analysis, topic/evidence/candidate writes, and successful run completion. Duplicate model slots leave topic metadata/version/evidence/candidates unchanged.

### Exact Verification

From `Memory`:

```text
$ npm run typecheck
> tsc -p tsconfig.json --noEmit
(exit 0)

$ npm test -- --run tests/service/evolution/project-topic-inbox.test.ts tests/service/evolution/project-topic-worker.test.ts tests/service/evolution/orchestration.test.ts tests/service/evolution/policy-induction.test.ts tests/repository/project-topic-repository.test.ts tests/repository/sqlite-schema.test.ts tests/service/worker/worker-runtime.test.ts
Test Files  7 passed (7)
Tests  64 passed (64)
Duration  21.31s
(exit 0)
```

### Concerns

None. The unrelated untracked plan remains untouched.

## Fix Round 3

### Findings Addressed

1. Every existing evidence row is live-revalidated for existence, canonical namespace, L1 layer, and activated status before hash/model input. Persistence revalidates every evidence row in the transaction, and repository attachment requires activated status in addition to L1/namespace.
2. Refresh no longer materializes a corpus-sized array or map. Cursor is derived from the captured snapshot, then bounded pages are read and processed one at a time; only the current page is retained.
3. Snapshot rows and vectors are captured in one bounded SQL transaction. Vector rows are copied in bounded 250-ID keyset batches.
4. Successful semantic transactions always persist `centroidInputHash`, including hash-only changes without a topic version bump. Centroid removal deletes stale `embeddingCentroid` metadata.

### Exact Verification

From `Memory`:

```text
$ npm run typecheck
> tsc -p tsconfig.json --noEmit
(exit 0)

$ npm test -- --run tests/service/evolution/project-topic-inbox.test.ts tests/service/evolution/project-topic-worker.test.ts tests/service/evolution/orchestration.test.ts tests/service/evolution/policy-induction.test.ts tests/repository/project-topic-repository.test.ts tests/repository/sqlite-schema.test.ts tests/service/worker/worker-runtime.test.ts
Test Files  7 passed (7)
Tests  64 passed (64)
Duration  22.87s
(exit 0)
```

### Concerns

None. The unrelated untracked plan remains untouched.

## Fix Round 4

### Findings Addressed

1. Refresh snapshot membership is authoritative: existing evidence absent from the captured snapshot is excluded even if currently live. Direct ingest continues to use live repository evidence.
2. Repository evidence attachment now rejects non-activated L1 rows inside its transaction guard; a direct repository test covers archived evidence.
3. Snapshot cursor computation uses bounded keyset pages and an incremental SHA-256 state rather than corpus-sized `all().map()` materialization.
4. Snapshot cleanup is enclosed in `finally` immediately after acquisition for both refresh enqueue cursor computation and refresh processing, including cursor failures.

### Exact Verification

From `Memory`:

```text
$ npm run typecheck
> tsc -p tsconfig.json --noEmit
(exit 0)

$ npm test -- --run tests/service/evolution/project-topic-inbox.test.ts tests/service/evolution/project-topic-worker.test.ts tests/service/evolution/orchestration.test.ts tests/service/evolution/policy-induction.test.ts tests/repository/project-topic-repository.test.ts tests/repository/sqlite-schema.test.ts tests/service/worker/worker-runtime.test.ts
Test Files  7 passed (7)
Tests  65 passed (65)
Duration  20.89s
(exit 0)
```

### Concerns

None. The unrelated untracked plan remains untouched.

## Fix Round 5

### Finding Addressed

`ProjectTopicRepository.attachEvidence` no longer accepts captured memory authorization. It starts one database transaction, independently fetches the live memory row, and requires current existence, canonical namespace, L1 layer, and activated status before insertion. Direct tests cover live archived, moved-namespace, L2, and deleted states and prove no evidence persists.

### Exact Verification

From `Memory`:

```text
$ npm run typecheck
> tsc -p tsconfig.json --noEmit
(exit 0)

$ npm test -- --run tests/service/evolution/project-topic-inbox.test.ts tests/service/evolution/project-topic-worker.test.ts tests/service/evolution/orchestration.test.ts tests/service/evolution/policy-induction.test.ts tests/repository/project-topic-repository.test.ts tests/repository/sqlite-schema.test.ts tests/service/worker/worker-runtime.test.ts
Test Files  7 passed (7)
Tests  66 passed (66)
Duration  18.84s
(exit 0)
```

### Concerns

None. The unrelated untracked plan remains untouched.
