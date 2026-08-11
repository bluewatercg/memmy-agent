---
name: memmy-project-summarize
description: Summarize or incrementally update the current project context from workspace-scoped Memmy history, Git, verified tool results, and explicit user memory requests. Use when a user asks to summarize project state, refresh or update project context, remember a durable project fact, extract decisions or lessons, prepare a memory handoff, or consolidate Codex/Pi/GSD work. Do not use for a single-file explanation or a generic repository overview that does not need durable memory candidates.
---

# Memmy Project Summarize

Produce project conclusions for human review. Treat raw L1 records as evidence, not as the product.

## Choose a branch

- Use **Context Update** when the user asks to update/refresh project context, says “remember this” for a project fact, or asks to record the outcome of the current tool/Git work.
- Use **Full Summary** when the user asks for a project summary, handoff, architecture review, or durable lessons across the project.

## Context Update

This branch updates the current workspace without dumping raw transcripts or command logs. Read `references/context-update.md` before writing.

1. Resolve the project root and collect a compact Git snapshot:

   ```bash
   PROJECT_ROOT="$(bash "$HOME/.agents/skills/memmy-project-summarize/scripts/collect-project-context.sh" --root-only "$PWD")"
   bash "$HOME/.agents/skills/memmy-project-summarize/scripts/collect-project-context.sh" "$PROJECT_ROOT"
   ```

2. Extract only the current turn’s useful tool evidence: verified outcomes, changed files, test results, errors and their fixes, and decisions supported by command output. Summarize each item; never store full logs, secrets, tokens, prompts, or injected memory blocks.

3. Separate explicit user memory from inferred evidence. A direct request such as “记住……”, “写入项目上下文……”, or “以后这个项目按……执行” is write authorization for that fact. Tool and Git evidence are writeable only when verified and the user requested a context update; otherwise present them as pending facts.

4. Search the current workspace before writing to detect duplicates and conflicts:

   ```bash
   memmy-memory search "<focused context update query>" --layers L1,L2,L3,Skill --verbose --workspace-path "$PROJECT_ROOT" --source <agent-source>
   ```

5. Write only the minimal normalized facts. Use `L1` for current worktree state, tool/test outcomes, and short-lived status; use `L2` for verified decisions, conventions, and failure lessons; use `L3` only for stable architecture or workspace boundaries. Tag writes with `project-context` plus `explicit-memory`, `git`, `tool-result`, or `verification` as applicable. Preserve source memory IDs when available; cite Git paths and commit IDs in the text, never as memory IDs.

   ```bash
   memmy-memory add "$CONTEXT_FACT" \
     --title "$CONTEXT_TITLE" \
     --layer "$LAYER" \
     --tags project-context,<kind> \
     --workspace-path "$PROJECT_ROOT" \
     --source "$AGENT_SOURCE"
   ```

   Add `--source-memory-ids "$SOURCE_MEMORY_IDS"` only when the fact is supported by existing Memmy records.

6. Re-read every new memory with `memmy-memory get <id> --verbose` and report what was updated, what was skipped as duplicate, and what remains conflicted. The branch is complete only when every approved fact is verified in the same workspace namespace.

Do not promote a changed file, an unverified command intention, or a proposed plan into a durable decision. Do not overwrite a conflicting memory; record the conflict for review.

## Full Summary

1. Resolve the project root from the current directory. Run:

   ```bash
   PROJECT_ROOT="$(bash "$HOME/.agents/skills/memmy-project-summarize/scripts/collect-project-context.sh" --root-only "$PWD")"
   bash "$HOME/.agents/skills/memmy-project-summarize/scripts/collect-project-context.sh" "$PROJECT_ROOT"
   ```

2. Read `references/evidence-policy.md`. Read only the listed high-value files needed to understand current state. Follow references from those files only when they affect a candidate conclusion.

3. Inspect current implementation evidence with `git status`, relevant diffs, targeted source searches, and existing test results. Run new tests only when a candidate depends on an unverified implementation claim and the test is proportionate.

4. Resolve the Memmy namespace from the same root:

   ```bash
   memmy-memory namespace current --workspace-path "$PROJECT_ROOT" --source <agent-source>
   memmy-memory stats --workspace --workspace-path "$PROJECT_ROOT" --source <agent-source>
   ```

   Replace `<agent-source>` with the calling CLI name, such as `codex`, `claude`, or `pi`. If Memmy is unavailable, continue from project files and label history evidence unavailable. Never use `--no-workspace` for this workflow.

5. Retrieve bounded workspace history. Derive focused queries from the project name and current planning artifacts, then search at least these concerns when relevant:

   ```bash
   memmy-memory search "project decisions architecture constraints" --verbose --workspace-path "$PROJECT_ROOT" --source <agent-source>
   memmy-memory search "failures lessons fixes verification" --verbose --workspace-path "$PROJECT_ROOT" --source <agent-source>
   memmy-memory search "current work next steps commands workflow" --verbose --workspace-path "$PROJECT_ROOT" --source <agent-source>
   memmy-memory search "approved project summaries stable rules reusable workflows" --layers L2,L3,Skill --verbose --workspace-path "$PROJECT_ROOT" --source <agent-source>
   ```

   Add narrower searches for important components discovered in planning or Git. Do not read unrelated workspaces or dump the full memory database.

6. Reconcile sources before writing conclusions. Current code and executed verification override stale conversation claims. Planning files express intent unless completion evidence exists. Preserve conflicts as uncertainty instead of selecting the convenient version.

7. Generate 3-8 candidate cards using `references/candidate-cards.md`. Merge evidence that supports the same conclusion. Omit candidates supported only by a question, injected context, a proposed plan, or one low-information L1 record.

8. Present the cards and stop for review. Default actions are `approve`, `edit and approve`, `reject`, and `approve all high-confidence candidates`. The batch action includes only verified, high-confidence, low-risk cards. Leave low-confidence cards pending without requiring immediate review. Do not activate formal L2, L3, or Skill memory before explicit approval.

9. After explicit approval, write only approved cards with `memmy-memory add`, preserving the current workspace and supporting memory IDs:

   ```bash
   memmy-memory add "$APPROVED_CONCLUSION" --title "$CANDIDATE_TITLE" --layer "$APPROVED_LAYER" --tags project-summary,review-approved --source-memory-ids "$SOURCE_MEMORY_IDS" --workspace-path "$PROJECT_ROOT" --source "$AGENT_SOURCE"
   ```

   Re-run `memmy-memory get <new-id> --verbose --workspace-path "$PROJECT_ROOT" --source <agent-source>` to verify each write. Never include repository files as `source-memory-ids`; cite them in the conclusion text or title only.

## Output

Lead with the current project state in one short paragraph, followed by candidate cards. Report unavailable evidence or unresolved conflicts after the cards. Do not make the user review raw episodes unless they expand a card's evidence.

Do not write a project report file unless the user requests one. Do not modify `.planning`, `docs/planning`, source code, Git state, or the Skill itself during a normal summary run.
