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
