
<br>
<div align="center">
  <a href="https://memmy.bot/">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.svg">
      <source media="(prefers-color-scheme: light)" srcset="docs/assets/logo-light.svg">
      <img alt="Memmy Logo" src="docs/assets/logo-light.svg" width="50%">
    </picture>
  </a>
</div>
<br>
<br>

<div align="center">

## Memmy — A Cross-Agent Memory Layer, Self-Hosted

</div>

<div align="center">

**English** • [简体中文](README.zh-CN.md)

</div>

---

This is a fork of [MemTensor/memmy-agent](https://github.com/MemTensor/memmy-agent), reworked for **Docker-first, self-hosted deployment** of the Memory service. The desktop client and upstream cloud service are not used here — the Memory service runs as a standalone container, and agents (Pi, Codex, Claude Code, OMP, FreeBuff) connect to it over a local HTTP API.

## What This Fork Adds

On top of the upstream MemOS-powered memory engine, this fork focuses on multi-agent context sharing and operational governance:

- **Docker-native Memory service** — `compose.yaml` + `Memory/Dockerfile` deploy a hardened container (Node 24 Debian, read-only rootfs, `cap_drop ALL`, named volumes for SQLite and model cache). One `docker compose up -d` and the memory layer is running.
- **OMP & FreeBuff agent sources** — first-class adapters for the Pi-compatible OMP runtime and FreeBuff session history, with `.agents/skills` auto-installation.
- **Authoritative project context** — a governance layer that lets you pin a project-level context pack. All agents working on the same project read the same authoritative baseline instead of drifting apart.
- **Provenance tracking** — every Memory write records source agent, adapter id, request id, workspace path, project id, source memory ids, and Git repository / branch / commit when available.
- **Project-scoped namespace isolation** — different workspaces are separated; agents in the same project share context by design.
- **Memory governance** — Markdown audit export/import, stable supersession relations, provenance and supersession fields in read models.
- **Structured session checkpoints** — resumable handoff state for agent-to-agent task transfer.
- **Context pack history & token usage stats** — visibility into how context evolves and how much budget each synthesis consumes.
- **Project-scoped review synthesis** — distill review discussions into project-level memory.
- **SQLite schema migration** — versioned migrations (currently v5 → v6) with exposed identity for safe upgrades.
- **Standalone Memory console** — the Memory panel expanded into a full management interface with tenant/project-scoped views for panel, retrieval, bundle import/export, worker, and API logs.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                  Your Workstation                    │
│                                                     │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐            │
│  │ Pi/OMP  │  │  Codex  │  │ Claude  │  ...       │
│  │  Agent  │  │  Agent  │  │  Code   │            │
│  └────┬────┘  └────┬────┘  └────┬────┘            │
│       │  skill/hook │  skill     │  skill          │
│       └─────────────┼───────────┘                  │
│                     │ HTTP :18960                   │
│              ┌──────▼──────┐                        │
│              │   Docker    │                        │
│              │   Memory    │                        │
│              │   Service   │                        │
│              │  (MemOS +   │                        │
│              │  SQLite +   │                        │
│              │  ONNX)      │                        │
│              └──────┬──────┘                        │
│                     │                               │
│              ┌──────▼──────┐                        │
│              │  Volumes    │                        │
│              │ memory-data │                        │
│              │ model-cache │                        │
│              └─────────────┘                        │
└─────────────────────────────────────────────────────┘
```

Agents install a lightweight skill (or hook) that forwards memory reads/writes to the Docker service. The service owns all persistence — SQLite for structured memory, Hugging Face ONNX models for local embedding and summarization.

## Quick Start

### 1. Clone and configure

```bash
git clone https://github.com/bluewatercg/memmy-agent.git && cd memmy-agent
cp .env.example .env
```

Edit `.env`:

| Variable | Required | Description |
|---|---|---|
| `MEMMY_MEMORY_TOKEN` | **Yes** | Strong random token (≥32 random bytes). All clients must present this. |
| `MEMMY_MEMORY_HOST_PORT` | No | Host port binding. Default `18960`. |
| `MEMMY_SUMMARY_PROVIDER` | No | Summary model provider. Default `openai_compatible`. |
| `MEMMY_SUMMARY_ENDPOINT` | No | OpenAI-compatible endpoint for summary/evolution models. |
| `MEMMY_SUMMARY_API_KEY` | No | API key for the summary model endpoint. |
| `MEMMY_SUMMARY_MODEL` | No | Model name. Default `auto/best-fast`. |
| `MEMMY_EVOLUTION_*` | No | Same pattern for the evolution/reasoning model. |

### 2. Start the Memory service

```bash
docker compose up -d
```

The container:
- Binds to `127.0.0.1:18960` (localhost only — use a reverse proxy for LAN access)
- Persists SQLite in the `memory-data` volume
- Persists Hugging Face model cache in `memory-model-cache`
- Mounts `~/.pi/agent/sessions`, `~/.codex/sessions`, `~/.claude/transcripts`, `~/.config/manicode` as read-only history sources
- Runs as non-root `node` user with read-only rootfs and all capabilities dropped

Verify:

```bash
curl -H "Authorization: Bearer $MEMMY_MEMORY_TOKEN" http://127.0.0.1:18960/api/v1/health
```

### 3. Install agent skills

```bash
npx memmy-memory init    # Writes config and installs skills for detected agents
```

Or install individually:

```bash
memmy-memory init --agent pi       # Pi/OMP hook
memmy-memory init --agent codex    # Codex skill
memmy-memory init --agent claude   # Claude Code skill
```

Each agent now reads/writes memory through the Docker service.
### 4. (Optional) Project context skill

The `memmy-project-summarize` skill consolidates project context from multiple agents into Memmy memory:

```bash
# Copy skill to your agent's skill directory
cp -r skills/memmy-project-summarize ~/.agents/skills/

# Or for Claude Code
cp -r skills/memmy-project-summarize ~/.claude/skills/
```

Usage:

```bash
# Summarize current project state
memmy-project-summarize

# Update project context with current work
memmy-project-summarize --update
```

This skill extracts decisions, lessons, and verified facts from your workspace and writes them to Memmy memory, making project knowledge available across all agents.

### 5. (Optional) CLI access

```bash
memmy-memory health                         # Service health check
memmy-memory search "project memory policy" # Search across all memory
memmy-memory add "a piece of knowledge"     # Write a new memory
memmy-memory stats --workspace              # Per-workspace statistics
memmy-memory namespace current              # Show active namespace
```

Default connection: `http://127.0.0.1:18960`. Override with `--url`, `--token`, `--config`, `--source`, `--user-id`.

## Supported Agent Sources

| Agent | History Import | Live Skill/Hook | Source ID |
|---|---|---|---|
| Pi / OMP | ✅ `~/.pi/agent/sessions` | ✅ Hook template | `omp` |
| Codex | ✅ `~/.codex/sessions` | ✅ Skill | `codex` |
| Claude Code | ✅ `~/.claude/transcripts` | ✅ Skill | `claude_code` |
| FreeBuff | ✅ Session history | ✅ `.agents/skills` | `freebuff` |
| Cursor | ✅ `.cursor/` project SQLite | — | `cursor` |
| OpenCode | ✅ State SQLite | — | `opencode` |
| OpenClaw | ✅ Conversation + memos SQLite | — | `openclaw` |
| Hermes Agent | ✅ Rollouts + state DB | — | `hermes` |
| WorkBuddy | ✅ Projects JSONL sessions | — | `workbuddy` |

## Core Concepts

- **Memory Service** — the Docker container running the MemOS engine. SQLite-backed structured memory with ONNX embedding, summarization, and evolution models. All agents read and write through its HTTP API (`:18960`).
- **Project Context** — an authoritative context pack pinned per project. Prevents agent drift by giving every agent the same baseline understanding of the project.
- **Namespace** — tenant + project scoping. Different workspaces are isolated; agents in the same project share context.
- **Provenance** — every memory write carries its origin: source agent, adapter, workspace, Git state. You can trace any memory back to where it came from.
- **Supersession** — stable relationships between memory versions. When a memory is updated, the old version is superseded, not deleted — full audit trail.
- **Agent Source** — an adapter that reads historical context from an external agent's session store and optionally installs a live skill for ongoing memory access.
- **Context Pack** — a structured bundle of project-level knowledge that can be exported, imported, and versioned.

## LAN / Remote Access

The default binding is `127.0.0.1:18960`. For LAN or remote access, put a reverse proxy in front:

```
Caddyfile example:

memory.example.com {
    reverse_proxy 127.0.0.1:18960
    tls internal
}
```

Never expose port 18960 directly to the network — the API authenticates via bearer token but has no transport encryption.

## Build from Source

### Requirements

- Node.js `>=22`
- npm
- Docker (for the Memory service container)

### Development

```bash
npm install

# Memory service in dev mode (hot reload)
npm run memory:serve:dev -- \
  --host 127.0.0.1 --port 18960 \
  --db ~/.memmy/memory-service/memory.sqlite \
  --config ~/.memmy/config.yaml

# Full stack (Memory + Agent API + Gateway + frontend)
bash scripts/dev-start.sh

# Tests
npm run test

# Type checking
npm run typecheck
```

### Docker image only

```bash
docker compose build    # Rebuild the Memory image
docker compose up -d    # Restart with new image
```

## Acknowledgements

This fork builds on [MemTensor/memmy-agent](https://github.com/MemTensor/memmy-agent), which in turn stands on the shoulders of:

- **[OpenClaw](https://github.com/openclaw/openclaw)** — open-source personal AI assistant pioneer; its multi-platform messaging exploration inspired Memmy's channel design.
- **[hermes-agent](https://github.com/NousResearch/hermes-agent)** — Nous Research's self-evolving agent; its persistent memory and skill self-learning practice showed what "gets better the more you use it" looks like.
- **[nanobot](https://github.com/HKUDS/nanobot)** — grew from a minimal prototype into a full-featured agent platform; its agent loop and MCP integration engineering informed Memmy's core design.

## Topic Inbox

Topic Inbox aggregates project L1 evidence memories into structured topics and
governed candidates (L2 / L3 / Skill). It runs as an asynchronous worker
pipeline and exposes REST endpoints for review and decision.

### Workflow

```text
L1 memory captured
       │
       ▼
embedding job (embedAfterCapture)
       │
       ▼
topic_ingest job  ◄── dedupeKey prevents duplicate runs
       │
       ▼
ProjectTopicInboxService.ingest(memoryId)
       │
       ├─ matchProjectTopic (cosine similarity)
       │
       ▼
analyzeProjectTopic
       │
       ├─ LLM: topic.inbox.analyze  ──► validateTopicAnalysis
       │                                       │
       │                              (fail)   ▼
       │                       topic.inbox.analyze.repair  (one retry)
       │
       ▼
evaluateTopicAutoApproval (policy: topic-auto-l2-v2)
       │
       ├─ approved  ──► candidate status = "approved", write L2 memory
       └─ rejected  ──► candidate status = "pending", await human review
```

### Trigger Points

`topic_ingest` jobs are enqueued from three places:

1. **Embedding completion** — after a new L1 memory is embedded
   (`embedding-job-processor.ts`).
2. **Quality update** — when `updateMemoryQuality` promotes an L1 memory
   (`memory-service.ts`).
3. **Reward pipeline** — after a reward episode is persisted
   (`reward-pipeline.ts`).

All three use `dedupeKey = "topic_ingest:<memoryId>:<contentHash>"` so the same
memory is not re-analyzed unless its content changes.

### LLM Operations

| Operation | Purpose |
|---|---|
| `topic.inbox.analyze` | Aggregate evidence into topic + candidates |
| `topic.inbox.analyze.repair` | Retry when `analyze` returns invalid JSON (schema mismatch, missing fields, bad enum) |

`repair` is triggered **only** when `validateTopicAnalysis` throws — i.e. the
LLM returned JSON missing `topic`/`candidates`, wrong field types, or invalid
enum values. It runs at most once per analysis; if repair also fails, the error
propagates and the job is retried by the worker.

### Auto-Approval Policy

Policy version: `topic-auto-l2-v2`

A candidate is auto-approved only when **all** conditions hold:

- `proposedLayer` is `"L2"`
- `risk` is `"low"`
- `confidence` is `"high"`
- `verificationStatus` is `"verified"`
- No conflicts or sensitive categories
- At least one cited evidence memory exists
- At least one cited evidence has a successful tool call or structured verification
- No evidence matches the `NEVER_AUTOMATIC` regex (security, credentials,
  destructive operations, migrations, schema changes)
- No evidence shows negated success patterns or failed tool calls
- Candidate title/conclusion do not match `NEVER_AUTOMATIC`

Candidates that fail any condition remain `pending` for human review via the
Topic Inbox UI or API.

### REST API

All routes require `panel-read` or `panel-write` capability and are scoped to
a namespace (`tenantId` + `projectId`).

| Method | Path | Capability | Description |
|---|---|---|---|
| `GET` | `/api/v1/topic-inbox` | `panel-read` | List topics with candidates and evidence counts |
| `POST` | `/api/v1/topic-inbox/refresh` | `panel-write` | Enqueue a full re-analysis of the namespace |
| `POST` | `/api/v1/topic-inbox/candidates/:id/decision` | `panel-write` | Approve, reject, defer, or edit-and-approve a candidate |
| `POST` | `/api/v1/topic-inbox/topics/:id/merge` | `panel-write` | Merge one topic into another |
| `POST` | `/api/v1/topic-inbox/topics/:id/split` | `panel-write` | Split evidence out of a topic into a new topic |
| `GET` | `/api/v1/topic-inbox/topics/:id/evidence` | `panel-read` | List raw evidence memories for a topic |

#### Request Examples

**List topics with pending candidates:**

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:18960/api/v1/topic-inbox?namespace=$(jq -cn '{tenantId:\"default\",projectId:\"my-project\"}')&statuses=pending"
```

**Refresh topic analysis:**

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"namespace":{"tenantId":"default","projectId":"my-project"}}' \
  "http://127.0.0.1:18960/api/v1/topic-inbox/refresh"
```

**Approve a candidate:**

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "namespace": {"tenantId":"default","projectId":"my-project"},
    "decision": {"action":"approve","expectedVersion":1},
    "requestId": "idempotency-key"
  }' \
  "http://127.0.0.1:18960/api/v1/topic-inbox/candidates/cand_abc123/decision"
```

**Edit and approve:**

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "namespace": {"tenantId":"default","projectId":"my-project"},
    "decision": {
      "action": "edit_and_approve",
      "expectedVersion": 1,
      "title": "Corrected title",
      "conclusion": "Refined conclusion",
      "proposedLayer": "L2"
    },
    "requestId": "idempotency-key"
  }' \
  "http://127.0.0.1:18960/api/v1/topic-inbox/candidates/cand_abc123/decision"
```

**Merge topics:**

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "namespace": {"tenantId":"default","projectId":"my-project"},
    "targetTopicId": "topic_def456",
    "expectedVersion": 1,
    "targetExpectedVersion": 2,
    "requestId": "idempotency-key"
  }' \
  "http://127.0.0.1:18960/api/v1/topic-inbox/topics/topic_abc123/merge"
```

**Split topic:**

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "namespace": {"tenantId":"default","projectId":"my-project"},
    "expectedVersion": 1,
    "title": "New split topic",
    "summary": "Evidence extracted from parent topic",
    "evidenceMemoryIds": ["mem_xyz789"],
    "requestId": "idempotency-key"
  }' \
  "http://127.0.0.1:18960/api/v1/topic-inbox/topics/topic_abc123/split"
```

#### Response Shapes

**List (`GET /api/v1/topic-inbox`):**

```json
{
  "projects": [{
    "namespace": {"tenantId":"default","projectId":"my-project"},
    "topics": [{
      "id": "topic_abc123",
      "title": "Topic title",
      "summary": "Topic summary",
      "version": 1,
      "candidates": [{
        "id": "cand_xyz",
        "status": "pending",
        "proposedLayer": "L2",
        "title": "Candidate title",
        "conclusion": "Candidate conclusion",
        "risk": "low",
        "confidence": "high",
        "verificationStatus": "verified"
      }],
      "evidenceCount": 5
    }]
  }],
  "serverTime": "2026-08-12T10:00:00.000Z"
}
```

**Decision (`POST .../decision`):**

```json
{
  "candidate": { "id": "cand_xyz", "status": "approved" },
  "memoryId": "mem_created_l2",
  "auditId": "audit_abc",
  "serverTime": "2026-08-12T10:00:00.000Z"
}
```

### Concurrency and Deduplication

- **`dedupeKey`** on `topic_ingest` jobs: `topic_ingest:<memoryId>:<contentHash>`.
  Same memory with unchanged content is skipped.
- **`claimAnalysisRun`** uses a lease mechanism to prevent concurrent analysis of
  the same topic.
- **`topic_refresh`** uses `namespaceId + evidenceCursor` as dedupe key.
- **Idempotent mutations**: all decision/merge/split routes accept a `requestId`
  and use `service.idempotent()` with `exactReplay: true` to guarantee
  at-most-once semantics.
- **Version conflicts**: mutations require `expectedVersion`; mismatched
  versions return HTTP 409 and the client should re-fetch.

### Configuration

Topic Inbox uses the same LLM client configured in `config.yaml`. No additional
configuration is required beyond enabling the Memory service.

```yaml
memmyMemory:
  version: 1
  activeProfile: byok
  storage:
    runtime: managed
    mode: local
    backend: sqlite
    sqlitePath: ~/.memmy/memory-service/memory.sqlite
  profiles:
    byok:
      embedding:
        provider: local
      # LLM used for topic.inbox.analyze and topic.inbox.analyze.repair
      completion:
        provider: openai
        model: gpt-4o-mini
```

The built-in viewer at `/viewer` includes a Topic Inbox panel for interactive
review, decision, merge, and split operations.
