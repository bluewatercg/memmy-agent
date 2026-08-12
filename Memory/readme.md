# Memory

`Memory` is Memmy's local-first memory service. It stores data in SQLite by
default and exposes memory operations through an HTTP service and the
`memmy-memory` CLI.

## Requirements

- Node.js 20 or later
- npm

## Development

Run the main workflows from the repository root:

```bash
npm run memory:serve:dev
npm run memory:test
npm run memory:lint
npm run memory:build
```

The development server entry point is `Memory/src/server/index.ts`. After a
build, the server entry point is `Memory/dist/src/server/index.js`, and it can be
started with:

```bash
npm run memory:serve
```

The service listens on `http://127.0.0.1:18960` by default. Override its
settings after `--`:

```bash
npm run memory:serve:dev -- \
  --host 127.0.0.1 \
  --port 18960 \
  --db ~/.memmy/memory-service/memory.sqlite \
  --config ~/.memmy/config.yaml
```

The built-in Memory panel is available at `/` and `/viewer`.

## Docker

The repository root includes a dedicated Node 24 Debian image and Compose
configuration. The image intentionally does not use Alpine because Memory has
native SQLite, sqlite-vec, and ONNX dependencies.

Create a strong, unique token in the root `.env` before starting the service:

```bash
docker run --rm node:24-bookworm-slim node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
docker compose up -d --build
docker compose ps
```

Set the generated value as `MEMMY_MEMORY_TOKEN`. Compose refuses to start when
the token is empty. The container listens on `0.0.0.0:18960`, while the default
published host port is restricted to `127.0.0.1:18960`. SQLite data and the
Hugging Face model cache use the `memory-data` and `memory-model-cache` named
volumes.

For Docker Desktop on the same Windows computer, configure the desktop app to
use loopback and mark the service as remotely owned:

```yaml
memmyMemory:
  storage:
    runtime: remote
    endpoint: http://127.0.0.1:18960
    token: <the-same-value-as-MEMMY_MEMORY_TOKEN>
```

`runtime: remote` means the desktop app only connects to and health-checks the
service. It never starts, stops, or restarts the container. Agent processes,
project history scanning, and Skill installation continue to run on the
Windows host.

When another computer needs access, keep port 18960 off the public Internet and
put Caddy or Nginx in front of it with HTTPS. Point desktop clients at the HTTPS
LAN hostname instead of the server IP. The direct `192.168.x.x` address is only
needed when the container actually runs on another host.

For a host-installed Caddy, the minimal reverse proxy is:

```caddyfile
memory.example.lan {
  reverse_proxy 127.0.0.1:18960
}
```

## Configuration

Unless `--config` is provided, the service checks these locations in order:

```text
MEMMY_CONFIG
~/.memmy/config.yaml
```

A minimal local configuration is:

```yaml
memmyMemory:
  version: 1
  activeProfile: byok
  storage:
    runtime: managed
    mode: local
    backend: sqlite
    sqlitePath: ~/.memmy/memory-service/memory.sqlite
    endpoint: http://127.0.0.1:18960
    token: local-token
  profiles:
    byok:
      embedding:
        provider: local
```

The `MEMMY_MEMORY_HOST`, `MEMMY_MEMORY_PORT`, and `MEMMY_MEMORY_DB`
environment variables override the corresponding server settings. The
`MEMORY_SERVICE_*` aliases are also accepted.

When `storage.token`, `MEMMY_MEMORY_TOKEN`, or `MEMORY_SERVICE_TOKEN` is set,
all HTTP routes except `GET /api/v1/health` require that token as a bearer token
or `x-api-key`.

## CLI

Run the CLI directly from source inside the `Memory/` directory:

```bash
npx tsx src/cli/index.ts health --url http://127.0.0.1:18960
```

After building, use the compiled entry point:

```bash
node dist/src/cli/index.js health --url http://127.0.0.1:18960
```

Available commands:

```text
memmy-memory init
memmy-memory install
memmy-memory serve
memmy-memory health
memmy-memory reload-config
memmy-memory session open
memmy-memory session close <sessionId>
memmy-memory turn start
memmy-memory turn complete <turnId>
memmy-memory search <query>
memmy-memory add <content>
memmy-memory get <id>
memmy-memory get <id> --verbose
memmy-memory delete <id>
memmy-memory raw <method> <path>
```

Use `--url`, `--token`, `--user-id`, `--source`, or `--config` to select the
target service and namespace for an individual command.

`memmy-memory get` prints compact, agent-readable content by default. Add
`--verbose` to inspect the complete JSON detail response.

`memmy-memory serve` does not start the local HTTP service. It only reports how
to connect this standalone CLI to an external Memory service.

For npm package installation and agent-skill setup, see
[`src/cli/npm/README.md`](src/cli/npm/README.md). For the integration-test
layout, see [`tests/service/README.md`](tests/service/README.md).

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

#### Authentication

All Topic Inbox routes require a valid token when `storage.token`,
`MEMMY_MEMORY_TOKEN`, or `MEMORY_SERVICE_TOKEN` is configured. Pass the token
in the `Authorization` header as a Bearer token, or in the `x-api-key` header:

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:18960/api/v1/topic-inbox?..."

# Alternative: x-api-key header
curl -H "x-api-key: $TOKEN" \
  "http://127.0.0.1:18960/api/v1/topic-inbox?..."
```

The token's scope must include one of the following capabilities:

| Capability | Allows |
|---|---|
| `panel:read` | `GET` list and evidence routes |
| `panel:write` | All `POST` mutation routes (refresh, decision, merge, split) |
| `memory:read` / `memory:write` | Inherit read/write panel access |
| `admin:read` / `admin:write` | Inherit read/write panel access |

Requests without a valid token receive `401 Unauthorized`. Requests with a
token whose scope does not cover the route receive `403 Forbidden`.

#### Request Examples

**List topics with pending candidates:**

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:18960/api/v1/topic-inbox?namespace=%7B%22tenantId%22%3A%22default%22%2C%22projectId%22%3A%22my-project%22%7D&statuses=pending"
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

**List evidence for a topic:**

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:18960/api/v1/topic-inbox/topics/topic_abc123/evidence?namespace=%7B%22tenantId%22%3A%22default%22%2C%22projectId%22%3A%22my-project%22%7D&limit=20"
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

**Refresh (`POST /api/v1/topic-inbox/refresh`):**

```json
{
  "enqueued": true,
  "unchanged": false,
  "serverTime": "2026-08-12T10:00:00.000Z"
}
```

When `unchanged` is `true`, the evidence cursor has not moved and no
re-analysis was enqueued.

**Merge (`POST .../topics/:id/merge`):**

```json
{
  "topic": {
    "id": "topic_def456",
    "title": "Target topic title",
    "summary": "Merged summary",
    "version": 3,
    "evidenceCount": 8
  },
  "mergedTopicId": "topic_abc123",
  "auditId": "audit_merge_abc",
  "serverTime": "2026-08-12T10:00:00.000Z"
}
```

**Split (`POST .../topics/:id/split`):**

```json
{
  "topic": {
    "id": "topic_new789",
    "title": "New split topic",
    "summary": "Evidence extracted from parent topic",
    "version": 1,
    "evidenceCount": 1
  },
  "sourceTopic": {
    "id": "topic_abc123",
    "title": "Original topic",
    "version": 2,
    "evidenceCount": 4
  },
  "auditId": "audit_split_abc",
  "serverTime": "2026-08-12T10:00:00.000Z"
}
```

**Evidence (`GET .../topics/:id/evidence`):**

```json
{
  "topicId": "topic_abc123",
  "evidence": [{
    "memoryId": "mem_xyz789",
    "content": "Evidence memory content...",
    "quality": 0.85,
    "capturedAt": "2026-08-11T15:30:00.000Z"
  }],
  "serverTime": "2026-08-12T10:00:00.000Z"
}
```

#### Errors

All error responses use a consistent JSON body:

```json
{
  "error": {
    "code": "conflict",
    "message": "topic version conflict",
    "requestId": "req_abc123"
  },
  "details": {
    "topicId": "topic_abc123",
    "currentVersion": 3,
    "currentStatus": "pending"
  }
}
```

| Status | Code | When |
|---|---|---|
| `400` | `invalid_argument` | Missing or malformed field (e.g. `expectedVersion` not a positive integer, `namespace` not valid JSON, unknown `action`) |
| `401` | `unauthorized` | Missing or invalid bearer token / `x-api-key` |
| `403` | `forbidden` | Token scope does not allow the route, or request namespace exceeds token scope |
| `404` | `not_found` | Candidate or topic ID does not exist in the namespace |
| `409` | `conflict` | `expectedVersion` does not match the current version. `details` includes `entityId`, `currentVersion`, and `currentStatus` |
| `429` | `rate_limited` | Rate limit exceeded |
| `500` | *(varies)* | Unexpected internal error |

**409 recovery:** re-fetch the topic inbox (`GET /api/v1/topic-inbox`) to
obtain the current version, then retry the mutation with the updated
`expectedVersion`.


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

## Topic Inbox Usage Guide

This guide helps you understand and use the Topic Inbox feature effectively.

### What is Topic Inbox?

Topic Inbox automatically organizes raw memory traces (L1) into structured knowledge topics and generates candidate memories for higher layers (L2/L3/Skill). It acts as an intelligent curator that:

- **Aggregates** scattered evidence into coherent topics
- **Analyzes** patterns using LLM to identify reusable knowledge
- **Proposes** candidates for promotion to structured memory layers
- **Auto-approves** low-risk, high-confidence candidates based on policy
- **Queues** uncertain candidates for human review

### How It Works

```
You capture memories (L1)
        ↓
System automatically analyzes them
        ↓
Topic Inbox groups related memories into topics
        ↓
LLM identifies patterns and proposes candidates
        ↓
Auto-approval policy evaluates each candidate
        ↓
Approved candidates become L2/L3 memories
Pending candidates wait for your review
```

### Configuration

Topic Inbox uses the same LLM configuration as the rest of Memory service. Minimal setup:

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
      # LLM used for topic analysis
      completion:
        provider: openai
        model: gpt-4o-mini
        # apiKey: ${OPENAI_API_KEY}  # or set environment variable
```

**Provider options:**

- `openai` — OpenAI API (GPT-4o, GPT-4o-mini, etc.)
- `anthropic` — Anthropic Claude
- `gemini` — Google Gemini
- `openai_compatible` — Any OpenAI-compatible API (local LLM, Azure, etc.)

**Example with local LLM:**

```yaml
profiles:
  byok:
    embedding:
      provider: local
    completion:
      provider: openai_compatible
      baseUrl: http://localhost:11434/v1
      model: llama3.1
      apiKey: ollama  # required but not validated
```

### Viewing Topic Candidates

**Method 1: Web UI (Recommended)**

Open the built-in viewer at `http://127.0.0.1:18960/viewer` and navigate to the **Topic Inbox** panel. You'll see:

- Topics grouped by project
- Pending candidates highlighted for review
- Evidence count per topic
- Quick actions: approve, reject, edit, merge, split

**Method 2: REST API**

List all topics with pending candidates:

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:18960/api/v1/topic-inbox?namespace=%7B%22tenantId%22%3A%22default%22%2C%22projectId%22%3A%22my-project%22%7D&statuses=pending"
```

**Method 3: CLI (raw API)**

```bash
memmy-memory raw GET "/api/v1/topic-inbox?namespace=%7B%22tenantId%22%3A%22default%22%2C%22projectId%22%3A%22my-project%22%7D"
```

### Managing Candidates

**Approve a candidate:**

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "namespace": {"tenantId":"default","projectId":"my-project"},
    "decision": {"action":"approve","expectedVersion":1},
    "requestId": "unique-id-123"
  }' \
  "http://127.0.0.1:18960/api/v1/topic-inbox/candidates/cand_abc123/decision"
```

**Edit before approving:**

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "namespace": {"tenantId":"default","projectId":"my-project"},
    "decision": {
      "action": "edit_and_approve",
      "expectedVersion": 1,
      "title": "Improved title",
      "conclusion": "Refined conclusion based on evidence",
      "proposedLayer": "L2"
    },
    "requestId": "unique-id-456"
  }' \
  "http://127.0.0.1:18960/api/v1/topic-inbox/candidates/cand_abc123/decision"
```

**Reject a candidate:**

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "namespace": {"tenantId":"default","projectId":"my-project"},
    "decision": {"action":"reject","expectedVersion":1},
    "requestId": "unique-id-789"
  }' \
  "http://127.0.0.1:18960/api/v1/topic-inbox/candidates/cand_abc123/decision"
```

**Merge duplicate topics:**

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "namespace": {"tenantId":"default","projectId":"my-project"},
    "targetTopicId": "topic_def456",
    "expectedVersion": 1,
    "targetExpectedVersion": 2,
    "requestId": "merge-id-001"
  }' \
  "http://127.0.0.1:18960/api/v1/topic-inbox/topics/topic_abc123/merge"
```

**Split a topic:**

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "namespace": {"tenantId":"default","projectId":"my-project"},
    "expectedVersion": 1,
    "title": "New focused topic",
    "summary": "Extracted evidence about specific subtopic",
    "evidenceMemoryIds": ["mem_xyz789", "mem_xyz790"],
    "requestId": "split-id-002"
  }' \
  "http://127.0.0.1:18960/api/v1/topic-inbox/topics/topic_abc123/split"
```

### Best Practices

**1. Review candidates regularly**

Set a weekly reminder to review pending candidates. Accumulated pending items reduce the value of structured memory. Aim to process candidates within 1-2 weeks of creation.

**2. Edit before approving when needed**

Don't just approve or reject. If a candidate is close but needs refinement, use `edit_and_approve` to improve the title, conclusion, or layer assignment before promoting it.

**3. Merge related topics**

When you notice multiple topics covering similar ground, merge them to keep the knowledge base clean. A single well-organized topic is better than five overlapping ones.

**4. Split overly broad topics**

If a topic accumulates diverse evidence that doesn't fit a single narrative, split it into focused subtopics. This improves retrieval accuracy.

**5. Trust auto-approval for low-risk items**

The auto-approval policy is conservative by design. If a candidate meets all criteria (L2, low risk, high confidence, verified), it's safe to let it through without manual review.

**6. Provide quality evidence**

Topic Inbox works best when L1 memories are clear and well-structured. Use descriptive content when capturing memories, and include context about why the information matters.

**7. Use namespaces to organize**

Separate different projects or domains using `tenantId` and `projectId`. This prevents cross-contamination and makes review easier.

**8. Refresh analysis when needed**

If you've added significant new evidence and want to re-analyze existing topics:

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"namespace":{"tenantId":"default","projectId":"my-project"}}' \
  "http://127.0.0.1:18960/api/v1/topic-inbox/refresh"
```

Use this sparingly — automatic ingestion already processes new memories as they arrive.

**9. Monitor evidence quality**

Check the evidence memories linked to topics. If you see low-quality or irrelevant evidence, consider deleting those L1 memories to improve future analysis.

**10. Leverage the web UI for exploration**

The web viewer provides visual context that raw API responses don't. Use it to understand topic relationships, see evidence distributions, and make informed decisions.

### Troubleshooting

**No candidates appearing?**

- Verify LLM configuration is correct and API key is set
- Check that embedding provider is working (memories need vectors)
- Ensure memories have been captured and embedded (check `memmy-memory search`)

**Candidates look wrong?**

- Review the evidence memories — garbage in, garbage out
- Try a different LLM model for better analysis quality
- Use the refresh endpoint to re-analyze with updated evidence

**Auto-approval too aggressive or conservative?**

- The policy is hardcoded for safety. If you need different thresholds, consider the manual review workflow
- Focus on editing candidates rather than changing the policy

**Duplicate topics?**

- Use the merge operation to consolidate
- Future ingestions use cosine similarity to match existing topics, but imperfect matches happen

### Understanding Auto-Approval

A candidate is auto-approved only when ALL conditions hold:

- Proposed layer is L2 (not L3 or Skill)
- Risk is low
- Confidence is high
- Verification status is verified
- No conflicts with existing memories
- No sensitive categories (security, credentials, destructive ops)
- At least one evidence memory with successful tool call or verification
- No evidence matches safety blocklist patterns

If any condition fails, the candidate remains pending for your review. This conservative approach prevents automatic promotion of uncertain or risky knowledge.
