
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

### 4. (Optional) CLI access

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
