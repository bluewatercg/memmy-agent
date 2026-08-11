# Context Update Rules

## Evidence buckets

- **Explicit memory**: a user-stated fact, preference, decision, convention, or instruction to remember. This is authoritative for the requested scope, but still must be scoped to the project when written as project context.
- **Git**: branch, HEAD, changed paths, diff statistics, commit subjects, and verified commit contents. A dirty working-tree path is status, not a project decision.
- **Tool result**: a command/test/API result that actually completed. Tool intent, planned commands, raw logs, and model claims without output are not evidence.
- **Memmy history**: related workspace memories used to deduplicate or explain rationale. Current code and current verification outrank stale history.

## Normalization

Write one fact per memory. Include:

```text
Project: <project name>
Fact: <self-contained statement>
Status: current | verified | superseded | conflicted
Evidence: <short Git/tool/test references>
Updated: <date>
```

Strip credentials, access tokens, private keys, cookies, environment values, and large tool output. Replace sensitive values with `[redacted]`; keep only whether a value was present or whether authentication succeeded.

## Layer selection

| Evidence | Layer | Examples |
| --- | --- | --- |
| Current status or one-off verification | L1 | tests passed, files changed, service healthy |
| Reusable decision or failure lesson | L2 | use workspace-scoped namespaces; expired token caused hook failure |
| Stable architecture or boundary | L3 | Memory is the shared persistence layer; Git is not a memory ID source |

Explicit “remember” requests may be written immediately, but they still use the lowest layer that matches the claim. A current Git diff is never L3 solely because it is large.

## Deduplication and conflicts

Search by the fact’s key terms and project name before `memory.add`. Skip an exact or materially equivalent fact. If an existing fact disagrees with current executable evidence, keep the old record, mark the new fact `conflicted` or `superseded`, and surface both IDs for review. Never silently rewrite historical memory.

## Output contract

Report four counts: `written`, `duplicates`, `conflicts`, and `pending`. For every written item include its memory ID and layer. For every pending item state the missing verification; do not claim the project context is fully updated until `memmy-memory get` confirms each write.
