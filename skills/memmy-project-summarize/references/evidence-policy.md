# Evidence Policy

Use sources according to what they can prove.

## Source Strength

1. Current executable behavior, checked configuration, and tests run against the current worktree.
2. Stable project contracts such as `AGENTS.md`, accepted specifications, schemas, and architecture decisions that still match implementation.
3. `.planning/**/VERIFICATION.md`, `UAT.md`, completed phase `SUMMARY.md`, and equivalent `docs/planning` completion evidence.
4. `.planning/STATE.md`, current milestone status, Git history, and current diffs.
5. `.planning/PROJECT.md`, `ROADMAP.md`, `REQUIREMENTS.md`, phase `PLAN.md`, `CONTEXT.md`, `RESEARCH.md`, `UI-SPEC.md`, `AI-SPEC.md`, and `docs/planning/**` design documents.
6. Workspace-scoped Memmy history from Codex, Pi, and other agents.

User-approved project contracts may outrank code when they define required behavior rather than describe current behavior. State the distinction.

## Interpretation

- `PLAN`, `ROADMAP`, and requirement text prove intent, not completion.
- `SUMMARY` is implementation testimony; verify important claims against the worktree.
- `VERIFICATION`, UAT, and test output are stronger completion evidence, but only for their covered scope and revision.
- Current code proves what exists, not why it was chosen or whether production accepted it.
- Conversation history is useful for decisions, failures, rejected alternatives, and rationale. It is not authoritative when the project has changed.
- Questions, injected memory/context blocks, agent control instructions, plans without outcomes, and tool intentions without results are not evidence.

## Reconciliation

Label each candidate internally as `verified`, `in-progress`, `planned`, `outdated`, or `conflicted` before deciding whether it belongs in durable memory. Emit durable candidates for verified conclusions and reusable lessons. Emit in-progress state only when it materially helps the next session and make the temporary status explicit. Do not promote planned, outdated, or unresolved conflicting claims as stable facts.

Prefer several independent evidence items. A single source is acceptable only when it is an authoritative current contract or directly verified implementation fact. A single ordinary L1 trace is insufficient for a project-level candidate.
