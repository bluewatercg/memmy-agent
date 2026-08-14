# Topic Decision Automatic Run Design

## Goal

Make one `Start analysis` click create or reuse a topic decision session, run the existing multi-agent decision pipeline synchronously, and display either evidence questions or generated proposals without leaving the user at an unexplained `draft` state.

## Scope

This change is a viewer-side orchestration of existing HTTP routes. It does not add a background job system, change the decision service state machine, auto-approve proposals, or auto-confirm execution effects.

## User Flow

1. The user selects a Workspace and clicks `Start analysis` on a topic card.
2. The viewer creates or reuses the decision session through `POST /api/v1/topic-inbox/topics/:topicId/decisions`.
3. The decision panel opens immediately with an explicit analyzing state. The initiating button is disabled while the request chain is active.
4. The viewer calls `POST /api/v1/topic-inbox/decisions/:sessionId/run` with the session's current `version`.
5. The viewer reloads the decision detail. It never predicts a new version.
6. If the session is waiting for evidence, the viewer stops and displays the existing `Missing information` form.
7. Otherwise, the viewer calls `POST /api/v1/topic-inbox/decisions/:sessionId/debate` with the freshly loaded session version, then reloads the detail again.
8. If debate leaves the session waiting for evidence, the viewer stops and displays the questions.
9. Otherwise, the viewer calls `POST /api/v1/topic-inbox/decisions/:sessionId/proposals` with the newest session version and reloads the final detail.
10. The viewer displays up to three proposal cards. Approval and execution confirmations remain explicit user actions.

## State Rules

The viewer stops automatic progression when the session state is any of:

- `gathering_evidence`
- `awaiting_user_input`
- `blocked_by_evidence`
- `blocked`
- `stale`
- `failed`
- `cancelled`

The viewer may continue from non-terminal decision states such as `draft` and `ready_for_decision`. Every transition uses the `version` returned by the immediately preceding GET response.

## Request Contract

Every mutation includes:

- `namespace`
- `expectedVersion`
- `adapterId: "memory-console"`
- a unique `requestId`

The request IDs use a single click-scoped prefix plus a step suffix (`run`, `debate`, `proposals`) so retries are deterministic within one click while distinct clicks do not collide.

## UI Behavior

While analysis runs, the decision detail is visible and shows:

- `Analyzing topic`
- the current step (`Gathering positions`, `Running debate`, or `Generating proposals`)
- disabled analysis controls

On success, the normal decision renderer replaces the progress state. On a recoverable 409 conflict, the viewer reloads the current decision and displays that state instead of overwriting it. On another error, the panel remains visible, displays the error through the existing error surface, and the topic button becomes usable again.

## Error Handling

- HTTP 409: reload the latest detail and stop the current chain.
- Evidence-blocked state: render questions and stop without treating it as an error.
- Network, model, policy, or server failure: retain the panel, report the existing API error, and re-enable controls.
- Repeated click while a chain is active: ignored by the existing in-flight guard and disabled initiating button.

## Tests

Viewer contract tests will prove:

1. `Start analysis` contains the ordered route sequence: start, run, reload, debate, reload, proposals, reload.
2. Each mutation uses the latest `session.version`, not a predicted increment.
3. Evidence-blocked states stop before debate or proposals.
4. The analyzing panel is visible before the first long-running mutation resolves.
5. Errors restore the initiating control and keep the detail panel visible.

Existing service and HTTP tests remain the authority for model execution, decisionability, optimistic locking, debate, and proposal persistence.

## Deployment Verification

After automated tests pass:

1. Rebuild `memmy-memory:local` from the clean worktree.
2. Recreate the existing `memmy-memory` Compose service without deleting named volumes.
3. Verify health and `MEMMY_TOPIC_DECISIONS_ENABLED=true`.
4. Use Chromium to select a Workspace with topics, click `Start analysis`, observe progress, and verify the resulting evidence form or proposal cards.
