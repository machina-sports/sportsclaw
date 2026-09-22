/**
 * sportsclaw — OpenAI-compatible provider settings
 *
 * The `openai-compatible` provider talks to any server that implements the
 * OpenAI Chat Completions API: NVIDIA NIM, vLLM, SGLang, Ollama, LM Studio,
 * Groq, Cerebras, Together, Fireworks, OpenRouter, and so on. It has its own
 * env vars, so it never collides with a real OpenAI key or `OPENAI_BASE_URL`.
 *
 *   OPENAI_COMPATIBLE_BASE_URL  required, e.g. http://localhost:8000/v1
 *   OPENAI_COMPATIBLE_API_KEY   optional; local servers often need none
 *
 * It always uses POST {base}/chat/completions: most compatible servers do not
 * implement the Responses API. There is no default model; the id is whatever
 * the server calls it (e.g. `meta/llama-3.3-70b-instruct`), so it must be set
 * explicitly with SPORTSCLAW_MODEL or the config file.
 */

export const OPENAI_COMPATIBLE_BASE_URL_ENV = "OPENAI_COMPATIBLE_BASE_URL";
export const OPENAI_COMPATIBLE_API_KEY_ENV = "OPENAI_COMPATIBLE_API_KEY";

export interface OpenAICompatibleSettings {
  baseURL: string;
  /** Sent as the bearer token. A placeholder when unset, since the SDK needs a value. */
  apiKey: string;
  apiKeyProvided: boolean;
  modelId: string;
}

const PLACEHOLDER_KEY = "not-needed";

/** Validate and normalize a base URL. Throws with a user-facing message. */
export function normalizeCompatibleBaseUrl(raw: string | undefined): string {
  const value = (raw ?? "").trim();
  if (!value) {
    throw new Error(
      `provider "openai-compatible" requires ${OPENAI_COMPATIBLE_BASE_URL_ENV} (e.g. http://localhost:8000/v1)`,
    );
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${OPENAI_COMPATIBLE_BASE_URL_ENV} is not a valid URL: ${JSON.stringify(value)}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`${OPENAI_COMPATIBLE_BASE_URL_ENV} must use http or https (got ${url.protocol})`);
  }
  if (url.username || url.password) {
    throw new Error(
      `${OPENAI_COMPATIBLE_BASE_URL_ENV} must not embed credentials; put the key in ${OPENAI_COMPATIBLE_API_KEY_ENV}`,
    );
  }
  if (url.search || url.hash) {
    throw new Error(`${OPENAI_COMPATIBLE_BASE_URL_ENV} must not include a query string or fragment`);
  }
  // Strip trailing slashes; the SDK appends /chat/completions itself.
  return url.toString().replace(/\/+$/, "");
}

export function resolveOpenAICompatibleSettings(
  modelId: string,
  env: Record<string, string | undefined> = process.env,
): OpenAICompatibleSettings {
  const baseURL = normalizeCompatibleBaseUrl(env[OPENAI_COMPATIBLE_BASE_URL_ENV]);
  const model = (modelId ?? "").trim();
  if (!model) {
    throw new Error(
      'provider "openai-compatible" has no default model. Set SPORTSCLAW_MODEL to the id your server ' +
        "serves (e.g. meta/llama-3.3-70b-instruct).",
    );
  }
  const key = (env[OPENAI_COMPATIBLE_API_KEY_ENV] ?? "").trim();
  return { baseURL, apiKey: key || PLACEHOLDER_KEY, apiKeyProvided: Boolean(key), modelId: model };
}

// ---------------------------------------------------------------------------
// Endpoint host for run manifests
// ---------------------------------------------------------------------------

/** Env var holding each provider's custom endpoint, if it has one. */
const ENDPOINT_ENV: Record<string, string> = {
  anthropic: "ANTHROPIC_BASE_URL",
  openai: "OPENAI_BASE_URL",
  google: "GOOGLE_GENERATIVE_AI_BASE_URL",
  "azure-foundry": "AZURE_FOUNDRY_BASE_URL",
  "openai-compatible": OPENAI_COMPATIBLE_BASE_URL_ENV,
};

/**
 * Host (and port) of the endpoint a provider will call, or null for the
 * provider's default public endpoint. Host only: never path, query or
 * credentials. This is what distinguishes "openai" at api.openai.com from
 * "openai" pointed at a NIM or vLLM box.
 */
export function endpointHost(provider: string, env: Record<string, string | undefined> = process.env): string | null {
  const name = ENDPOINT_ENV[provider];
  const raw = name ? (env[name] ?? "").trim() : "";
  if (!raw) return null;
  try {
    return new URL(raw).host.toLowerCase() || null;
  } catch {
    return "invalid-url";
  }
}
