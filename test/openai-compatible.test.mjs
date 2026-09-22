import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { generateText } from "ai";
import { buildRunManifest } from "../dist/run-manifest.js";
import { resolveModel } from "../dist/llm-providers.js";
import {
  endpointHost,
  normalizeCompatibleBaseUrl,
  resolveOpenAICompatibleSettings,
} from "../dist/openai-compatible.js";
import { buildProviderOptions, DEFAULT_MODELS } from "../dist/types.js";
import { providerToolCeiling, PROVIDER_TOOL_CEILING } from "../dist/routing/tool-activation.js";
import { validateOperatorJobConfig } from "../dist/operator-config.js";

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

test("base URL is validated and normalized", () => {
  assert.equal(normalizeCompatibleBaseUrl("http://localhost:8000/v1/"), "http://localhost:8000/v1");
  assert.equal(normalizeCompatibleBaseUrl(" https://integrate.api.nvidia.com/v1 "), "https://integrate.api.nvidia.com/v1");
  for (const [value, pattern] of [
    [undefined, /requires OPENAI_COMPATIBLE_BASE_URL/],
    ["   ", /requires OPENAI_COMPATIBLE_BASE_URL/],
    ["not a url", /not a valid URL/],
    ["ftp://host/v1", /must use http or https/],
    ["https://user:secret@host/v1", /must not embed credentials/],
    ["https://host/v1?key=abc", /query string or fragment/],
  ]) {
    assert.throws(() => normalizeCompatibleBaseUrl(value), pattern, String(value));
  }
});

test("a model id is required and the key is optional", () => {
  const env = { OPENAI_COMPATIBLE_BASE_URL: "http://localhost:8000/v1" };
  assert.throws(() => resolveOpenAICompatibleSettings("", env), /no default model/);
  assert.throws(() => resolveOpenAICompatibleSettings("  ", env), /no default model/);

  const keyless = resolveOpenAICompatibleSettings("llama-3.3-70b", env);
  assert.equal(keyless.apiKeyProvided, false);
  assert.equal(keyless.apiKey, "not-needed");

  const keyed = resolveOpenAICompatibleSettings("llama-3.3-70b", { ...env, OPENAI_COMPATIBLE_API_KEY: "k" });
  assert.deepEqual(keyed, { baseURL: "http://localhost:8000/v1", apiKey: "k", apiKeyProvided: true, modelId: "llama-3.3-70b" });
});

test("there is no default model, and no reasoning options are sent", () => {
  assert.equal(DEFAULT_MODELS["openai-compatible"], "");
  assert.equal(buildProviderOptions("openai-compatible", 8192), undefined);
  assert.equal(providerToolCeiling("openai-compatible"), PROVIDER_TOOL_CEILING);
});

// ---------------------------------------------------------------------------
// Endpoint host (manifest)
// ---------------------------------------------------------------------------

test("endpointHost reports host and port only, and null for default endpoints", () => {
  assert.equal(endpointHost("anthropic", {}), null);
  assert.equal(endpointHost("openai", {}), null);
  assert.equal(endpointHost("openai", { OPENAI_BASE_URL: "https://integrate.api.nvidia.com/v1" }), "integrate.api.nvidia.com");
  assert.equal(
    endpointHost("openai-compatible", { OPENAI_COMPATIBLE_BASE_URL: "http://user:pw@GPU-box:8000/v1/chat?x=1" }),
    "gpu-box:8000",
  );
  assert.equal(endpointHost("openai-compatible", { OPENAI_COMPATIBLE_BASE_URL: "junk" }), "invalid-url");
});

test("endpoint_host is part of the manifest config and its hash", () => {
  const input = {
    sportsclawVersion: "0.29.4", sportsSkillsVersion: "0.33.0", provider: "openai", model: "llama",
    sampling: {}, maxOutputTokens: 1024, maxTurns: 5, thinkingBudget: 0,
  };
  const publicOpenAI = buildRunManifest({ ...input, env: {} });
  const nim = buildRunManifest({ ...input, env: { OPENAI_BASE_URL: "https://integrate.api.nvidia.com/v1" } });
  assert.equal(publicOpenAI.config.endpoint_host, null);
  assert.equal(nim.config.endpoint_host, "integrate.api.nvidia.com");
  assert.notEqual(publicOpenAI.config_sha256, nim.config_sha256, "same provider name, different endpoint, different hash");
  assert.ok(!JSON.stringify(nim).includes("/v1"), "only the host is recorded");
});

// ---------------------------------------------------------------------------
// Operator job config
// ---------------------------------------------------------------------------

test("operator jobs accept the provider but reject it under openshell", () => {
  const base = { jobId: "compat-job", intervalMs: 60_000, personaText: "operator", provider: "openai-compatible" };
  assert.equal(validateOperatorJobConfig(base).valid, true);
  const r = validateOperatorJobConfig({ ...base, openshell: {} });
  assert.equal(r.valid, false);
  assert.match(JSON.stringify(r), /openai-compatible.*not supported under openshell/);
});

// ---------------------------------------------------------------------------
// Wire behavior against a real HTTP server
// ---------------------------------------------------------------------------

async function withServer(handler, fn) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requests.push({ method: req.method, url: req.url, auth: req.headers.authorization ?? null, body: JSON.parse(body || "{}") });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(handler()));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}/v1`, requests);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const completion = () => ({
  id: "c1", object: "chat.completion", created: 1, model: "served-llama",
  choices: [{ index: 0, message: { role: "assistant", content: "hello from vllm" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
});

function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return Promise.resolve(fn()).finally(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

test("requests go to {base}/chat/completions with the compatible key, never the OpenAI one", async () => {
  await withServer(completion, async (baseUrl, requests) => {
    await withEnv(
      {
        OPENAI_COMPATIBLE_BASE_URL: baseUrl,
        OPENAI_COMPATIBLE_API_KEY: "compat-key",
        OPENAI_API_KEY: "real-openai-key-must-not-leak",
        OPENAI_BASE_URL: "http://127.0.0.1:1/should-not-be-used",
      },
      async () => {
        const model = resolveModel("openai-compatible", "meta/llama-3.3-70b-instruct");
        const result = await generateText({ model, prompt: "hi", temperature: 0, seed: 7 });
        assert.equal(result.text, "hello from vllm");
        assert.equal(result.response.modelId, "served-llama");
      },
    );
    assert.equal(requests.length, 1);
    const [req] = requests;
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/v1/chat/completions");
    assert.equal(req.auth, "Bearer compat-key");
    assert.equal(req.body.model, "meta/llama-3.3-70b-instruct");
    assert.equal(req.body.temperature, 0);
    assert.equal(req.body.seed, 7);
    assert.ok(!JSON.stringify(req).includes("real-openai-key"), "the OpenAI key is never sent");
  });
});

test("keyless local servers work, and a missing model fails before any request", async () => {
  await withServer(completion, async (baseUrl, requests) => {
    await withEnv({ OPENAI_COMPATIBLE_BASE_URL: baseUrl, OPENAI_COMPATIBLE_API_KEY: undefined }, async () => {
      const model = resolveModel("openai-compatible", "qwen2.5:7b");
      await generateText({ model, prompt: "hi" });
      assert.throws(() => resolveModel("openai-compatible", ""), /no default model/);
    });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].auth, "Bearer not-needed");
  });
});
