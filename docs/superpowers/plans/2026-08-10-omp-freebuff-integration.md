# OMP and FreeBuff Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add first-class OMP and FreeBuff memory-source support to the fork, covering discovery, history ingestion, skill/plugin distribution, provenance, UI source display, Docker access, and end-to-end acceptance.

**Architecture:** OMP cleanly replaces the product-facing Pi source identity while retaining compatibility with the installed `pi` runtime, `~/.pi/agent` paths, and Pi JSONL format. The default registries expose only `omp`, so the same sessions and extension file cannot be scanned or written twice; existing stored `pi` provenance remains immutable historical data. FreeBuff receives an independent `freebuff` source adapter that reads its native project chat files and a skill target that installs the shared Memmy skill into FreeBuff's supported `.agents/skills` location. FreeBuff realtime lifecycle hooks are out of scope because the upstream CLI exposes no verified plugin/hook contract; its supported path is skill-based runtime access plus completed-history scanning.

**Tech Stack:** TypeScript, Node.js `node:fs`, Vitest, Fastify local API, existing `SourceAdapter`/`SkillTarget` registries, Docker Compose.

## Global Constraints

- Preserve all existing uncommitted user changes, including the current `app-state-store/tests/index.test.ts` reduction.
- Do not merge all upstream v1.0.5 changes in this phase; phase two is a separate selective upstream-core migration after this phase passes acceptance.
- Use `omp` as the clean-cutover identity for the installed Pi-compatible runtime; do not register `pi` and `omp` simultaneously.
- Use `freebuff` as the stable FreeBuff source ID and `FreeBuff` as its display name.
- Reuse existing source scanning, ingestion, redaction, checkpoint, namespace, and provenance contracts.
- Every production behavior change starts with a failing focused test and is followed by a fresh passing test run.
- Do not add an unverified FreeBuff hook or plugin protocol.
- Do not expose or persist raw credentials from scanned histories.
- Do not add generated files, mocks, or placeholder implementations.

## File Map

### OMP

- Modify `App/backend/src/adapters/outbound/agent-paths.ts`: retain Pi-compatible `~/.pi/agent` home/session resolution under OMP-named exports.
- Rename or parameterize `App/backend/src/adapters/outbound/agent-source/pi/` into the OMP implementation: emit `omp`, retain Pi JSONL compatibility, and remove the built-in `pi` registry entry.
- Rename or parameterize `App/backend/src/adapters/outbound/skill-writer/pi/` into the OMP target: keep the runtime's actual `AGENTS.md`, `extensions`, and config paths while exposing only OMP identity.
- Modify `App/backend/src/services/builtin-agent-source-registry.ts` and `App/backend/src/services/index.ts`: replace Pi registration with OMP registration.
- Modify `App/backend/src/services/agent-source-auto-inject-service.ts`: replace `pi` with `omp` in plugin auto-injection.
- Modify `App/backend/src/adapters/outbound/agent-adapter/types/domain.ts` and `manifest.ts`: add `omp`; do not add `pi` as a new built-in kind.
- Modify frontend source lists to remove the selectable Pi identity and add OMP; keep display compatibility for historical records whose stored source remains `pi`.

### FreeBuff

- Modify `App/backend/src/adapters/outbound/agent-paths.ts`: resolve FreeBuff config/data root with an environment override and default `~/.config/manicode`.
- Create `App/backend/src/adapters/outbound/agent-source/freebuff/session-discovery.ts`: discover `projects/*/chats/*/chat-messages.json`, order by mtime, enforce scan limits, and derive project/workspace paths.
- Create `App/backend/src/adapters/outbound/agent-source/freebuff/history-reader.ts`: parse native `ChatMessage` JSON, normalize user/assistant turns, render relevant text/tool content, skip UI-only blocks, and reject malformed records per-session without aborting all scanning.
- Create `App/backend/src/adapters/outbound/agent-source/freebuff/adapter.ts` and `index.ts`: implement `SourceAdapter`, redaction, cancellation, progress, and stable message IDs.
- Create `App/backend/src/adapters/outbound/skill-writer/freebuff/target.ts` and `index.ts`: install/remove the shared Memmy skill under `~/.agents/skills/memmy-memory` or a test-injected equivalent.
- Modify `App/backend/src/services/builtin-agent-source-registry.ts`, `App/backend/src/services/index.ts`, and `agent-source-auto-inject-service.ts`: register FreeBuff and skill-only auto injection.

### Contracts, UI, Docker, and tests

- Modify `App/frontend/desktop/src/pages/agent-source-logos.ts`, memory display helpers, source distribution UI, and their tests for `omp` and `freebuff`.
- Modify `compose.yaml`: mount `${HOME}/.config/manicode` read-only for FreeBuff history, retaining existing Pi/Codex/Claude mounts.
- Modify source/adapter/path/registry tests under `App/backend/src/**/tests/`.
- Add FreeBuff fixtures under the nearest existing test fixture convention, with malformed, incomplete, tool, secret, and multi-project cases.
- Add or update smoke coverage under `tests/smoke/` for source registration and runtime memory integration.
- Update `README.md`, `README.zh-CN.md`, and source support docs only after implementation behavior is verified.

---

### Task 1: Lock source IDs, paths, and registry contracts

**Files:**
- Modify: `App/backend/src/adapters/outbound/agent-paths.ts`
- Modify: `App/backend/src/adapters/outbound/agent-adapter/types/domain.ts`
- Modify: `App/backend/src/adapters/outbound/agent-adapter/manifest.ts`
- Modify: `App/backend/src/services/builtin-agent-source-registry.ts`
- Modify: `App/backend/src/services/index.ts`
- Modify: `App/backend/src/services/agent-source-auto-inject-service.ts`
- Test: existing path, manifest, registry, and auto-inject tests

**Interfaces:**
- `resolveOmpHomeDirectory(options?: ResolveAgentPathOptions): string` and `resolveOmpSessionsDirectory(options?: ResolveAgentPathOptions): string` retain the installed runtime's `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`, and `~/.pi/agent` compatibility.
- `resolveFreebuffHomeDirectory(options?: ResolveAgentPathOptions): string` returns the FreeBuff data root, defaulting to `~/.config/manicode` and honoring `FREEBUFF_CONFIG_DIR`.
- Built-in kinds include `omp` and `freebuff`; the default runtime registries no longer expose `pi`.

- [ ] **Step 1: Add failing path and built-in-kind tests**

Assert exact POSIX and Windows path resolution with injected home/environment values, assert `isBuiltinAgentKind("omp")` and `isBuiltinAgentKind("freebuff")` are true, and assert the default registries contain `omp` but not `pi`.

- [ ] **Step 2: Run focused tests and confirm the expected failures**

Run:

```bash
npx vitest run src/adapters/outbound/agent-source/tests/agent-paths.test.ts src/adapters/outbound/agent-adapter/tests/manifest.test.ts
```

Expected: failures only for the new OMP/FreeBuff expectations.

- [ ] **Step 3: Implement the minimal path and type changes**

Add the two resolvers, extend `BuiltinAgentKind`, and extend the manifest built-in list. Preserve all existing environment precedence and platform path behavior.

- [ ] **Step 4: Add registry/auto-inject contract tests**

Assert that the default source/target registries expose `omp` and `freebuff`, do not expose `pi`, that OMP selects plugin installation, and that FreeBuff selects skill installation.

- [ ] **Step 5: Run the focused contract tests**

Run the same Vitest command plus the registry and auto-inject test files. Expected: all pass.

- [ ] **Step 6: Commit the contract slice**

```bash
git add App/backend/src/adapters/outbound/agent-paths.ts App/backend/src/adapters/outbound/agent-adapter/types/domain.ts App/backend/src/adapters/outbound/agent-adapter/manifest.ts App/backend/src/services
 git commit -m "feat(backend): register omp and freebuff source identities"
```

Do not commit unrelated worktree changes.

### Task 2: Convert the Pi-compatible source to OMP identity

**Files:**
- Move or modify: `App/backend/src/adapters/outbound/agent-source/pi/*` to `App/backend/src/adapters/outbound/agent-source/omp/*`
- Modify: `App/backend/src/services/builtin-agent-source-registry.ts`
- Test: moved OMP source tests plus registry regression tests

**Interfaces:**
- The parser continues to consume the installed runtime's Pi JSONL record format and active-branch markers.
- `createOmpSourceAdapter(deps?: { sessionsRoot?: string; descriptor?: SourceDescriptor }): SourceAdapter` emits `sourceId: "omp"` and `displayName: "OMP"`.
- The default registry has no `pi` adapter, preventing duplicate scanning of `~/.pi/agent/sessions`.

- [ ] **Step 1: Add failing OMP adapter tests**

Use a temporary Pi-compatible session root containing a valid active-branch JSONL session and a handled-entry marker. Assert detection, `omp` source ID, active-branch filtering, handled-entry exclusion, workspace path, git root, stable message IDs, recent ordering, `since`, max limits, abort behavior, and absence of `pi` in the default registry.

- [ ] **Step 2: Run the OMP test and verify it fails for missing adapter/export**

```bash
npx vitest run src/adapters/outbound/agent-source/omp/tests/adapter.test.ts
```

- [ ] **Step 3: Move and rename the Pi-compatible source implementation**

Retain the JSONL parser behavior and installed paths, rename public symbols and source-specific error text to OMP, and remove the old Pi export and default registry entry.

- [ ] **Step 4: Complete `createOmpSourceAdapter()`**

Call existing conversation-window and redaction utilities, emit OMP-specific progress, and never emit new records with `sourceId: "pi"`.

- [ ] **Step 5: Run OMP and registry tests**

```bash
npx vitest run src/adapters/outbound/agent-source/omp src/services/tests/builtin-agent-source-registry.test.ts
```

Expected: OMP parsing tests pass and the default registry contains no Pi source.

- [ ] **Step 6: Commit the OMP source slice**

```bash
git add App/backend/src/adapters/outbound/agent-source/omp App/backend/src/adapters/outbound/agent-source/pi App/backend/src/services/builtin-agent-source-registry.ts
git commit -m "feat(backend): cut over pi memory source to omp"
```

### Task 3: Cut over the Pi-compatible skill target to OMP

**Files:**
- Move or modify: `App/backend/src/adapters/outbound/skill-writer/pi/*` to `App/backend/src/adapters/outbound/skill-writer/omp/*`
- Modify: shared lifecycle template module(s)
- Modify: `App/backend/src/services/index.ts`
- Modify: `App/backend/src/services/agent-source-auto-inject-service.ts`
- Test: moved OMP target tests, shared template tests, registry and auto-inject regressions

**Interfaces:**
- `createOmpSkillTarget(deps?: CreateOmpSkillTargetDeps): SkillTarget` exposes `targetId: "omp"`, `displayName: "OMP"`, `install`, `uninstall`, `isInstalled`, `installPlugin`, and `uninstallPlugin`.
- The generated plugin contains `SOURCE = "omp"` and `ADAPTER_ID = "memmy-omp-extension"` while remaining compatible with the installed `pi` extension API and filesystem layout.
- The default target registry has no `pi` target, preventing two identities from writing the same `extensions/memmy-memory.ts`.

- [ ] **Step 1: Add failing target tests**

Assert OMP installs into an injected Pi-compatible runtime root, writes the config and extension, is idempotent, preserves unrelated files, removes only Memmy-owned files, emits OMP identity, and leaves no Pi target in the default registry.

- [ ] **Step 2: Run the focused tests and confirm failure**

```bash
npx vitest run src/adapters/outbound/skill-writer/omp/tests/target.test.ts src/adapters/outbound/skill-writer/templates/memmy-agent-protocol.test.ts
```

- [ ] **Step 3: Move and parameterize the lifecycle renderer**

Keep the runtime extension API and paths compatible, set OMP identity explicitly, retain the 25-second timeout, and remove the old Pi public target/export.

- [ ] **Step 4: Register only the OMP target**

Use the installed runtime's actual root and existing atomic file-writing/skill-directory helpers. The default registry must not expose both identities.

- [ ] **Step 5: Run target, template, and auto-inject tests**

Expected: OMP installation and lifecycle behavior is green, with no registered Pi target.

- [ ] **Step 6: Commit the OMP distribution slice**

```bash
git add App/backend/src/adapters/outbound/skill-writer App/backend/src/services/index.ts App/backend/src/services/agent-source-auto-inject-service.ts
git commit -m "feat(backend): cut over pi plugin integration to omp"
```

### Task 4: Implement FreeBuff history discovery and normalization

**Files:**
- Create: `App/backend/src/adapters/outbound/agent-source/freebuff/session-discovery.ts`
- Create: `App/backend/src/adapters/outbound/agent-source/freebuff/history-reader.ts`
- Create: `App/backend/src/adapters/outbound/agent-source/freebuff/adapter.ts`
- Create: `App/backend/src/adapters/outbound/agent-source/freebuff/index.ts`
- Modify: `App/backend/src/services/builtin-agent-source-registry.ts`
- Test: `App/backend/src/adapters/outbound/agent-source/freebuff/tests/adapter.test.ts`

**Interfaces:**
- `createFreebuffSourceAdapter(deps?: { rootDirectory?: string; descriptor?: SourceDescriptor }): SourceAdapter`.
- Discovery reads `<root>/projects/<project>/chats/<chat>/chat-messages.json`.
- Reader returns normalized `ConversationMessage` candidates with stable IDs based on project, chat, and message ID.

- [ ] **Step 1: Create deterministic FreeBuff fixtures**

Include two projects, one valid conversation, one malformed JSON file, incomplete user-only conversation, tool blocks, image/html blocks, secret-like text, timestamps, and metadata.

- [ ] **Step 2: Add failing reader tests**

Assert user and assistant normalization, tool rendering, UI-only block omission, stable IDs, timestamp preservation, incomplete-turn filtering, malformed-file isolation, and secret redaction.

- [ ] **Step 3: Run the reader tests and verify the expected failures**

```bash
npx vitest run src/adapters/outbound/agent-source/freebuff/tests/adapter.test.ts
```

- [ ] **Step 4: Implement discovery and reader**

Parse only documented serializable `ChatMessage` fields. Preserve textual content and compact tool context; skip React/UI-only blocks and error-only messages. Report malformed chat files as per-source scan errors through the existing scan pipeline instead of terminating the entire scan.

- [ ] **Step 5: Implement the FreeBuff adapter**

Add detection, recent ordering, scan limits, `since`, cancellation, progress, redaction, workspace/project provenance, and complete-turn compatibility with existing ingestion.

- [ ] **Step 6: Register FreeBuff and run source tests**

```bash
npx vitest run src/adapters/outbound/agent-source/freebuff src/adapters/outbound/agent-source/tests src/services/tests/agent-source-service.test.ts
```

- [ ] **Step 7: Commit the FreeBuff source slice**

```bash
git add App/backend/src/adapters/outbound/agent-source/freebuff App/backend/src/services/builtin-agent-source-registry.ts
 git commit -m "feat(backend): import freebuff chat history"
```

### Task 5: Add FreeBuff skill installation and source auto-injection

**Files:**
- Create: `App/backend/src/adapters/outbound/skill-writer/freebuff/target.ts`
- Create: `App/backend/src/adapters/outbound/skill-writer/freebuff/index.ts`
- Modify: `App/backend/src/services/index.ts`
- Modify: `App/backend/src/services/agent-source-auto-inject-service.ts`
- Test: `App/backend/src/adapters/outbound/skill-writer/freebuff/tests/target.test.ts` and auto-inject tests

**Interfaces:**
- `createFreebuffSkillTarget(deps?: { rootDirectory?: string }): SkillTarget`.
- The default root is the user's `.agents` directory; the installed skill is `skills/memmy-memory`.
- FreeBuff is skill-only: no `installPlugin` call and no fabricated lifecycle hook.

- [ ] **Step 1: Add failing installation tests**

Assert installation into a temporary `.agents` root, valid Skill frontmatter/content, idempotency, preservation of unrelated skills, clean uninstall, and missing-root behavior.

- [ ] **Step 2: Run tests and verify failure**

```bash
npx vitest run src/adapters/outbound/skill-writer/freebuff/tests/target.test.ts src/services/tests/agent-source-auto-inject-service.test.ts
```

- [ ] **Step 3: Implement the target using existing skill-directory helpers**

Do not duplicate skill rendering, marker, or atomic replacement logic already used by other targets.

- [ ] **Step 4: Add FreeBuff to the default target registry and skill-only auto-injection**

Ensure an available, disconnected FreeBuff source installs the skill, while OMP installs its plugin.

- [ ] **Step 5: Run focused tests and commit**

```bash
git add App/backend/src/adapters/outbound/skill-writer/freebuff App/backend/src/services/index.ts App/backend/src/services/agent-source-auto-inject-service.ts
git commit -m "feat(backend): install memmy skill for freebuff"
```

### Task 6: Update frontend source display and Docker access

**Files:**
- Modify: `App/frontend/desktop/src/pages/agent-source-logos.ts`
- Modify: `App/frontend/desktop/src/pages/memory/memory-display.ts`
- Modify: `App/frontend/desktop/src/pages/memory/overview-sub-page.tsx`
- Modify: corresponding frontend tests
- Modify: `compose.yaml`

**Interfaces:**
- `agentSourceDisplayName("omp") === "OMP"`.
- `agentSourceDisplayName("freebuff") === "FreeBuff"`.
- Memory source normalization recognizes both IDs.
- Docker mounts `${HOME}/.config/manicode:/home/node/.config/manicode:ro` and keeps existing session mounts.

- [ ] **Step 1: Add failing frontend and Compose assertions**

Test source filters, detail labels, overview grouping, and exact Compose mount configuration.
- `agentSourceDisplayName("omp") === "OMP"`; `omp` is selectable while historical `pi` records still render as `Pi` but are not a selectable live source.
- `agentSourceDisplayName("freebuff") === "FreeBuff"`.

```bash
npx vitest run src/pages/memory/tests/memories-sub-page.test.tsx src/pages/memory/tests/overview-sub-page.test.tsx
```

- [ ] **Step 3: Implement display and Compose changes**

Use existing icon conventions; do not add a second source-label map.

- [ ] **Step 4: Run frontend tests and Compose config validation**

```bash
npx vitest run src/pages/memory/tests/memories-sub-page.test.tsx src/pages/memory/tests/overview-sub-page.test.tsx
docker compose config
```

- [ ] **Step 5: Commit**

```bash
git add App/frontend/desktop/src/pages/agent-source-logos.ts App/frontend/desktop/src/pages/memory compose.yaml
git commit -m "feat: expose omp and freebuff memory sources"
```

### Task 7: End-to-end acceptance and documentation

**Files:**
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `docs/en/memory/sources.mdx`
- Modify: `docs/cn/memory/sources.mdx`
- Add or modify: `tests/smoke/*` only where an existing smoke contract can cover the new sources

**Interfaces:**
- Documentation lists OMP and FreeBuff with exact supported behavior: OMP lifecycle plugin plus history scan; FreeBuff skill plus completed-history scan.
- Smoke tests use the existing Memory API contract and namespace/provenance fields.

- [ ] **Step 1: Add source registration and ingestion smoke assertions**

Assert both source IDs are present, an OMP fixture reaches Memory with `sourceAgent: "omp"`, and a FreeBuff fixture reaches Memory with `sourceAgent: "freebuff"` without duplicate writes on repeat scan.

- [ ] **Step 2: Run the smoke test before documentation changes**

```bash
npm run smoke:memory-layer:test
npm run smoke:local-agent-memory:test
```

- [ ] **Step 3: Update English and Chinese support documentation**

State the exact paths, activation mechanism, privacy behavior, and that FreeBuff has no automatic lifecycle hook in this phase.

- [ ] **Step 4: Run the complete relevant verification set**

```bash
npm run typecheck -w @memmy/backend
npm run typecheck -w @memmy/frontend-desktop
npm run test -w @memmy/backend
npm run test -w @memmy/frontend-desktop
npm run smoke:memory-layer
docker compose build memory
docker compose up -d memory
curl --fail http://127.0.0.1:18960/api/v1/health
```

Use the configured runtime token for authenticated smoke calls; do not print it.

- [ ] **Step 5: Inspect running Docker image and stop only if explicitly requested**

Confirm `docker compose ps`, image creation time, health status, and the source mount. Do not report Docker deployment as current until these commands return evidence.

- [ ] **Step 6: Commit documentation and acceptance changes**

```bash
git add README.md README.zh-CN.md docs/en/memory/sources.mdx docs/cn/memory/sources.mdx tests/smoke
git commit -m "docs: document omp and freebuff memory integration"
```

| OMP lifecycle identity | OMP target/template tests plus local API request assertions |
| Pi cutover safety | Registry tests prove no live Pi source/target; display tests preserve historical Pi labels |
After Task 7 passes, review `origin/main` v1.0.5 against this fork using separate standards/spec review. Candidate core changes are Memory retrieval/session correctness, source scan reliability, provider error handling, and runtime lifecycle fixes. Exclude unrelated UI/channel/packaging rewrites unless a concrete regression or requirement requires them. Each selected upstream change gets its own failing regression test, selective patch, and verification before migration.

## Verification Matrix

| Contract | Direct evidence |
|---|---|
| OMP source detection and scan | OMP adapter tests with real JSONL fixtures |
| OMP lifecycle identity | OMP target/template tests plus local API request assertions |
| Historical Pi compatibility | Existing Pi-format fixture parsing remains valid while default source/target registries expose no live Pi identity |
| FreeBuff history import | FreeBuff reader/adapter tests with native JSON fixtures |
| FreeBuff skill loading | Target test asserting `.agents/skills/memmy-memory/SKILL.md` |
| Secret handling | Reader/adapter tests asserting redacted content |
| Incomplete/malformed history | Reader tests and scan result assertions |
| Registry/auto-injection | Registry and auto-inject tests |
| UI source visibility | Desktop source/filter/overview tests |
| Docker accessibility | `docker compose config`, running health endpoint, mounted path inspection |
| End-to-end Memory write | Existing smoke command with source-specific provenance |
