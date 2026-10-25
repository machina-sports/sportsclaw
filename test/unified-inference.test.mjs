/**
 * Unified inference boundary — behavioral contract
 *
 * Exercises `src/inference/run.ts` (generate / stream / image),
 * `src/inference/decide.ts` (typed Jev entrypoint) and the native role path
 * (`invokeModelRole`, `makeRunModelRole`) against the installed AI SDK's real
 * dispatch loop. Models are in-process LanguageModelV2 fakes or a loopback
 * OpenAI-compatible HTTP fixture; no credentials, no external network.
 *
 * Missing modules/exports are reported as assertion failures (dynamic import +
 * explicit export checks), never as loader crashes.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import http from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

import { tool, jsonSchema, stepCountIs, APICallError } from "ai";

import { JevDecisionClient } from "../dist/decision-client.js";
import { invokeModelRole, InferenceRouteError } from "../dist/inference/model-role-router.js";

globalThis.AI_SDK_LOG_WARNINGS = false;

const distDir = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");

async function load(rel) {
  try {
    return await import(new URL(rel, import.meta.url));
  } catch (err) {
    if (err?.code === "ERR_MODULE_NOT_FOUND") return {};
    throw err;
  }
}

const run = await load("../dist/inference/run.js");
const decideMod = await load("../dist/inference/decide.js");
const operate = await load("../dist/operate.js");

function need(mod, name, where) {
  assert.equal(typeof mod[name], "function", `${where} must export ${name}()`);
  return mod[name];
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const USAGE = { inputTokens: 3, outputTokens: 2, totalTokens: 5 };
const PROMPT_SECRET = "PROMPT-SECRET-7f3a user=acct_998877";
const SYSTEM_SECRET = "SYSTEM-SECRET-c41d";
const RECEIPT_KEYS = new Set([
  "kind", "purpose", "route", "modelId", "status", "errorCode",
  "latencyMs", "finishReason", "usage", "steps", "decision",
]);

function textResult(text) {
  return { content: [{ type: "text", text }], finishReason: "stop", usage: USAGE, warnings: [] };
}

/** In-process LanguageModelV2. Records every call's options. */
function fakeModel({ modelId = "fake-model-1", generate, stream } = {}) {
  const calls = [];
  return {
    calls,
    specificationVersion: "v2",
    provider: "fake",
    modelId,
    supportedUrls: {},
    async doGenerate(options) {
      calls.push(options);
      return generate(options, calls.length);
    },
    async doStream(options) {
      calls.push(options);
      return stream(options, calls.length);
    },
  };
}

/** Pull-based V2 stream. `gate` (index → Promise) holds a part until released. */
function partStream(parts, { gate = {}, signal, onPull } = {}) {
  let i = 0;
  return new ReadableStream({
    async pull(controller) {
      onPull?.(i);
      if (gate[i]) await gate[i];
      if (signal?.aborted) {
        controller.error(signal.reason ?? new DOMException("aborted", "AbortError"));
        return;
      }
      if (i >= parts.length) {
        controller.close();
        return;
      }
      controller.enqueue(parts[i++]);
    },
  });
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

class ProviderBoom extends Error {
  constructor() {
    super("upstream said sk-live-123 at https://internal.example/v1");
    this.name = "SecretNameLeak_sk-live-456";
  }
}

function assertReceiptShape(receipt, forbidden = []) {
  for (const key of Object.keys(receipt)) {
    assert.ok(RECEIPT_KEYS.has(key), `unexpected receipt key ${key}`);
  }
  assert.equal(typeof receipt.latencyMs, "number");
  const serialized = JSON.stringify(receipt);
  for (const needle of [PROMPT_SECRET, SYSTEM_SECRET, "acct_998877", ...forbidden]) {
    assert.ok(!serialized.includes(needle), `receipt leaked ${needle}: ${serialized}`);
  }
}

function assertErrorCode(receipt) {
  const codes = run.INFERENCE_ERROR_CODES;
  assert.ok(Array.isArray(codes), "run.js must export the closed INFERENCE_ERROR_CODES list");
  for (const code of codes) assert.match(code, /^[a-z_]+$/);
  assert.ok(codes.includes(receipt.errorCode), `errorCode ${receipt.errorCode} is not in the closed enum`);
}

async function waitFor(predicate, ms = 2_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(10);
  }
  return predicate();
}

/** Loopback OpenAI-compatible fixture. Records each request and early closes. */
async function nativeServer(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const entry = { method: req.method, url: req.url, body, closedEarly: false };
      requests.push(entry);
      res.on("close", () => {
        if (!res.writableEnded) entry.closedEarly = true;
      });
      handler(entry, res);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  return {
    requests,
    port,
    origin: `http://127.0.0.1:${port}`,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

function chatCompletion(res, content = "role answer") {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({
    id: "chatcmpl-fixture",
    object: "chat.completion",
    created: 1_760_000_000,
    model: "nvidia/nemotron-fixture",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
  }));
}

// ---------------------------------------------------------------------------
// generate()
// ---------------------------------------------------------------------------

describe("unified generate()", () => {
  it("runs the real SDK tool loop with every per-call option reaching the model", async () => {
    const generate = need(run, "generate", "inference/run.js");
    const model = fakeModel({
      generate: (_o, n) =>
        n === 1
          ? {
              content: [{ type: "tool-call", toolCallId: "call-1", toolName: "lookup", input: '{"q":"abc"}' }],
              finishReason: "tool-calls",
              usage: USAGE,
              warnings: [],
            }
          : textResult("done"),
    });
    let executed = 0;
    let prepared = 0;
    const receipts = [];
    const result = await generate(
      { purpose: "chat", onReceipt: (r) => receipts.push(r) },
      {
        model,
        system: SYSTEM_SECRET,
        prompt: PROMPT_SECRET,
        temperature: 0.2,
        seed: 7,
        maxOutputTokens: 64,
        providerOptions: { fake: { flag: true } },
        headers: { "x-trace": "t1" },
        tools: {
          lookup: tool({
            description: "lookup",
            inputSchema: jsonSchema({
              type: "object",
              properties: { q: { type: "string" } },
              required: ["q"],
              additionalProperties: false,
            }),
            execute: async ({ q }) => {
              executed++;
              return { answer: `TOOL-OUTPUT-${q.toUpperCase()}` };
            },
          }),
        },
        toolChoice: "auto",
        stopWhen: stepCountIs(3),
        prepareStep: () => {
          prepared++;
          return undefined;
        },
        maxRetries: 0,
      },
    );

    assert.equal(result.text, "done");
    assert.equal(result.steps.length, 2, "the SDK result object is returned as-is");
    assert.equal(executed, 1);
    assert.equal(prepared, 2);
    assert.equal(model.calls.length, 2);
    const first = model.calls[0];
    assert.equal(first.temperature, 0.2);
    assert.equal(first.seed, 7);
    assert.equal(first.maxOutputTokens, 64);
    assert.deepEqual(first.providerOptions?.fake, { flag: true });
    assert.equal(first.headers?.["x-trace"], "t1");
    assert.deepEqual(first.tools.map((t) => t.name), ["lookup"]);

    assert.equal(receipts.length, 1, "exactly one receipt per call");
    const [receipt] = receipts;
    assert.equal(receipt.kind, "generate");
    assert.equal(receipt.purpose, "chat");
    assert.equal(receipt.route, "direct", "route defaults to direct");
    assert.equal(receipt.status, "completed");
    assert.equal(receipt.modelId, "fake-model-1");
    assertReceiptShape(receipt, ["TOOL-OUTPUT", '"q"']);
  });

  it("rethrows the original provider error instance and emits a sanitized failed receipt", async () => {
    const generate = need(run, "generate", "inference/run.js");
    const boom = new ProviderBoom();
    const model = fakeModel({ generate: () => { throw boom; } });
    const receipts = [];
    await assert.rejects(
      generate({ purpose: "verification", onReceipt: (r) => receipts.push(r) }, {
        model, system: SYSTEM_SECRET, prompt: PROMPT_SECRET, maxRetries: 0,
      }),
      (err) => err === boom,
    );
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].status, "failed");
    assertErrorCode(receipts[0]);
    assertReceiptShape(receipts[0], ["SecretNameLeak", "sk-live", "internal.example", "upstream said"]);
  });

  it("preserves call-specific maxRetries for retryable provider errors", async () => {
    const generate = need(run, "generate", "inference/run.js");
    const retryable = () =>
      new APICallError({
        message: "overloaded",
        url: "https://internal.example/v1/chat",
        requestBodyValues: {},
        statusCode: 503,
        isRetryable: true,
      });
    const model = fakeModel({ generate: () => { throw retryable(); } });
    await assert.rejects(generate({ purpose: "routing" }, { model, prompt: "p", maxRetries: 0 }));
    assert.equal(model.calls.length, 1, "maxRetries: 0 means one attempt, not the SDK default");
  });

  it("propagates the caller's abort to the model and reports aborted, not failed", async () => {
    const generate = need(run, "generate", "inference/run.js");
    const controller = new AbortController();
    const started = deferred();
    const model = fakeModel({
      generate: (opts) =>
        new Promise((_resolve, reject) => {
          started.resolve();
          opts.abortSignal.addEventListener("abort", () => reject(opts.abortSignal.reason), { once: true });
        }),
    });
    const receipts = [];
    const pending = generate({ purpose: "subagent", onReceipt: (r) => receipts.push(r) }, {
      model, prompt: PROMPT_SECRET, abortSignal: controller.signal, maxRetries: 0,
    });
    await started.promise;
    controller.abort();
    await assert.rejects(pending);
    assert.equal(model.calls[0].abortSignal?.aborted, true, "the model saw the abort");
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].status, "aborted");
    assert.equal(receipts[0].errorCode, "aborted");
    assertReceiptShape(receipts[0]);
  });

  it("isolates receipts between overlapping calls without shared last-call state", async () => {
    const generate = need(run, "generate", "inference/run.js");
    const slow = fakeModel({ modelId: "slow-model", generate: async () => { await sleep(40); return textResult("slow"); } });
    const fast = fakeModel({ modelId: "fast-model", generate: async () => textResult("fast") });
    const a = [];
    const b = [];
    const [ra, rb] = await Promise.all([
      generate({ purpose: "heartbeat_condition", onReceipt: (r) => a.push(r) }, { model: slow, prompt: "a" }),
      generate({ purpose: "momentum_explain", onReceipt: (r) => b.push(r) }, { model: fast, prompt: "b" }),
    ]);
    assert.equal(ra.text, "slow");
    assert.equal(rb.text, "fast");
    assert.deepEqual(a.map((r) => [r.purpose, r.modelId]), [["heartbeat_condition", "slow-model"]]);
    assert.deepEqual(b.map((r) => [r.purpose, r.modelId]), [["momentum_explain", "fast-model"]]);
  });

  it("does not let a throwing observer mask the result or the original error", async () => {
    const generate = need(run, "generate", "inference/run.js");
    const throwing = () => { throw new Error("observer exploded"); };
    const ok = await generate({ purpose: "setup", onReceipt: throwing }, {
      model: fakeModel({ generate: () => textResult("fine") }), prompt: "p",
    });
    assert.equal(ok.text, "fine");

    const boom = new ProviderBoom();
    await assert.rejects(
      generate({ purpose: "setup", onReceipt: throwing }, {
        model: fakeModel({ generate: () => { throw boom; } }), prompt: "p", maxRetries: 0,
      }),
      (err) => err === boom,
    );
  });

  it("never emits an unsafe model identifier such as a URL or credential", async () => {
    const generate = need(run, "generate", "inference/run.js");
    const receipts = [];
    await generate({ purpose: "chat", onReceipt: (r) => receipts.push(r) }, {
      model: fakeModel({
        modelId: "https://user:sk-secret-999@internal.example/v1/models/x",
        generate: () => textResult("ok"),
      }),
      prompt: "p",
    });
    assert.equal(receipts.length, 1);
    assertReceiptShape(receipts[0], ["internal.example", "sk-secret-999", "https://"]);
  });
});

// ---------------------------------------------------------------------------
// stream()
// ---------------------------------------------------------------------------

function textParts(chunks) {
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t1" },
    ...chunks.map((delta) => ({ type: "text-delta", id: "t1", delta })),
    { type: "text-end", id: "t1" },
    { type: "finish", finishReason: "stop", usage: USAGE },
  ];
}

describe("unified stream()", () => {
  it("returns the SDK stream result synchronously and reports only after real completion", async () => {
    const stream = need(run, "stream", "inference/run.js");
    const finishGate = deferred();
    const parts = textParts(["Hel", "lo"]);
    const model = fakeModel({
      stream: () => ({ stream: partStream(parts, { gate: { [parts.length - 1]: finishGate.promise } }) }),
    });
    const events = [];
    const result = stream(
      { purpose: "chat", onReceipt: (r) => events.push(["receipt", r]) },
      {
        model,
        system: SYSTEM_SECRET,
        prompt: PROMPT_SECRET,
        onFinish: () => events.push(["caller-onFinish"]),
      },
    );
    assert.equal(typeof result?.then, "undefined", "stream() must not return a Promise");
    assert.equal(typeof result.textStream?.[Symbol.asyncIterator], "function");
    assert.equal(typeof result.toUIMessageStreamResponse, "function", "original StreamTextResult is preserved");

    await sleep(30);
    assert.deepEqual(events, [], "no receipt and no eager drain before the caller consumes");

    const iterator = result.textStream[Symbol.asyncIterator]();
    const seen = [(await iterator.next()).value, (await iterator.next()).value];
    assert.deepEqual(seen, ["Hel", "lo"]);
    await sleep(20);
    assert.deepEqual(events, [], "a partially consumed stream has not completed");

    finishGate.resolve();
    for (let step = await iterator.next(); !step.done; step = await iterator.next()) seen.push(step.value);
    assert.equal(await result.text, "Hello");
    await waitFor(() => events.length >= 2);

    assert.deepEqual(events.map((e) => e[0]), ["caller-onFinish", "receipt"], "caller handler first, then one receipt");
    const receipt = events[1][1];
    assert.equal(receipt.kind, "stream");
    assert.equal(receipt.status, "completed");
    assert.equal(receipt.purpose, "chat");
    assertReceiptShape(receipt, ["Hello"]);
  });

  it("reports a mid-stream provider error once as failed and preserves the error identity", async () => {
    const stream = need(run, "stream", "inference/run.js");
    const boom = new ProviderBoom();
    const model = fakeModel({
      stream: () => ({
        stream: partStream([
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", delta: "partial" },
          { type: "error", error: boom },
        ]),
      }),
    });
    const receipts = [];
    const callerErrors = [];
    const result = stream({ purpose: "operator_tick", onReceipt: (r) => receipts.push(r) }, {
      model, prompt: PROMPT_SECRET, onError: ({ error }) => callerErrors.push(error),
    });
    const errorParts = [];
    try {
      for await (const part of result.fullStream) if (part.type === "error") errorParts.push(part.error);
    } catch {
      // Either surfacing style is acceptable; the receipt is what is asserted.
    }
    await waitFor(() => receipts.length >= 1);
    await sleep(20);

    assert.ok(errorParts.includes(boom) || callerErrors.includes(boom), "the original error instance reaches the caller");
    assert.equal(callerErrors.length, 1, "the caller's onError runs once");
    assert.equal(callerErrors[0], boom);
    assert.equal(receipts.length, 1, "exactly one receipt per stream");
    assert.equal(receipts[0].kind, "stream");
    assert.equal(receipts[0].status, "failed");
    assertErrorCode(receipts[0]);
    assertReceiptShape(receipts[0], ["SecretNameLeak", "sk-live", "internal.example", "partial"]);
  });

  it("reports a caller abort mid-stream once as aborted and runs the caller's onAbort", async () => {
    const stream = need(run, "stream", "inference/run.js");
    const controller = new AbortController();
    const never = new Promise(() => {});
    const model = fakeModel({
      stream: (opts) => ({
        stream: partStream(textParts(["one", "two"]), { gate: { 3: Promise.race([never, abortOf(opts.abortSignal)]) }, signal: opts.abortSignal }),
      }),
    });
    const receipts = [];
    let callerAborts = 0;
    const result = stream({ purpose: "chat_lane", onReceipt: (r) => receipts.push(r) }, {
      model, prompt: PROMPT_SECRET, abortSignal: controller.signal, onAbort: () => callerAborts++,
    });
    const iterator = result.textStream[Symbol.asyncIterator]();
    assert.equal((await iterator.next()).value, "one");
    controller.abort();
    try {
      while (!(await iterator.next()).done);
    } catch {
      // Abort may surface as a rejection; that is the SDK's contract.
    }
    await waitFor(() => receipts.length >= 1);
    await sleep(20);
    assert.equal(model.calls[0].abortSignal?.aborted, true, "the abort reached the model");
    assert.equal(callerAborts, 1);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].status, "aborted");
    assertReceiptShape(receipts[0]);
  });

  it("completes the stream even when the receipt observer throws", async () => {
    const stream = need(run, "stream", "inference/run.js");
    const model = fakeModel({ stream: () => ({ stream: partStream(textParts(["a", "b"])) }) });
    const result = stream({ purpose: "chat", onReceipt: () => { throw new Error("observer exploded"); } }, {
      model, prompt: "p",
    });
    let text = "";
    for await (const delta of result.textStream) text += delta;
    assert.equal(text, "ab");
    assert.equal(await result.text, "ab");
  });
});

function abortOf(signal) {
  return new Promise((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
}

// ---------------------------------------------------------------------------
// image()
// ---------------------------------------------------------------------------

describe("unified image()", () => {
  async function withImageNim(handler, fn) {
    const server = await nativeServer(handler);
    const saved = { base: process.env.NIM_IMAGE_BASE_URL, model: process.env.NIM_IMAGE_MODEL };
    process.env.NIM_IMAGE_BASE_URL = server.origin;
    process.env.NIM_IMAGE_MODEL = "qwen/qwen-image-2512";
    try {
      return await fn(server);
    } finally {
      for (const [key, env] of [["base", "NIM_IMAGE_BASE_URL"], ["model", "NIM_IMAGE_MODEL"]]) {
        if (saved[key] === undefined) delete process.env[env];
        else process.env[env] = saved[key];
      }
      await server.close();
    }
  }

  it("delegates to the native image backend and emits a receipt without prompt or endpoint", async () => {
    const image = need(run, "image", "inference/run.js");
    await withImageNim(
      (_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ b64_json: "aGVsbG8=" }] }));
      },
      async (server) => {
        const receipts = [];
        const generated = await image({ purpose: "image", route: "nim", onReceipt: (r) => receipts.push(r) },
          "openai", PROMPT_SECRET, "512x512");
        assert.equal(generated.data, "aGVsbG8=");
        assert.equal(server.requests.length, 1);
        assert.equal(JSON.parse(server.requests[0].body).prompt, PROMPT_SECRET);
        assert.equal(receipts.length, 1);
        assert.equal(receipts[0].kind, "image");
        assert.equal(receipts[0].status, "completed");
        assert.equal(receipts[0].route, "nim");
        assertReceiptShape(receipts[0], ["127.0.0.1", String(server.port)]);
      },
    );
  });

  it("rethrows the backend error and keeps the provider body out of the receipt", async () => {
    const image = need(run, "image", "inference/run.js");
    await withImageNim(
      (_req, res) => {
        res.writeHead(500);
        res.end("upstream-secret-body");
      },
      async () => {
        const receipts = [];
        await assert.rejects(image({ purpose: "image", route: "nim", onReceipt: (r) => receipts.push(r) },
          "openai", PROMPT_SECRET, "512x512"));
        assert.equal(receipts.length, 1);
        assert.equal(receipts[0].status, "failed");
        assertErrorCode(receipts[0]);
        assertReceiptShape(receipts[0], ["upstream-secret-body"]);
      },
    );
  });
});

// ---------------------------------------------------------------------------
// decide()
// ---------------------------------------------------------------------------

const DECISION_REQUEST = {
  state: "Synthetic: Falcons 2-1 Rovers.",
  questions: { has_injuries: { type: "noul", instructions: "Does the state report an injury?" } },
};

describe("typed decide()", () => {
  it("keeps Jev local_only refusal typed, makes zero transport calls and forwards the client receipt", async () => {
    const decide = need(decideMod, "decide", "inference/decide.js");
    const calls = [];
    const client = new JevDecisionClient({
      transport: async (...args) => {
        calls.push(args);
        throw new Error("transport must not be reached");
      },
      env: { TYPESAFE_API_KEY: "jev-key-secret" },
    });
    const receipts = [];
    const result = await decide({ purpose: "evidence_decision", onReceipt: (r) => receipts.push(r) }, client, DECISION_REQUEST);
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, "local_only");
    assert.equal(calls.length, 0);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].kind, "decision");
    assert.equal(receipts[0].purpose, "evidence_decision");
    assert.deepEqual(receipts[0].decision, result.receipt);
    assertReceiptShape(receipts[0], ["Falcons", "jev-key-secret", "has_injuries"]);
  });

  it("returns the client's result object unchanged and forwards call options", async () => {
    const decide = need(decideMod, "decide", "inference/decide.js");
    const sentinel = { ok: false, reasonCode: "rate_limited", receipt: { provider: "jev", status: "failed" } };
    const seen = [];
    const client = { decide: async (request, options) => { seen.push([request, options]); return sentinel; } };
    const controller = new AbortController();
    const result = await decide({ purpose: "capability_routing" }, client, DECISION_REQUEST, { abortSignal: controller.signal });
    assert.equal(result, sentinel);
    assert.equal(seen.length, 1);
    assert.equal(seen[0][0], DECISION_REQUEST);
    assert.equal(seen[0][1]?.abortSignal, controller.signal);
  });

  it("keeps the decide path free of the SDK, engine, MCP and memory", () => {
    need(decideMod, "decide", "inference/decide.js");
    const graph = runtimeGraph(join(distDir, "inference", "decide.js"));
    assert.deepEqual(graph.external, [], "decide.js must not pull in a package dependency");
    for (const file of graph.files) {
      assert.ok(
        ["inference/decide.js", "inference/receipt.js", "decision-client.js"].includes(file),
        `unexpected module on the decide path: ${file}`,
      );
    }
  });

  it("routes the decision relay through decide without widening its import graph", () => {
    const graph = runtimeGraph(join(distDir, "decision-relay.js"));
    assert.deepEqual(graph.external, []);
    assert.ok(graph.files.includes("inference/decide.js"), "decision-relay must call the typed boundary");
    for (const file of graph.files) {
      assert.ok(
        ["decision-relay.js", "decision-client.js", "inference/decide.js", "inference/receipt.js"].includes(file),
        `unexpected module in the relay graph: ${file}`,
      );
    }
  });
});

/** Runtime (compiled) import graph: relative files + external specifiers. */
function runtimeGraph(entry) {
  const seen = new Set();
  const external = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    let source;
    try {
      source = readFileSync(file, "utf-8");
    } catch {
      return;
    }
    const specs = [
      ...source.matchAll(/\bfrom\s*["']([^"']+)["']/g),
      ...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']/g),
      ...source.matchAll(/^\s*import\s*["']([^"']+)["']/gm),
    ];
    for (const [, spec] of specs) {
      if (spec.startsWith(".")) visit(join(dirname(file), spec));
      else if (!spec.startsWith("node:")) external.add(spec);
    }
  };
  visit(entry);
  return {
    files: [...seen].map((f) => f.slice(distDir.length + 1)).sort(),
    external: [...external],
  };
}

// ---------------------------------------------------------------------------
// Native role paths (NIM / OpenShell)
// ---------------------------------------------------------------------------

describe("native role inference", () => {
  const MODEL = "nvidia/nemotron-fixture";

  it("runs a NIM role through the boundary with a route-labelled receipt and no endpoint", async () => {
    const server = await nativeServer((_req, res) => chatCompletion(res, "role answer"));
    try {
      const receipts = [];
      const result = await invokeModelRole({
        role: "brain",
        input: PROMPT_SECRET,
        source: "sink",
        config: { roles: { brain: { route: "nim", model: MODEL, baseUrl: server.baseUrl } } },
        onReceipt: (r) => receipts.push(r),
      });
      assert.equal(result.output, "role answer");
      assert.equal(server.requests.length, 1);
      assert.equal(receipts.length, 1, "invokeModelRole forwards a per-call receipt observer");
      assert.equal(receipts[0].route, "nim");
      assert.equal(receipts[0].purpose, "model_role");
      assert.equal(receipts[0].status, "completed");
      assertReceiptShape(receipts[0], ["127.0.0.1", String(server.port), "role answer"]);
    } finally {
      await server.close();
    }
  });

  it("propagates a caller abort to the in-flight NIM request", async () => {
    const server = await nativeServer(() => {});
    try {
      const controller = new AbortController();
      const pending = invokeModelRole({
        role: "brain",
        input: "hang",
        source: "sink",
        config: { roles: { brain: { route: "nim", model: MODEL, baseUrl: server.baseUrl, timeoutMs: 2000 } } },
        abortSignal: controller.signal,
      });
      assert.ok(await waitFor(() => server.requests.length === 1), "request reached the fixture");
      controller.abort();
      const outcome = await Promise.race([
        pending.then(() => "resolved", () => "rejected"),
        new Promise((resolve) => setTimeout(() => resolve("still_running"), 500)),
      ]);
      assert.equal(outcome, "rejected", "caller abort must reject promptly, not leave native inference running");
      assert.ok(await waitFor(() => server.requests[0].closedEarly), "the underlying HTTP request was cancelled");
    } finally {
      await server.close();
    }
  });

  it("makeRunModelRole's timeout aborts the underlying request, not only the race", async () => {
    const makeRunModelRole = need(operate, "makeRunModelRole", "operate.js");
    const server = await nativeServer(() => {});
    try {
      const runRole = makeRunModelRole();
      const outcome = await runRole({
        role: "brain",
        input: "hang",
        source: "sink",
        config: { roles: { brain: { route: "nim", model: MODEL, baseUrl: server.baseUrl } } },
        timeoutMs: 150,
      });
      assert.equal(outcome.status, "timed_out");
      assert.equal(outcome.output, undefined);
      assert.ok(await waitFor(() => server.requests[0]?.closedEarly === true), "timed-out request must be aborted");
    } finally {
      await server.close();
    }
  });

  it("keeps the OpenShell sandbox refusal authoritative: no request, no completed receipt", async () => {
    const server = await nativeServer((_req, res) => chatCompletion(res));
    const saved = { ...process.env };
    for (const key of Object.keys(process.env)) if (key.startsWith("OPENSHELL")) delete process.env[key];
    try {
      const receipts = [];
      await assert.rejects(
        invokeModelRole({
          role: "brain",
          input: "x",
          source: "sink",
          config: { roles: { brain: { route: "openshell", model: MODEL, baseUrl: server.baseUrl, credentialless: true } } },
          onReceipt: (r) => receipts.push(r),
        }),
        (err) => err instanceof InferenceRouteError,
      );
      assert.equal(server.requests.length, 0, "no cloud or native fallback request");
      assert.ok(receipts.every((r) => r.status !== "completed"));
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
      await server.close();
    }
  });
});
