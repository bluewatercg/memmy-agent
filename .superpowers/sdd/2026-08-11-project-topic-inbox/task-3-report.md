# Task 3 Report

## Files

- Shared schemas: `App/backend/local-api-contracts/src/memory-runtime.ts`
- Memory domain and HTTP: `Memory/src/service/topic-inbox/{topic-inbox-types,project-topic-inbox}.ts`, `Memory/src/service/memory-service.ts`, `Memory/src/server/http.ts`, `Memory/src/client/rest-client.ts`
- Backend adapters/proxy: `App/backend/src/adapters/outbound/memory-client/{types,memory-layer-endpoints,http-memory-client,memos-sqlite-memory-client}.ts`, `App/backend/src/services/panel-service.ts`, `App/backend/src/adapters/inbound/local-api/routes/agent-runtime/panel.ts`
- Focused tests: Memory REST/topic service, shared contracts, backend HTTP client, inbound local API routes.

## Decisions

- Shared strict Zod schemas are the cross-process source of truth. Candidate decisions are a discriminated union with positive `expectedVersion`.
- Topic operations require canonical project/workspace scope and are checked against the authenticated principal. List responses contain summaries/counts only; raw evidence appears only in bounded evidence expansion (maximum 100 rows).
- Candidate decisions compare the persisted version before mutation. A stale request maps to HTTP 409 and includes the candidate's current version/status in the conflict message. Refresh delegates to Task 2's durable cursor-based idempotency.
- Decision actor fields (`source`, `adapterId`, `requestId`) propagate into audit actor metadata; decision responses return `auditId`.
- Merge is transactional: both source and target versions must match, evidence is attached through repository deduplication, target advances once, source becomes `merged`, and one audit is written.
- Split is transactional: selected evidence must belong to the source namespace/topic, a new active topic is created, source advances once with selected source IDs removed, and one audit is written.
- Pending candidates remain records only. They are not included in stable project-context rendering and do not materialize memory until approval.

## Exact Verification

- `cd Memory && npm test -- --run tests/contract/memory-rest-service.test.ts` -> PASS, 1 file / 19 tests.
- `cd App/backend && npx vitest run src/tests/memory-runtime-contracts.test.ts src/adapters/outbound/memory-client/tests/http-memory-client.test.ts` -> PASS, 2 files / 73 tests.
- `cd App/backend && npx vitest run src/adapters/inbound/local-api/tests/agent-runtime-routes.test.ts` -> PASS, 1 file / 11 tests.
- `cd Memory && npm test -- --run tests/service/evolution/project-topic-inbox.test.ts` -> PASS, 1 file / 14 tests.
- `cd App/backend/local-api-contracts && npm run typecheck` -> PASS.
- `cd Memory && npm run typecheck` -> PASS.
- `cd App/backend && npm run typecheck` -> PASS (includes Memory and local-api-contracts builds).

## Concerns

- The embedded SQLite backend adapter exposes the new interface as explicitly unavailable because topic inbox requires the Memory service topic repository; the HTTP adapter is the supported path.
- No UI or historical backfill was implemented, per Task 3 scope.

## Fix Round 1

- Added transactional repository evidence movement. Split removes selected rows from the source and moves them exactly once to the new topic; merge moves all source evidence and leaves the merged source empty/status `merged`. Invalid split rolls back without creating a topic.
- Memory REST now consumes `@memmy/local-api-contracts` as a workspace dependency and validates all topic request/query inputs with the shared strict schemas. Refresh and candidate decision use existing idempotency storage.
- Candidate and topic optimistic conflicts now return HTTP 409 with structured `details` containing entity ID, current version, and current status.
- Memory REST client now exposes the shared HTTP DTO inputs/outputs rather than internal topic domain result types. Backend panel mutations merge runtime request/adapter/source fields before forwarding.

Exact fresh verification:

- `cd Memory && npm test -- --run tests/service/evolution/project-topic-inbox.test.ts tests/contract/memory-rest-service.test.ts` -> PASS, 2 files / 35 tests.
- `cd App/backend && npx vitest run src/tests/memory-runtime-contracts.test.ts src/adapters/outbound/memory-client/tests/http-memory-client.test.ts src/adapters/inbound/local-api/tests/agent-runtime-routes.test.ts && npm run typecheck` -> PASS, 3 files / 84 tests; backend typecheck and prerequisite Memory/contracts builds passed.

- Exact REST regression extension: strict unknown fields and invalid statuses return 400; evidence limit above 100 returns 400; identical refresh `requestId` replays the same response. `cd Memory && npm test -- --run tests/contract/memory-rest-service.test.ts` -> PASS, 1 file / 19 tests.

## Fix Round 2

- Unified topic mutation actor metadata (`source`, `adapterId`, `requestId`) across refresh/decision/merge/split strict schemas; PanelService runtime enrichment is accepted by Memory.
- Shared API errors retain typed conflict `details`; backend `MemoryLayerError` exposes them. Idempotent replay now returns the exact stored response without adding undeclared fields.
- Merge clears the merged source's `sourceMemoryIds`; shared contracts build before Memory in the verified command and dependency graph remains acyclic.
- `cd Memory && npm test -- --run tests/service/evolution/project-topic-inbox.test.ts tests/contract/memory-rest-service.test.ts` -> PASS, 2 files / 35 tests.
- `cd App/backend && npx vitest run src/tests/memory-runtime-contracts.test.ts src/adapters/outbound/memory-client/tests/http-memory-client.test.ts src/adapters/inbound/local-api/tests/agent-runtime-routes.test.ts` -> PASS, 3 files / 84 tests.
- `npm run build -w @memmy/local-api-contracts && npm --prefix Memory run typecheck && npm --prefix App/backend run typecheck` -> PASS.

- Continued round 2: local error envelope explicitly maps `MemoryLayerError.details`; exact local 409 regression passed (12/12 route tests). Embedded topic operations now report a read/write-neutral 503 message.
- Clean generated-artifact proof: `mv App/backend/local-api-contracts/dist /tmp/memmy-contracts-dist-round2 && npm run build -w @memmy/local-api-contracts && npm --prefix Memory run typecheck && rm -rf /tmp/memmy-contracts-dist-round2` -> PASS; contracts dist was rebuilt from absence before Memory typecheck.

- Final round 2 closure: deterministic merge fixture asserts conflict rollback, exact source evidence removal, merged status/empty source IDs, and target unique evidence cardinality. Decision idempotency now stores the complete HTTP response, preserving exact `serverTime`/`auditId`; regression asserts one mutation/audit and runtime actor provenance. Stable context directly excludes the pending candidate.
- Embedded list/evidence exact `memory_layer_unavailable` 503 status/message assertion passes.
- Fresh verification: `cd Memory && npm test -- --run tests/contract/memory-rest-service.test.ts tests/service/evolution/project-topic-inbox.test.ts` -> PASS, 2 files / 35 tests.
- Fresh verification: `cd App/backend && npx vitest run src/tests/memory-runtime-contracts.test.ts src/adapters/outbound/memory-client/tests/http-memory-client.test.ts src/adapters/outbound/memory-client/tests/memos-sqlite-memory-client.test.ts -t "topic|structured|explicit 503" src/adapters/inbound/local-api/tests/agent-runtime-routes.test.ts && npm run typecheck` -> PASS, 4 files / 6 focused tests (95 skipped by filter), backend typecheck and prerequisite builds pass.

## Fix Round 3

- Standard root/backend build, typecheck, and test prerequisites now build local API contracts before Memory while retaining Memory's version-sync lifecycle.
- Restored legacy `duplicate: true` idempotency replay by default; only strict topic routes request exact stored replay. Merge and split now store complete exact HTTP responses under their request identity.
- Added structured upstream conflict parsing, PanelService four-mutation provenance, and all-six embedded topic operation 503 regressions.
- `cd Memory && npm test -- --run tests/contract/memory-rest-service.test.ts tests/service/session/session-lifecycle.test.ts tests/service/evolution/project-topic-inbox.test.ts` -> PASS, 3 files / 38 tests.
- `cd App/backend && npx vitest run src/adapters/outbound/memory-client/tests/http-memory-client.test.ts src/adapters/outbound/memory-client/tests/memos-sqlite-memory-client.test.ts src/adapters/inbound/local-api/tests/agent-runtime-routes.test.ts src/services/tests/agent-runtime-services.test.ts -t "topic|structured|provenance" && npm run typecheck` -> PASS, 4 files / 6 focused tests; 44 skipped by filter; typecheck passed.
- Clean standard script proof: `mv App/backend/local-api-contracts/dist /tmp/contracts-dist-r3 && npm --prefix App/backend run typecheck && rm -rf /tmp/contracts-dist-r3` -> PASS; the unmodified standard backend script rebuilt contracts first, then Memory with version sync.

## Fix Round 4

- Topic refresh/decision/merge/split route idempotency calls are explicitly awaited inside their `try` blocks, so stale-version errors produce structured 409 responses. Added direct REST assertions for candidate/merge/split conflict IDs and current versions.
- `cd Memory && npm test -- --run tests/contract/memory-rest-service.test.ts` -> PASS, 1 file / 20 tests.
- `cd App/backend && npm run typecheck` -> PASS, including contracts and Memory prerequisite builds.

Concern resolved: merge/split exact topic routes now use an explicit synchronous `atomicReplay` idempotency option. It wraps the topic callback and idempotency INSERT in the same `Repositories.transaction`; serialization/save failure rolls back the domain transaction via SQLite savepoint semantics. Async decision remains on its existing exact replay path.

- `cd Memory && npm test -- --run tests/contract/memory-rest-service.test.ts tests/service/evolution/project-topic-inbox.test.ts && npm run typecheck` -> PASS, 2 files / 36 tests and Memory typecheck.

## Fix Round 5 Continuation

- Added per-key in-process serialization around all idempotent operations (refresh, decision, merge, split and legacy callers). The first request runs and persists; same-key concurrent callers await the lock, reload the durable response, and receive exact or legacy replay semantics without ON CONFLICT overwrite.
- Added a deterministic `Promise.all` decision replay regression asserting identical response, one mutation/audit, and stable-context exclusion.
- `cd Memory && npm test -- --run tests/contract/memory-rest-service.test.ts` -> PASS, 1 file / 20 tests; `npm run typecheck` -> PASS.

- Durable claim continuation: idempotency keys now include canonical namespace hash; SQLite `INSERT OR IGNORE` creates an immutable in-flight claim, conflicting hashes fail, matching contenders bounded-wait and reload, completion uses conditional UPDATE, and failures remove only their own in-flight claim. Fixed lock cleanup with stable entry identity.
- `cd Memory && npm test -- --run tests/contract/memory-rest-service.test.ts tests/service/session/session-lifecycle.test.ts` -> PASS, 2 files / 23 tests; Memory typecheck passed before the compatibility rerun.

## Fix Round 6

- Atomic merge/split replay now retains the durable in-flight claim throughout the same SQLite transaction as domain mutation, audit, and conditional completion; the prior pre-run abandon path was removed. Any callback or completion failure rolls back the savepoint, then failure cleanup removes only the matching claim.
- Completed-claim reload now validates the row exists instead of relying on a non-null assertion.
- Fresh `cd Memory && npm run typecheck` -> PASS; `npm test -- --run tests/contract/memory-rest-service.test.ts tests/service/evolution/project-topic-inbox.test.ts` -> PASS, 2 files / 36 tests.

Residual risk: the durable lease marker currently has no explicit owner/expiry columns and no independent two-connection crash-recovery test; bounded wait returns a deterministic in-progress conflict after timeout. Cross-process exactly-once for async completion therefore remains limited by the existing SQLite schema and is not claimed.
