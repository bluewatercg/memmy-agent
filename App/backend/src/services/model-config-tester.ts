/** Model config tester module. */
import type {
  ModelConfigTestInput,
  ModelConfigTestResult,
  ModelEndpointProtocol,
  ModelProvider
} from "@memmy/local-api-contracts";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Contract for model config tester. */
export interface ModelConfigTester {
  test(input: ResolvedModelConfigTestInput): Promise<ModelConfigTestResult>;
}

type ResolvedModelConfigTestInput = ModelConfigTestInput & { apiKey: string };

export interface CreateHttpModelConfigTesterOptions {
  fetch?: FetchLike;
  now?: () => string;
  timeoutMs?: number;
}

export const DEFAULT_PROBE_TIMEOUT_MS = 60_000;
const SUCCESS_MESSAGE = "连接成功";
const FALLBACK_ERROR_MESSAGE = "API Key 无效或模型列表不可用";
const INVALID_SUCCESS_BODY_MESSAGE = "API 返回格式不符合模型列表接口，请检查 API 地址和协议";
const UNSUPPORTED_MESSAGE = "当前 endpoint 协议不支持模型列表连接测试";
const ANTHROPIC_VERSION = "2023-06-01";

type ListProbe = {
  url: string;
  headers: Record<string, string>;
  isValidBody(body: unknown): boolean;
  listedModels(body: unknown): string[];
};

/** Creates an HTTP tester that only reads model-list endpoints. */
export function createHttpModelConfigTester(options: CreateHttpModelConfigTesterOptions = {}): ModelConfigTester {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const now = options.now ?? (() => new Date().toISOString());
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;

  return {
    async test(input) {
      const probe = listProbe(input);
      if (!probe) return result(false, UNSUPPORTED_MESSAGE, now);
      try {
        const response = await fetchImpl(probe.url, {
          method: "GET",
          headers: probe.headers,
          signal: AbortSignal.timeout(timeoutMs)
        });
        if (!response.ok) {
          const errorMessage = redactSecret(await readErrorMessage(response), input.apiKey);
          return result(
            false,
            response.status === 404
              ? appendBaseUrlGuidance(errorMessage, input.provider)
              : errorMessage,
            now
          );
        }

        const body = await readJsonSafely(response);
        const providerError = extractErrorMessage(body);
        if (providerError) {
          return result(false, redactSecret(providerError, input.apiKey), now);
        }
        if (!probe.isValidBody(body)) {
          return result(false, appendBaseUrlGuidance(INVALID_SUCCESS_BODY_MESSAGE, input.provider), now);
        }

        const modelListed = probe.listedModels(body).some((model) => model === input.modelId);
        return result(true, SUCCESS_MESSAGE, now, modelListed);
      } catch (error) {
        return result(false, redactSecret(normalizeThrownError(error), input.apiKey), now);
      }
    }
  };
}

function listProbe(input: ResolvedModelConfigTestInput): ListProbe | null {
  if (input.protocol === "anthropic-messages") {
    return {
      url: versionedModelsUrl(input.apiBase, "v1"),
      headers: {
        "x-api-key": input.apiKey,
        "anthropic-version": ANTHROPIC_VERSION
      },
      isValidBody: isAnthropicModelsBody,
      listedModels: anthropicModelIds
    };
  }
  if (input.protocol === "gemini-generate-content") {
    return {
      url: versionedModelsUrl(input.apiBase, "v1beta"),
      headers: { "x-goog-api-key": input.apiKey },
      isValidBody: isGoogleModelsBody,
      listedModels: googleModelIds
    };
  }
  if (supportsOpenAiModelList(input.protocol)) {
    return {
      url: resourceUrl(input.apiBase, "models"),
      headers: { Authorization: `Bearer ${input.apiKey}` },
      isValidBody: isOpenAiModelsBody,
      listedModels: openAiModelIds
    };
  }
  return null;
}

function supportsOpenAiModelList(protocol: ModelEndpointProtocol): boolean {
  return protocol === "openai-chat-completions"
    || protocol === "openai-responses"
    || protocol === "openai-embeddings"
    || protocol === "openai-images";
}

function isOpenAiModelsBody(body: unknown): boolean {
  return Array.isArray(record(body).data);
}

function isAnthropicModelsBody(body: unknown): boolean {
  return Array.isArray(record(body).data);
}

function isGoogleModelsBody(body: unknown): boolean {
  return Array.isArray(record(body).models);
}

function openAiModelIds(body: unknown): string[] {
  return records(record(body).data).flatMap((item) => typeof item.id === "string" ? [item.id] : []);
}

function anthropicModelIds(body: unknown): string[] {
  return records(record(body).data).flatMap((item) => typeof item.id === "string" ? [item.id] : []);
}

function googleModelIds(body: unknown): string[] {
  return records(record(body).models).flatMap((item) => {
    if (typeof item.name !== "string") return [];
    return [item.name.replace(/^models\//u, "")];
  });
}

function versionedModelsUrl(apiBase: string, version: "v1" | "v1beta"): string {
  const base = apiBase.replace(/\/+$/u, "");
  return base.endsWith(`/${version}`)
    ? `${base}/models`
    : `${base}/${version}/models`;
}

function resourceUrl(apiBase: string, resource: string): string {
  return `${apiBase.replace(/\/+$/u, "")}/${resource}`;
}

function baseUrlGuidance(provider: ModelProvider): string {
  if (provider === "anthropic") {
    return "Anthropic API 地址通常不包含 /v1，例如 https://api.anthropic.com";
  }
  if (provider === "google") return "";
  return "OpenAI 兼容 API 地址通常以 /v1 结尾，例如 https://api.openai.com/v1";
}

function appendBaseUrlGuidance(message: string, provider: ModelProvider): string {
  const hint = baseUrlGuidance(provider);
  if (!hint) return message;
  return `${message.replace(/[。\.\s]+$/u, "")}。${hint}`;
}

/**
 * Issues a minimal probe request for an Embedding model.
 *
 * @param fetchImpl HTTP client.
 * @param input Model test input.
 * @param timeoutMs Timeout duration.
 * @returns The third-party response.
 */
function runEmbeddingProbe(fetchImpl: FetchLike, input: ResolvedModelConfigTestInput, timeoutMs: number): Promise<Response> {
  if (input.provider === "google") {
    return fetchImpl(endpoint(input.baseUrl, `/v1beta/models/${encodeURIComponent(input.modelId)}:embedContent`), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": input.apiKey
      },
      body: JSON.stringify({
        content: { parts: [{ text: "ping" }] }
      }),
      signal: AbortSignal.timeout(timeoutMs)
    });
  }

  return fetchImpl(endpoint(input.baseUrl, "/embeddings"), {
    method: "POST",
    headers: openAiCompatibleHeaders(input.provider, input.apiKey),
    body: JSON.stringify({
      model: input.modelId,
      input: "ping"
    }),
    signal: AbortSignal.timeout(timeoutMs)
  });
}

/**
 * Issues a minimal OpenAI-compatible chat completion request.
 *
 * Reasoning models (GPT-5 series, o-series) reject max_tokens and require max_completion_tokens,
 * so a rejected max_tokens probe is retried once with the replacement parameter.
 *
 * @param fetchImpl HTTP client.
 * @param input Model test input.
 * @param timeoutMs Timeout duration.
 * @returns The third-party response.
 */
async function runOpenAiCompatibleProbe(fetchImpl: FetchLike, input: ResolvedModelConfigTestInput, timeoutMs: number): Promise<Response> {
  const response = await sendOpenAiCompatibleChatProbe(fetchImpl, input, timeoutMs, "max_tokens");
  if (await isMaxTokensUnsupported(response)) {
    return sendOpenAiCompatibleChatProbe(fetchImpl, input, timeoutMs, "max_completion_tokens");
  }

  return response;
}

/**
 * Sends the chat completion probe with the given output-limit parameter name.
 *
 * @param fetchImpl HTTP client.
 * @param input Model test input.
 * @param timeoutMs Timeout duration.
 * @param tokenLimitParam Output-limit parameter name expected by the target model.
 * @returns The third-party response.
 */
function sendOpenAiCompatibleChatProbe(
  fetchImpl: FetchLike,
  input: ResolvedModelConfigTestInput,
  timeoutMs: number,
  tokenLimitParam: "max_tokens" | "max_completion_tokens"
): Promise<Response> {
  return fetchImpl(chatCompletionsEndpoint(input.baseUrl), {
    method: "POST",
    headers: openAiCompatibleHeaders(input.provider, input.apiKey),
    body: JSON.stringify({
      model: input.modelId,
      messages: [{ role: "user", content: "ping" }],
      stream: false,
      // Reasoning tokens consume the output budget first, so the fallback needs enough budget to emit content.
      [tokenLimitParam]: tokenLimitParam === "max_completion_tokens" ? 128 : input.provider === "baidu" ? 64 : 1
    }),
    signal: AbortSignal.timeout(timeoutMs)
  });
}

/**
 * Checks whether the failure response says the model rejects max_tokens.
 *
 * @param response The third-party HTTP response.
 * @returns True when the retry with max_completion_tokens should run.
 */
async function isMaxTokensUnsupported(response: Response): Promise<boolean> {
  if (response.ok || response.status !== 400) {
    return false;
  }

  const message = extractErrorMessage(await readJsonSafely(response.clone()));
  return typeof message === "string" && message.includes("max_tokens") && /unsupported|not supported/iu.test(message);
}

/**
 * Builds the Chat Completions probe URL.
 *
 * Mirrors the OpenAI SDK's runtime behavior exactly (`baseURL` + `/chat/completions`) so the connection
 * test hits the same URL the agent will use at runtime. The address is used verbatim — no version
 * segment is auto-filled. A base that already ends with /chat/completions is kept as-is for the
 * user who pasted the full endpoint.
 *
 * @param baseUrl The API address entered by the user.
 * @returns The full Chat Completions URL.
 */
function chatCompletionsEndpoint(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/u, "");
  if (base.endsWith("/chat/completions")) {
    return base;
  }
  return `${base}/chat/completions`;
}

/**
 * Builds OpenAI-compatible request headers.
 *
 * @param provider Model provider.
 * @param apiKey Plaintext API Key.
 * @returns The third-party probe request headers.
 */
function openAiCompatibleHeaders(provider: ModelProvider, apiKey: string): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    Authorization: `Bearer ${apiKey}`
  };

  if (provider === "qwen") {
    headers["dashscope-plugin"] = "memmy";
  }

  return headers;
}

/**
 * Joins the baseUrl and the endpoint path verbatim.
 *
 * The address is used as entered — no version segment is deduplicated. A user who adds a redundant
 * /v1 (e.g. an Anthropic base of https://api.anthropic.com/v1) will probe the same URL the runtime
 * would build and get an actionable error, rather than the tester silently repairing it.
 *
 * @param baseUrl The API address entered by the user.
 * @param path The target endpoint path.
 * @returns The full URL.
 */
function endpoint(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/u, "");
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${base}${normalizedPath}`;
}

/**
 * Creates a safe test result.
 *
 * @param ok Whether it succeeded.
 * @param message The display message.
 * @param now Function returning the current time.
 * @returns A test result that does not contain the API Key.
 */
function result(ok: boolean, message: string, now: () => string): ModelConfigTestResult {
function result(
  ok: boolean,
  message: string,
  now: () => string,
  modelListed?: boolean
): ModelConfigTestResult {
  return {
    ok,
    message: message.trim() || FALLBACK_ERROR_MESSAGE,
    checkedAt: now(),
    ...(modelListed === undefined ? {} : { modelListed })
  };
}

async function readErrorMessage(response: Response): Promise<string> {
  const message = extractErrorMessage(await readJsonSafely(response));
  return message ?? `${FALLBACK_ERROR_MESSAGE}（HTTP ${response.status}）`;
}

function normalizeThrownError(error: unknown): string {
  if (!(error instanceof Error)) return FALLBACK_ERROR_MESSAGE;
  if (error.name === "TimeoutError" || /timeout|aborted?/iu.test(error.message)) {
    return "连接超时，请检查 API 地址或网络";
  }
  return error.message || FALLBACK_ERROR_MESSAGE;
}

function extractErrorMessage(body: unknown): string | null {
  const value = record(body);
  if (typeof value.error === "string") return value.error;
  const error = record(value.error);
  if (typeof error.message === "string") return error.message;
  return typeof value.message === "string" ? value.message : null;
}

function redactSecret(message: string, secret: string): string {
  return secret ? message.split(secret).join("[redacted]") : message;
}

async function readJsonSafely(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(record) : [];
}
