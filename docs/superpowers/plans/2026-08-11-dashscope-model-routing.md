# DashScope Model Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route Memmy Summary and Evolution LLM calls through Alibaba Cloud Model Studio Coding Plan using `qwen3.7-plus`.

**Architecture:** Preserve the existing role-specific OpenAI-compatible client configuration. Change only public environment defaults and the ignored local credentials, then verify each role through the real API and the running Memory service.

**Tech Stack:** Docker Compose, Node.js 22, TypeScript, Vitest, OpenAI Chat Completions-compatible HTTP API

## Global Constraints

- Provider is `openai_compatible` for both roles.
- Endpoint is `https://coding.dashscope.aliyuncs.com/v1` for both roles.
- Model is `qwen3.7-plus` for both roles.
- Summary thinking is disabled, with 768 output tokens and a 60-second timeout.
- Evolution thinking is enabled, with 4096 output tokens and a 180-second timeout.
- The API key exists only in ignored `.env` values and never in tracked files or command output.
- No fallback model or new provider abstraction is introduced.

---

### Task 1: Public And Local Configuration

**Files:**
- Modify: `.env`
- Modify: `.env.example`
- Modify: `compose.yaml`
- Modify: `deploy/memory/docker-compose.yml`

**Interfaces:**
- Consumes: Existing `MEMMY_SUMMARY_*` and `MEMMY_EVOLUTION_*` environment contracts.
- Produces: Role-specific environment values consumed by `loadMemmyConfig` without source changes.

- [ ] **Step 1: Update public defaults**

Set both endpoints to `https://coding.dashscope.aliyuncs.com/v1` and both models to `qwen3.7-plus` in `.env.example`, `compose.yaml`, and `deploy/memory/docker-compose.yml`. Preserve existing token limits, timeouts, and Evolution thinking mode.

- [ ] **Step 2: Update ignored local credentials**

Set the same endpoints/models in `.env`; put the supplied Coding Plan key into both role-specific key variables. Do not print or commit the key.

- [ ] **Step 3: Validate rendered Compose configuration**

Run: `docker compose config --quiet`

Expected: exit code 0 with no schema or interpolation errors.

### Task 2: Real Provider Contract Verification

**Files:**
- No tracked file changes.

**Interfaces:**
- Consumes: Coding Plan endpoint, local bearer key, and `qwen3.7-plus`.
- Produces: Direct evidence that both role-specific request shapes work.

- [ ] **Step 1: Verify model availability**

Call `GET /v1/models` using the local bearer key and assert the response contains `qwen3.7-plus`.

- [ ] **Step 2: Verify Summary request**

Call `/v1/chat/completions` with `enable_thinking: false`, `max_tokens: 768`, and an instruction to return a small JSON object. Parse `choices[0].message.content` as JSON and assert its required fields.

- [ ] **Step 3: Verify Evolution request**

Call `/v1/chat/completions` with `enable_thinking: true`, `max_tokens: 4096`, and a cross-observation induction prompt. Assert non-empty final content and inspect the response shape for compatibility.

### Task 3: Focused Regression And Runtime Verification

**Files:**
- Test: `Memory/tests/model/llm.test.ts`
- Test: `Memory/tests/config.test.ts`

**Interfaces:**
- Consumes: Existing OpenAI-compatible thinking mapping and environment loader.
- Produces: Evidence that configuration and runtime behavior remain valid.

- [ ] **Step 1: Run focused tests**

Run the existing Vitest cases covering Alibaba-compatible `enable_thinking`, JSON behavior, and Summary/Evolution environment loading.

Expected: all selected tests pass.

- [ ] **Step 2: Recreate and health-check Memory**

Run `docker compose up -d --build memory`, wait for the service health check, and require the container to report healthy.

- [ ] **Step 3: Exercise the Memory worker path**

Use the existing authenticated Memory API or smoke script to submit/process a trace that requires Summary, then trigger Evolution processing. Confirm the observable model status/log fields report successful calls for `qwen3.7-plus` without exposing credentials.

- [ ] **Step 4: Commit tracked configuration changes**

Commit only `.env.example`, `compose.yaml`, and `deploy/memory/docker-compose.yml` with message `config: route memory models through dashscope`.
