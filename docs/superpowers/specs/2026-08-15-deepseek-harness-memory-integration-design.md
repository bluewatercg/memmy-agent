# DeepSeek Harness Memory Integration

## Status

Approved architecture; implementation not started.

## Goal

Integrate DeepSeek Harness (DSH) with Memmy Memory as a first-class agent source and runtime client. The integration must support historical session import, real-time memory recall, session and turn lifecycle capture, asset-memory feedback, and resumable incremental synchronization.

The integration must not replace DSH's model provider or modify the DSH core. DSH remains responsible for its agent loop and plugin runtime. Memmy remains responsible for memory storage, retrieval, provenance, asset lifecycle, and evolution.

## Scope

### Included

- A Memmy Agent Adapter identified as `deepseek_harness`.
- A DSH plugin installed and managed by Memmy.
- Discovery of the DSH home directory from `DSH_HOME`, or the default `~/.dsh`.
- Import of compressed and uncompressed DSH session JSONL files.
- Real-time session open/close and turn start/complete calls.
- Pre-step memory recall and structured context injection.
- Capture of user, assistant, and tool activity with provenance.
- Asset candidate, validation, activation, deprecation, recall, and outcome integration through existing Memmy APIs.
- Incremental checkpoints, retryable failures, and idempotent replay.
- Installation, status, health check, and removal of the DSH integration.

### Excluded

- Changing DSH's model routing or provider configuration.
- Forking or patching the DSH core.
- Replacing DSH's session log.
- Deleting DSH sessions during uninstall.
- Making Memmy a hard dependency for a DSH model turn.

## Architecture

```text
DeepSeek Harness
  ├─ Memmy DSH plugin
  │   ├─ session lifecycle
  │   ├─ pre-step recall
  │   ├─ turn/step capture
  │   ├─ asset recall outcome
  │   └─ local retry queue
  │
  └─ DSH session files
      └─ session.jsonl or session.jsonl.zstd

Memmy
  ├─ DSH Agent Adapter
  │   ├─ source discovery
  │   ├─ history reader
  │   ├─ event mapper
  │   ├─ incremental checkpoint
  │   └─ installer/status
  │
  └─ Memory Runtime
      ├─ sessions and turns
      ├─ memory search/add
      ├─ asset lifecycle
      ├─ recall events
      └─ rewards/evolution
```

The real-time path and historical path share identity and idempotency contracts. They do not read each other's private state.

## Runtime Data Flow

### Session

On DSH session boot, the plugin sends `sessions/open` with:

- `sourceAgent: "deepseek_harness"`;
- DSH session id;
- profile id, project id, and workspace id when available;
- working directory;
- start timestamp.

On normal shutdown it closes the corresponding Memmy session. Interrupted sessions remain recoverable and are not treated as completed.

### Recall

Before an admitted DSH step, the plugin sends `memory/search` with the session namespace, project/workspace scope, user input, task type, and event identity. Results are injected as a clearly delimited structured context section:

```text
<memmy-recall>
...
</memmy-recall>
```

The plugin must not rewrite the user's original message. Missing or transient Memmy availability does not block the model turn; ambiguous identity, namespace, or project scope fails closed for the memory operation.

### Capture

At turn completion, the plugin sends `turns/:turnId/complete` containing the user input, assistant output, tool activity, outcome, and source provenance. Tool-heavy intermediate events retain their parent turn and step ids. Only completed or explicitly finalized turns are eligible for durable-memory processing.

### Assets

Reusable strategies, skills, and failure-avoidance lessons are submitted as asset candidates. Memmy owns validation, review, activation, deprecation, reward, and evolution policy. The plugin reports asset recall and outcomes; it does not duplicate asset decision logic.

## Historical Import

The adapter scans:

- `$DSH_HOME/sessions/**/session.jsonl.zstd`;
- `$DSH_HOME/sessions/**/session.jsonl`.

It must support zstd and plain JSONL, map session/turn/step/tool/message records to Memmy contracts, and continue after malformed records while recording retryable diagnostics. Pagination must respect complete session and turn boundaries.

Each source checkpoint records at least:

- source path;
- file size and modification time;
- byte offset or event cursor;
- last imported external event id;
- scan status and failure details.

When a previously scanned file changes, the adapter must rescan the affected range and rely on event idempotency to avoid duplicate durable records.

## Identity and Idempotency

All paths use:

```text
sourceAgent = "deepseek_harness"
externalSessionId = DSH session id
externalTurnId = DSH turn id
externalEventId = DSH event id or session sequence
```

Canonical keys are:

```text
sessionKey = sourceAgent + ":" + externalSessionId
turnKey = sessionKey + ":turn:" + externalTurnId
eventKey = sessionKey + ":event:" + externalEventId
```

Repeated realtime delivery and later historical import must return or reuse the existing result. They must not duplicate memory records, session/turn records, asset rewards, or recall outcomes.

## Failure and Recovery

- Recall failure: log a diagnostic and continue the DSH turn without injected memory.
- Capture failure: enqueue an authenticated retry record locally.
- DSH interruption: preserve `open`, `started`, or `incomplete` state and reconcile on restart.
- Missing identity, namespace, or project: do not write memory or lifecycle data.
- Unsupported DSH plugin capability: expose history import readiness and disable only the unavailable runtime feature.
- Corrupt one session file: record the file error and continue scanning other sessions.

Retry processing is bounded, authenticated, idempotent, and observable. Secrets, raw credentials, and full bulky logs must not enter Memmy diagnostics.

## Integration Lifecycle

The adapter reports distinct states:

```text
not_connected
detected
plugin_installed
history_sync_ready
runtime_ready
error
```

Installation must detect `dsh` or `npx @deepseek-ai/dsh`, resolve `DSH_HOME`, install or update only Memmy-owned plugin/configuration, and run a health check plus minimal recall/capture smoke test. Removal deletes Memmy-owned integration files but preserves DSH sessions and user configuration.

The manifest records the tested DSH version and plugin capability contract. Runtime capability detection takes precedence over version strings because DSH is currently a developer preview and may introduce breaking changes.

## Security and Privacy

- Use the existing Memmy runtime authentication mechanism.
- Keep credentials in the client-owned secret source; never write them into the plugin source, manifests, logs, or specification.
- Preserve session, project, and workspace namespace boundaries.
- Do not inject memories across namespaces.
- Do not delete source session files.
- Redact or omit sensitive tool output from diagnostics according to existing Memmy policy.

## Verification Contract

The implementation is complete only when these observable contracts are covered:

1. DSH session files are discovered under default and `DSH_HOME` paths.
2. Plain and zstd JSONL sessions import successfully.
3. Malformed records do not abort unrelated session imports.
4. Re-running import is idempotent.
5. Modified files resume from a checkpoint without duplicate durable records.
6. A runtime session opens, recalls memory, starts and completes a turn, and records provenance.
7. Memmy outage does not block a DSH model turn and capture retries later.
8. Ambiguous namespace or identity does not write memory.
9. Asset recall and outcome use the existing asset contracts.
10. Plugin installation, status, health, and removal preserve unrelated DSH state.
11. A real DSH smoke flow confirms injected memory is observable and the completed turn is searchable afterward.

## Implementation Order

1. Define the DSH adapter identity, source manifest, and session parser contracts.
2. Implement historical discovery, parsing, mapping, checkpoints, and idempotent import.
3. Implement the DSH runtime plugin for session, turn, recall, capture, and retry.
4. Connect asset recall/outcome and reward paths.
5. Implement installer, status, health check, and removal.
6. Run focused tests, a Memmy runtime smoke test, and a real DSH end-to-end smoke flow.
