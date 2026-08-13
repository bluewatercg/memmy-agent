# Task 2 Report: Environment Contract

## Completion History

### Commit e7d4caa - Environment Contract Implementation
- Added TOPIC_DECISIONS configuration to Memory package
- Environment variable names: `MEMMY_TOPIC_DECISIONS_ENABLED`, `MEMMY_TOPIC_DECISION_MODELS`
- Default values: `false`, `MiniMax-M2.5,qwen3.7-plus,kimi-k2.5,glm-5`

### Commit 0442502 - Contract Test
- Created `tests/smoke/env-example-contract.test.ts`
- Asserts `.env.example` contains TOPIC_DECISIONS defaults in Memory section
- Verifies defaults appear after EVOLUTION section

### .env.example Update
Added TOPIC_DECISIONS defaults to Memory configuration section:
- `MEMMY_TOPIC_DECISIONS_ENABLED=false`
- `MEMMY_TOPIC_DECISION_MODELS=MiniMax-M2.5,qwen3.7-plus,kimi-k2.5,glm-5`

## Pre-Review Fix (Current Session)

### TypeScript Errors Fixed
Fixed 8 TS2322 diagnostics in topic-decision service and tests:

1. **TopicDecisionSnapshotPayload Type** (`src/types.ts`):
   - Defined `TopicDecisionSnapshotPayload` interface with required fields
   - Added `[key: string]: unknown` index signature for persistence flexibility
   - Updated `TopicDecisionSnapshotRecord.payload` to use typed interface

2. **EvidenceSnapshotResult Type** (`src/service/topic-decision/evidence-snapshot.ts`):
   - Made `EvidenceSnapshotResult` extend `TopicDecisionSnapshotPayload`
   - Ensures type compatibility between builder output and repository record

3. **Repository Parser** (`src/storage/repositories.ts`):
   - Added `TopicDecisionSnapshotPayload` to imports
   - Cast `parseJson` result to `TopicDecisionSnapshotPayload` in `topicDecisionSnapshotFromSql`

4. **Agent Roster Model Selection** (`src/service/topic-decision/agent-roster.ts`):
   - Created `safeGetModel` helper function with explicit `string` return type
   - Used `as string` assertion for array access under `noUncheckedIndexedAccess`
   - Cast `DEFAULT_ROLES[i]` to `string` to handle `noUncheckedIndexedAccess`

5. **Test Builders** (`tests/repository/topic-decision-repository.test.ts`):
   - Added required `version: 1` to `baseRound` and `baseEvidenceRequest` builders
   - Updated `baseSnapshot` payload to include all required fields
   - Fixed JSON payload test to use valid payload structure

6. **Schema Version Contract** (`tests/contract/memory-rest-service.test.ts`):
   - Updated expected schemaVersion from `"7"` to `"8"`
   - Updated expected lastMigrationId from `"007_project_topic_inbox"` to `"008_topic_decisions"`

### Test Results

**Memory Tests:**
```
Test Files  71 passed (71)
Tests       585 passed (585)
Duration    47.77s
```

**Workspace TypeCheck:**
```
npm run workspace:typecheck
All workspaces passed
```

### Files Modified in This Fix
- `Memory/src/types.ts` - Added `TopicDecisionSnapshotPayload` interface
- `Memory/src/service/topic-decision/evidence-snapshot.ts` - Updated `EvidenceSnapshotResult` to extend payload type
- `Memory/src/service/topic-decision/agent-roster.ts` - Added `safeGetModel` helper with explicit string assertion
- `Memory/src/storage/repositories.ts` - Added type import and cast for payload parsing
- `Memory/tests/repository/topic-decision-repository.test.ts` - Fixed test builders with required fields
- `Memory/tests/contract/memory-rest-service.test.ts` - Updated schema version expectations

### Key Technical Decisions
1. **Typed Payload at Ownership Boundary**: Defined payload type in `types.ts` rather than importing from service layer, avoiding circular dependencies
2. **Safe Model Selection**: Used helper function with explicit assertion to satisfy `noUncheckedIndexedAccess` strictness
3. **No Type Weakening**: Fixed errors at source with proper types, not `any` assertions

---

## Fix Round 1 (Review Findings)

### Finding 1: Evidence Summary Bounded Storage

**Issue**: `evidence-snapshot.ts` stored `ev.summary` unbounded in `evidenceContent`, violating required bounded evidence text.

**Fix**: Added explicit conservative bound `EVIDENCE_SUMMARY_MAX_CHARS = 2000` (consistent with project limits: logger 4000, algorithm 200-1500). Applied deterministically per evidence via `boundedSummary()` helper. Hashes remain based on canonical full evidence content for deterministic reproducibility.

**Changes**:
- `Memory/src/service/topic-decision/evidence-snapshot.ts`:
  - Added `EVIDENCE_SUMMARY_MAX_CHARS = 2000` constant
  - Added `boundedSummary(summary: string)` helper
  - Applied bound when storing `evidenceContent[ev.id]`
  - Hash computation unchanged (uses full `ev.summary`)

**Test**: `Memory/tests/service/evidence-snapshot-bounds.test.ts`
  - Proves oversized summaries are bounded at limit
  - Proves short summaries preserved unchanged
  - Proves `inputHash` is stable and based on canonical full evidence

### Finding 2: Agent Roster Invalid Default Model

**Issue**: `agent-roster.ts` used fallback `["default-model"]` when configured models absent, violating environment contract.

**Fix**: Replaced with default four-model roster from task contract: `["MiniMax-M2.5", "qwen3.7-plus", "kimi-k2.5", "glm-5"]`. Config parsing (`parseTopicDecisionModels`) now returns same default array when env not configured.

**Changes**:
- `Memory/src/service/topic-decision/agent-roster.ts`:
  - Added `DEFAULT_TOPIC_DECISION_MODELS` constant (matches env contract)
  - Updated `recommendAgents()` fallback to use default array
- `Memory/src/config/index.ts`:
  - Added `DEFAULT_TOPIC_DECISION_MODELS` constant
  - Updated `parseTopicDecisionModels()` to return default array instead of `[]`

**Test**: `Memory/tests/service/agent-roster-default.test.ts`
  - Proves empty array returns four-model default roster
  - Proves non-empty array uses provided models
  - Proves specialist agent added when requested
  - Proves constant matches environment contract default

**Test Updates** (behavior change):
- `Memory/tests/config.test.ts`: Updated test expectation from `[]` to default array
- `Memory/tests/service/topic-decision/session-start.test.ts`: Updated test expectation from `[]` to default array

### Commands and Results

```bash
# TypeCheck
cd Memory && npm run typecheck
# Result: PASS (no errors)

# Focused Tests
cd Memory && npx vitest run tests/service/evidence-snapshot-bounds.test.ts tests/service/agent-roster-default.test.ts tests/repository/topic-decision-repository.test.ts
# Result: 3 files, 27 tests passed

# Full Test Suite
cd Memory && npm test
# Result: 73 files, 592 tests passed
```

### Files Modified
- `Memory/src/service/topic-decision/evidence-snapshot.ts` (bounded summary)
- `Memory/src/service/topic-decision/agent-roster.ts` (default models constant)
- `Memory/src/config/index.ts` (parseTopicDecisionModels default)
- `Memory/tests/service/evidence-snapshot-bounds.test.ts` (new)
- `Memory/tests/service/agent-roster-default.test.ts` (new)
- `Memory/tests/config.test.ts` (expectation update)
- `Memory/tests/service/topic-decision/session-start.test.ts` (expectation update)