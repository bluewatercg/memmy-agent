# DashScope Model Routing Design

## Goal

Move Memmy's project-memory LLM calls to Alibaba Cloud Model Studio Coding Plan through its OpenAI-compatible endpoint, prioritizing output quality while keeping secrets local.

## Configuration

Both memory roles use `qwen3.7-plus` at `https://coding.dashscope.aliyuncs.com/v1` with provider `openai_compatible`.

| Role | Model | Thinking | Max output | Timeout | Purpose |
| --- | --- | --- | --- | --- | --- |
| Summary | `qwen3.7-plus` | disabled | 768 tokens | 60 seconds | Frequent structured trace summaries and strict JSON extraction |
| Evolution | `qwen3.7-plus` | enabled | 4096 tokens | 180 seconds | Cross-trace induction, quality decisions, policy and world-model evolution |

Using one flagship model avoids inconsistent interpretation between fast capture and later evolution. Thinking remains disabled for Summary because the implementation omits JSON mode when thinking is enabled on Alibaba-compatible endpoints, and reasoning can consume the small summary output budget. Evolution enables thinking because its work requires multi-sample synthesis and quality judgment.

## Secret Boundary

The Coding Plan API key is stored only in the ignored root `.env`, separately in `MEMMY_SUMMARY_API_KEY` and `MEMMY_EVOLUTION_API_KEY` because the existing service contract exposes role-specific credentials. It is never added to `.env.example`, compose files, source, tests, logs, or the design document.

`.env.example`, root `compose.yaml`, and `deploy/memory/docker-compose.yml` expose only public defaults: provider, endpoint, model, token limits, timeouts, and Evolution thinking mode.

## Runtime Flow

Docker Compose injects the role-specific environment variables into the Memory service. `loadMemmyConfig` builds the Summary and Evolution model configurations. The existing OpenAI-compatible client sends non-streaming requests to `/chat/completions`, uses bearer authentication, and automatically emits DashScope's `enable_thinking` field for this endpoint.

No provider implementation or routing abstraction is added. Existing role separation remains the routing mechanism.

## Errors

Authentication, model availability, malformed JSON, timeout, and truncated-output handling remain owned by the existing HTTP LLM client. The change does not add fallback models: silently changing models would make memory quality and behavior harder to diagnose.

## Verification

1. Query `GET /v1/models` with the local key and confirm `qwen3.7-plus` is available.
2. Send a real Summary-shaped `/chat/completions` request with `enable_thinking: false`, JSON response instructions, and a 768-token limit; require parseable JSON content.
3. Send a real Evolution-shaped request with `enable_thinking: true` and a 4096-token limit; require a non-empty synthesis result.
4. Run the focused Memory model/config tests covering OpenAI-compatible thinking and environment configuration.
5. Recreate the Memory container, wait for its health check, then exercise a real Memory worker path and confirm model success in the observable service status/logs without exposing credentials.
