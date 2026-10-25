/**
 * Unified inference — review v1 corrections (engine items 1, 2 and 5)
 *
 *   1. stream(): synchronous SDK construction errors and errors raised by the
 *      model's underlying ReadableStream (controller.error) must still produce
 *      exactly one failed receipt, without eager draining and without changing
 *      what the caller observes compared to the raw installed SDK.
 *   2. generate() with finishReason "error", stream() with an explicit error
 *      finish, and stream() whose caller onFinish rejects report failed, once.
 *   5. An async receipt observer that rejects can never crash or alter
 *      inference, and its error is never logged.
 *
 * Every stream/observer probe runs in its own bounded child process (hard
 * in-child deadline + spawnSync timeout), so a stray rejection or a hung
 * stream can never cancel or wedge this test runner. Each probe is run
 * against the raw SDK `streamText` and against `stream()` and compared.
 * Models are synthetic in-process LanguageModelV2 fakes; no network.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

it("observes stream errors without depending on private SDK result methods", () => {
  const source = readFileSync(new URL("../src/inference/run.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\.teeStream\b|["']teeStream["']/);
});

globalThis.AI_SDK_LOG_WARNINGS = false;

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const RUN_URL = new URL("../dist/inference/run.js", import.meta.url).href;
const DECIDE_URL = new URL("../dist/inference/decide.js", import.meta.url).href;
const AI_URL = import.meta.resolve("ai");

async function load(rel) {
  try {
    return await import(new URL(rel, import.meta.url));
  } catch (err) {
    if (err?.code === "ERR_MODULE_NOT_FOUND") return {};
    throw err;
  }
}

const run = await load("../dist/inference/run.js");

const SECRET = "PROBE-SECRET sk-live-000 at https://internal.example/v1";
const USAGE = { inputTokens: 3, outputTokens: 2, totalTokens: 5 };

function errorCodes() {
  assert.ok(Array.isArray(run.INFERENCE_ERROR_CODES), "run.js must export INFERENCE_ERROR_CODES");
  return run.INFERENCE_ERROR_CODES;
}

// ---------------------------------------------------------------------------
// Isolated child-process probe harness
// ---------------------------------------------------------------------------

const PRELUDE = [
  `import * as run from ${JSON.stringify(RUN_URL)};`,
  `import * as decideMod from ${JSON.stringify(DECIDE_URL)};`,
  `import { streamText } from ${JSON.stringify(AI_URL)};`,
  `globalThis.AI_SDK_LOG_WARNINGS = false;`,
  `const USAGE = ${JSON.stringify(USAGE)};`,
  `class ProbeBoom extends Error { constructor() { super(${JSON.stringify(SECRET)}); this.name = "ProbeBoom"; } }`,
  `class CallerFinishError extends Error { constructor() { super("caller onFinish failed"); this.name = "CallerFinishError"; } }`,
  `const boom = new ProbeBoom();`,
  `const unhandled = [];`,
  `const sleep = (ms) => new Promise((r) => setTimeout(r, ms));`,
  `const hard = setTimeout(() => { process.stdout.write("RESULT " + JSON.stringify({ hardTimeout: true }) + "\\n"); process.exit(0); }, 8000);`,
  `const describeErr = (e) => ({ name: e?.name, isBoom: e === boom, isCaller: e instanceof CallerFinishError });`,
  `const settle = (p, ms = 1500) => new Promise((res) => {`,
  `  const t = setTimeout(() => res({ state: "pending" }), ms);`,
  `  Promise.resolve(p).then((value) => { clearTimeout(t); res({ state: "resolved", value }); },`,
  `    (e) => { clearTimeout(t); res({ state: "rejected", ...describeErr(e) }); });`,
  `});`,
  `const waitFor = async (pred, ms) => { const end = Date.now() + ms; while (Date.now() < end && !pred()) await sleep(10); };`,
  `const textParts = (chunks, finishReason = "stop") => [`,
  `  { type: "stream-start", warnings: [] }, { type: "text-start", id: "t1" },`,
  `  ...chunks.map((delta) => ({ type: "text-delta", id: "t1", delta })),`,
  `  { type: "text-end", id: "t1" }, { type: "finish", finishReason, usage: USAGE },`,
  `];`,
  `function fakeModel(parts) {`,
  `  const m = { specificationVersion: "v2", provider: "fake", modelId: "probe-model", supportedUrls: {}, pulls: 0,`,
  `    async doGenerate() { return { content: [{ type: "text", text: "g" }], finishReason: "stop", usage: USAGE, warnings: [] }; },`,
  `    async doStream() {`,
  `      let i = 0;`,
  `      return { stream: new ReadableStream({ pull(c) {`,
  `        m.pulls++;`,
  `        const p = parts[i++];`,
  `        if (p === undefined) return c.close();`,
  `        if (p === "ERROR") return c.error(boom);`,
  `        c.enqueue(p);`,
  `      } }) };`,
  `    },`,
  `  };`,
  `  return m;`,
  `}`,
  `async function consume(result, mode) {`,
  `  if (mode === "text") return await result.text;`,
  `  const out = [];`,
  `  if (mode === "textStream") { for await (const d of result.textStream) out.push(d); return out; }`,
  `  for await (const p of result.fullStream) out.push(p.type === "error" ? { type: "error", ...describeErr(p.error) } : p.type);`,
  `  return out;`,
  `}`,
].join("\n");

const EPILOGUE = [
  `const result = await main();`,
  `clearTimeout(hard);`,
  `process.stdout.write("RESULT " + JSON.stringify(result) + "\\n");`,
  `setTimeout(() => process.exit(0), 200);`,
].join("\n");

/** Run one probe in a fresh, bounded Node process. Never throws for a crash. */
function probe(body, { trackUnhandled = true } = {}) {
  const script = [
    PRELUDE,
    trackUnhandled ? `process.on("unhandledRejection", (e) => unhandled.push(e?.name ?? typeof e));` : "",
    body,
    EPILOGUE,
  ].join("\n");
  const child = spawnSync(process.execPath, ["--unhandled-rejections=throw", "--input-type=module", "-e", script], {
    cwd: repoRoot,
    encoding: "utf-8",
    timeout: 20_000,
    env: { PATH: process.env.PATH ?? "" },
  });
  const line = (child.stdout ?? "").split("\n").find((l) => l.startsWith("RESULT "));
  return {
    status: child.status,
    signal: child.signal,
    stderr: child.stderr ?? "",
    result: line ? JSON.parse(line.slice("RESULT ".length)) : undefined,
  };
}

/**
 * One stream scenario. `impl` is "raw" (installed SDK streamText) or
 * "wrapped" (unified stream()). `paramsJs` is a JS object-literal snippet.
 */
function streamProbe(impl, { parts, mode, paramsJs = "{}" }) {
  return probe(`
async function main() {
  const receipts = [];
  const model = fakeModel(${JSON.stringify(parts)});
  const params = { model, prompt: "PROBE-PROMPT", ...(${paramsJs}) };
  let result;
  let construct = { state: "returned" };
  try {
    result = ${impl === "raw" ? "streamText(params)" : `run.stream({ purpose: "chat", onReceipt: (r) => receipts.push(r) }, params)`};
  } catch (e) {
    construct = { state: "threw", ...describeErr(e) };
  }
  await sleep(40);
  const pre = { receipts: receipts.length, statuses: receipts.map(r => r.status), pulls: model.pulls };
  const consumed = result ? await settle(consume(result, ${JSON.stringify(mode)})) : null;
  await waitFor(() => receipts.length > 0, 1000);
  await sleep(60);
  return { construct, pre, consumed, receipts, unhandled };
}`);
}

function bothImpls(scenario) {
  const raw = streamProbe("raw", scenario);
  const wrapped = streamProbe("wrapped", scenario);
  for (const [label, p] of [["raw", raw], ["wrapped", wrapped]]) {
    assert.ok(p.result, `${label} probe must report a result (status ${p.status}, signal ${p.signal}):\n${p.stderr}`);
    assert.notEqual(p.result.hardTimeout, true, `${label} probe hit its in-child deadline`);
  }
  return { raw: raw.result, wrapped: wrapped.result, wrappedStderr: wrapped.stderr };
}

function assertOneFailedReceipt(wrapped, label) {
  assert.equal(wrapped.receipts.length, 1, `${label}: exactly one receipt, saw ${JSON.stringify(wrapped.receipts)}`);
  const [receipt] = wrapped.receipts;
  assert.equal(receipt.kind, "stream", label);
  assert.equal(receipt.status, "failed", `${label}: ${JSON.stringify(receipt)}`);
  assert.ok(errorCodes().includes(receipt.errorCode), `${label}: errorCode ${receipt.errorCode} not in the closed enum`);
  const serialized = JSON.stringify(receipt);
  for (const needle of ["PROBE-SECRET", "sk-live-000", "internal.example", "PROBE-PROMPT", "ProbeBoom", "CallerFinishError"]) {
    assert.ok(!serialized.includes(needle), `${label}: receipt leaked ${needle}`);
  }
}

function assertSameCallerView(raw, wrapped, label) {
  assert.deepEqual(wrapped.construct, raw.construct, `${label}: construction outcome must match the raw SDK`);
  assert.deepEqual(wrapped.consumed, raw.consumed, `${label}: caller-visible outcome/error identity must match the raw SDK`);
  assert.ok(
    wrapped.unhandled.length <= raw.unhandled.length,
    `${label}: the boundary must not add unhandled rejections (raw ${JSON.stringify(raw.unhandled)}, wrapped ${JSON.stringify(wrapped.unhandled)})`,
  );
}

function assertNotDrainedEagerly(raw, wrapped, label) {
  if (wrapped.construct.state !== "returned") return;
  // The SDK may itself read and fail before the caller consumes. Reporting
  // that real failure is valid; adding reads or claiming success is not.
  assert.ok(wrapped.pre.statuses.every(status => status === "failed"), `${label}: no premature success receipt`);
  assert.ok(wrapped.pre.pulls <= raw.pre.pulls,
    `${label}: no eager draining (raw pulled ${raw.pre.pulls}, wrapped pulled ${wrapped.pre.pulls} before consumption)`);
}

// ---------------------------------------------------------------------------
// 0. Harness control (expected to pass against any correct boundary)
// ---------------------------------------------------------------------------

describe("review harness control", () => {
  it("a normal stream completes identically and reports one completed receipt", () => {
    const parts = [
      { type: "stream-start", warnings: [] }, { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "a" }, { type: "text-delta", id: "t1", delta: "b" },
      { type: "text-end", id: "t1" }, { type: "finish", finishReason: "stop", usage: USAGE },
    ];
    const { raw, wrapped } = bothImpls({ parts, mode: "textStream" });
    assertSameCallerView(raw, wrapped, "control");
    assert.deepEqual(wrapped.consumed, { state: "resolved", value: ["a", "b"] });
    assert.equal(wrapped.receipts.length, 1);
    assert.equal(wrapped.receipts[0].status, "completed");
  });
});

// ---------------------------------------------------------------------------
// 1. Stream errors outside the SDK's onError path
// ---------------------------------------------------------------------------

describe("stream(): synchronous SDK construction errors", () => {
  for (const mode of ["fullStream", "textStream", "text"]) {
    it(`reports maxRetries:-1 once as failed and surfaces the same error as the SDK (${mode})`, () => {
      const parts = [{ type: "stream-start", warnings: [] }, { type: "finish", finishReason: "stop", usage: USAGE }];
      const { raw, wrapped } = bothImpls({ parts, mode, paramsJs: "{ maxRetries: -1 }" });
      assert.ok(raw.construct.state === "threw" || raw.consumed?.state === "rejected",
        "fixture sanity: the installed SDK rejects maxRetries:-1");
      assertSameCallerView(raw, wrapped, `maxRetries:-1 ${mode}`);
      assertOneFailedReceipt(wrapped, `maxRetries:-1 ${mode}`);
    });
  }
});

describe("stream(): the model's ReadableStream errors (controller.error)", () => {
  const parts = [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: "partial" },
    "ERROR",
  ];
  for (const mode of ["fullStream", "textStream", "text"]) {
    it(`reports a reader error once as failed without changing the caller's view (${mode})`, () => {
      const { raw, wrapped, wrappedStderr } = bothImpls({ parts, mode });
      assertSameCallerView(raw, wrapped, `reader error ${mode}`);
      assertNotDrainedEagerly(raw, wrapped, `reader error ${mode}`);
      assertOneFailedReceipt(wrapped, `reader error ${mode}`);
      assert.doesNotMatch(wrappedStderr, /PROBE-SECRET|sk-live-000|internal\.example/, "no raw provider error is logged");
    });
  }

  it("still reports once when the caller supplies its own onError", () => {
    const { raw, wrapped } = bothImpls({ parts, mode: "fullStream", paramsJs: "{ onError: () => {} }" });
    assertSameCallerView(raw, wrapped, "reader error + caller onError");
    assertOneFailedReceipt(wrapped, "reader error + caller onError");
  });
});

// ---------------------------------------------------------------------------
// 2. Error finishes and caller callback failures are not "completed"
// ---------------------------------------------------------------------------

describe("generate(): explicit error finish", () => {
  it("returns the SDK result unchanged but reports finishReason error as failed, once", async () => {
    assert.equal(typeof run.generate, "function", "run.js must export generate()");
    const model = {
      specificationVersion: "v2", provider: "fake", modelId: "probe-model", supportedUrls: {},
      async doGenerate() {
        return { content: [{ type: "text", text: "half" }], finishReason: "error", usage: USAGE, warnings: [] };
      },
      async doStream() { throw new Error("unused"); },
    };
    const receipts = [];
    const result = await run.generate({ purpose: "chat", onReceipt: (r) => receipts.push(r) }, { model, prompt: "p", maxRetries: 0 });
    assert.equal(result.finishReason, "error", "fixture sanity: the SDK surfaces the error finish");
    assert.equal(result.text, "half", "caller-visible result is preserved");
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].status, "failed", `finishReason error must not be completed: ${JSON.stringify(receipts[0])}`);
    assert.ok(errorCodes().includes(receipts[0].errorCode), `errorCode ${receipts[0].errorCode} not in the closed enum`);
  });
});

describe("stream(): explicit error finish and caller callback failures", () => {
  const ok = [
    { type: "stream-start", warnings: [] }, { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: "a" }, { type: "text-end", id: "t1" },
  ];

  it("reports a stream that finishes with finishReason error as failed, once", () => {
    const parts = [...ok, { type: "finish", finishReason: "error", usage: USAGE }];
    const { raw, wrapped } = bothImpls({ parts, mode: "textStream" });
    assertSameCallerView(raw, wrapped, "error finish");
    assertOneFailedReceipt(wrapped, "error finish");
  });

  for (const [label, onFinish] of [
    ["async rejection", "async () => { throw new CallerFinishError(); }"],
    ["delayed rejection", "() => new Promise((_r, j) => setTimeout(() => j(new CallerFinishError()), 20))"],
    ["synchronous throw", "() => { throw new CallerFinishError(); }"],
  ]) {
    it(`reports failed, once, when the caller's onFinish fails (${label}) and preserves the caller view`, () => {
      const parts = [...ok, { type: "finish", finishReason: "stop", usage: USAGE }];
      for (const mode of ["textStream", "text"]) {
        const { raw, wrapped } = bothImpls({ parts, mode, paramsJs: `{ onFinish: ${onFinish} }` });
        assertSameCallerView(raw, wrapped, `onFinish ${label} ${mode}`);
        assertOneFailedReceipt(wrapped, `onFinish ${label} ${mode}`);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// 5. Async receipt observers
// ---------------------------------------------------------------------------

describe("receipt observers are telemetry, never control flow", () => {
  it("an async/rejecting observer cannot crash the process, alter results or be logged", () => {
    const p = probe(`
async function main() {
  const seen = [];
  const asyncObserver = async (r) => { seen.push(r.kind); await null; throw new Error("OBSERVER-SECRET-91"); };
  const rejectingObserver = (r) => { seen.push(r.kind); return Promise.reject(new Error("OBSERVER-SECRET-92")); };

  const g = await run.generate({ purpose: "chat", onReceipt: asyncObserver }, { model: fakeModel([]), prompt: "p", maxRetries: 0 });
  const g2 = await run.generate({ purpose: "chat", onReceipt: rejectingObserver }, { model: fakeModel([]), prompt: "p", maxRetries: 0 });

  const s = run.stream({ purpose: "chat", onReceipt: asyncObserver }, { model: fakeModel(textParts(["a", "b"])), prompt: "p" });
  let st = "";
  for await (const d of s.textStream) st += d;
  await sleep(30);

  const failing = run.stream({ purpose: "chat", onReceipt: rejectingObserver },
    { model: fakeModel([{ type: "stream-start", warnings: [] }, { type: "error", error: boom }]), prompt: "p", onError: () => {} });
  const failed = await settle(consume(failing, "fullStream"));

  const d = await decideMod.decide({ purpose: "evidence_decision", onReceipt: asyncObserver },
    { decide: async () => ({ ok: false, reasonCode: "local_only", receipt: { provider: "jev", status: "failed" } }) },
    { state: "s", questions: {} });

  let img;
  try {
    await run.image({ purpose: "image", onReceipt: rejectingObserver }, "anthropic", "p");
    img = "resolved";
  } catch (e) {
    img = /does not support image generation/.test(e?.message ?? "") ? "original" : "other";
  }
  await sleep(100);
  return { g: g.text, g2: g2.text, st, failed: failed.state, d: d.reasonCode, img, seen };
}`, { trackUnhandled: false });

    assert.equal(p.signal, null, `observer probe was killed (${p.signal})`);
    assert.equal(p.status, 0, `an observer rejection must not crash inference:\n${p.stderr.replace(/OBSERVER-SECRET-\d+/g, "<observer error>")}`);
    assert.ok(p.result && !p.result.hardTimeout, "observer probe must finish within its deadline");
    assert.equal(p.result.g, "g");
    assert.equal(p.result.g2, "g");
    assert.equal(p.result.st, "ab");
    assert.equal(p.result.d, "local_only");
    assert.equal(p.result.img, "original", "the caller still receives the original image error");
    for (const kind of ["generate", "stream", "decision", "image"]) {
      assert.ok(p.result.seen.includes(kind), `the observer is still invoked for ${kind}`);
    }
    assert.doesNotMatch(p.stderr, /OBSERVER-SECRET/, "observer errors are never logged raw");
  });
});
