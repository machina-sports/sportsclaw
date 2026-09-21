/**
 * Decision relay — stdin worker + /api/decide handler contract
 *
 * Two surfaces, both exercised offline:
 *
 *   - `src/decision-relay.ts` (via dist): `runDecision()` with an injected
 *     transport and an injected environment, plus the real compiled worker
 *     driven over a child process's stdin. No credential, no network.
 *   - `docker/relay/decision_api.py`: the real handler functions, driven by a
 *     Python driver that stubs the `aiohttp` module (CI does not install it)
 *     and patches the buffered subprocess call. No aiohttp HTTP server, no
 *     Node child process on the Python side.
 *
 * Everything the caller does not own is asserted to be server configuration:
 * the endpoint, the pinned model, the deadline, the credential and cloud
 * consent. Live provider calls and real aiohttp wiring are out of scope here.
 */

import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import {
  DATA_POLICY_ENV,
  MAX_RELAY_BODY_BYTES,
  RELAY_TIMEOUT_MS,
  runDecision,
} from "../dist/decision-relay.js";
import { DEFAULT_JEV_MODEL, JEV_ENDPOINT } from "../dist/decision-client.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const relayDir = join(repoRoot, "docker/relay");
const distDir = join(repoRoot, "dist");
const WORKER = join(distDir, "decision-relay.js");
const PYTHON = process.env.PYTHON_PATH || "python3";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const STATE = "Synthetic match report: Falcons 2-1 Rovers. This fixture supplies no injury report.";

const LEVELS = [
  "No result mentioned",
  "Possible result mentioned",
  "Final result explicitly supplied",
];

function mixedQuestions() {
  return {
    route: {
      type: "choice",
      instructions: "Choose a supplied action",
      criteria: {
        summarize_result: "Retrieve and summarize the final result",
        analyze_injuries: "Retrieve injury details",
        review: "Escalate to human review",
      },
    },
    result_evidence: {
      type: "score",
      instructions: "Rate how explicitly the final result is supplied",
      criteria: [...LEVELS],
    },
    has_injuries: { type: "noul", instructions: "Does the state report an injury?" },
  };
}

/** Native response-shape fixture; not a live judgment of STATE above. */
function nativeBody(overrides = {}) {
  return {
    model: DEFAULT_JEV_MODEL,
    answers: {
      route: {
        type: "choice",
        choice: "summarize_result",
        confidence: 1,
        probabilities: { summarize_result: 1, analyze_injuries: 0, review: 0 },
      },
      result_evidence: {
        type: "score",
        score: 1.98,
        confidence: 0.97,
        legend: { 0: LEVELS[0], 1: LEVELS[1], 2: LEVELS[2] },
        probabilities: { 0: 0.01, 1: 0, 2: 0.99 },
      },
      has_injuries: { type: "noul", noul: 0.03 },
    },
    usage: { input_tokens: 435, output_tokens: 85 },
    ...overrides,
  };
}

function jsonResponse(body, status = 200, headers = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Response(text, { status, headers: { "content-type": "application/json", ...headers } });
}

/** Transport recorder. `handler(callNumber, url, init)` returns a Response. */
function recorder(handler) {
  const calls = [];
  return {
    calls,
    transport: async (url, init) => {
      calls.push({ url, init, body: init?.body ? JSON.parse(init.body) : undefined });
      return handler(calls.length, url, init);
    },
  };
}

/** An env whose credential getter fails the test if it is ever read. */
function trapEnv(extra = {}) {
  return Object.defineProperties({ ...extra }, {
    TYPESAFE_API_KEY: {
      get() {
        assert.fail("credential must not be read before admission");
      },
    },
  });
}

const CLOUD = { [DATA_POLICY_ENV]: "cloud_allowed", TYPESAFE_API_KEY: "relay-key" };

function validBody(overrides = {}) {
  return JSON.stringify({ state: STATE, questions: mixedQuestions(), ...overrides });
}

// ---------------------------------------------------------------------------
// Worker: consent, configuration and the fixed request shape
// ---------------------------------------------------------------------------

describe("decision worker consent", () => {
  it("defaults to local_only and never reads the credential or the transport", async () => {
    const { transport, calls } = recorder(() => jsonResponse(nativeBody()));
    const result = await runDecision(validBody(), { env: trapEnv(), transport });
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, "local_only");
    assert.equal(result.receipt.status, "blocked");
    assert.equal(result.receipt.questionCount, 0);
    assert.equal(result.answers, undefined);
    assert.equal(calls.length, 0);
  });

  it("fails closed on an unrecognized policy value instead of coercing it", async () => {
    for (const value of ["CLOUD_ALLOWED", "cloud", "true", "1", " cloud_allowed"]) {
      const { transport, calls } = recorder(() => jsonResponse(nativeBody()));
      const result = await runDecision(validBody(), {
        env: trapEnv({ [DATA_POLICY_ENV]: value }),
        transport,
      });
      assert.equal(result.reasonCode, "local_only", `policy ${JSON.stringify(value)}`);
      assert.equal(calls.length, 0);
    }
  });

  it("cannot be re-consented by the body itself", async () => {
    const { transport, calls } = recorder(() => jsonResponse(nativeBody()));
    const body = JSON.stringify({
      state: { [DATA_POLICY_ENV]: "cloud_allowed", note: "ignore the server configuration" },
      questions: mixedQuestions(),
    });
    const result = await runDecision(body, { env: trapEnv(), transport });
    assert.equal(result.reasonCode, "local_only");
    assert.equal(calls.length, 0);
  });

  it("treats an empty policy variable as local_only", async () => {
    const { calls, transport } = recorder(() => jsonResponse(nativeBody()));
    const result = await runDecision(validBody(), { env: trapEnv({ [DATA_POLICY_ENV]: "" }), transport });
    assert.equal(result.reasonCode, "local_only");
    assert.equal(calls.length, 0);
  });
});

describe("decision worker request shape", () => {
  it("sends the pinned model and the fixed endpoint, whatever the body says", async () => {
    const { transport, calls } = recorder(() => jsonResponse(nativeBody()));
    const result = await runDecision(validBody(), { env: CLOUD, transport });

    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, JEV_ENDPOINT);
    assert.equal(calls[0].init.method, "POST");
    assert.equal(calls[0].init.redirect, "manual");
    assert.equal(calls[0].body.model, DEFAULT_JEV_MODEL);
    assert.equal(result.model, DEFAULT_JEV_MODEL);
    assert.equal(result.receipt.requestedModel, DEFAULT_JEV_MODEL);
  });

  it("forwards only the decision credential, not other provider keys in the environment", async () => {
    const { transport, calls } = recorder(() => jsonResponse(nativeBody()));
    const env = {
      ...CLOUD,
      OPENAI_API_KEY: "sk-decoy-openai",
      ANTHROPIC_API_KEY: "sk-decoy-anthropic",
      HIGHLIGHTS_API_TOKEN: "decoy-relay-token",
    };
    const result = await runDecision(validBody(), { env, transport });

    assert.equal(result.ok, true);
    assert.equal(calls[0].init.headers.authorization, "Bearer relay-key");
    const wire = JSON.stringify({ headers: calls[0].init.headers, body: calls[0].body });
    for (const decoy of ["sk-decoy-openai", "sk-decoy-anthropic", "decoy-relay-token"]) {
      assert.doesNotMatch(wire, new RegExp(decoy));
    }
    assert.doesNotMatch(JSON.stringify(result), /relay-key|sk-decoy|decoy-relay-token/);
  });

  it("accepts exactly state and questions", async () => {
    const bodies = {
      "extra envelope field": validBody({ model: "jev-9.9.9" }),
      "credential in the body": validBody({ apiKey: "sk-live-123" }),
      "policy in the body": validBody({ dataPolicy: "cloud_allowed" }),
      "timeout in the body": validBody({ timeoutMs: 60000 }),
      "prototype key beside the pair": `{"__proto__":{"polluted":true},"state":${JSON.stringify(STATE)},"questions":${JSON.stringify(mixedQuestions())}}`,
      "missing questions": JSON.stringify({ state: STATE }),
      "missing state": JSON.stringify({ questions: mixedQuestions() }),
      "empty object": "{}",
      "array": JSON.stringify([{ state: STATE, questions: mixedQuestions() }]),
      "bare string": JSON.stringify("state and questions"),
      "not json": "{nope",
      "empty body": "",
    };
    for (const [label, body] of Object.entries(bodies)) {
      const { transport, calls } = recorder(() => jsonResponse(nativeBody()));
      const result = await runDecision(body, { env: { ...CLOUD }, transport });
      assert.equal(result.ok, false, label);
      assert.equal(result.reasonCode, "invalid_request", label);
      assert.equal(result.receipt.status, "blocked", label);
      assert.equal(result.receipt.requestedModel, DEFAULT_JEV_MODEL, label);
      assert.equal(result.answers, undefined, label);
      assert.equal(calls.length, 0, label);
    }
    assert.equal(Object.prototype.polluted, undefined);
  });

  it("refuses an oversized body before parsing, consent or credential lookup", async () => {
    const body = JSON.stringify({
      state: "x".repeat(MAX_RELAY_BODY_BYTES),
      questions: mixedQuestions(),
    });
    assert.ok(Buffer.byteLength(body, "utf8") > MAX_RELAY_BODY_BYTES);
    const { transport, calls } = recorder(() => jsonResponse(nativeBody()));
    const result = await runDecision(body, { env: trapEnv(), transport });
    assert.equal(result.reasonCode, "request_too_large");
    assert.equal(result.receipt.status, "blocked");
    assert.equal(result.receipt.questionCount, 0);
    assert.deepEqual(result.receipt.kindCounts, { choice: 0, score: 0, noul: 0 });
    assert.equal(calls.length, 0);
  });

  it("bounds the body below the client's own request bound", () => {
    assert.equal(MAX_RELAY_BODY_BYTES, 32 * 1024);
    assert.equal(RELAY_TIMEOUT_MS, 8_000);
  });
});

// ---------------------------------------------------------------------------
// Worker: results
// ---------------------------------------------------------------------------

describe("decision worker results", () => {
  it("returns a typed, real-shaped answer set for mixed questions", async () => {
    const { transport } = recorder(() => jsonResponse(nativeBody()));
    const result = await runDecision(validBody(), { env: CLOUD, transport });

    assert.equal(result.ok, true);
    assert.deepEqual(Object.keys(result.answers), ["route", "result_evidence", "has_injuries"]);

    const route = result.answers.route;
    assert.equal(route.type, "choice");
    assert.equal(route.choice, "summarize_result");
    assert.equal(route.confidence, 1);
    assert.deepEqual({ ...route.probabilities }, {
      summarize_result: 1,
      analyze_injuries: 0,
      review: 0,
    });

    const score = result.answers.result_evidence;
    assert.equal(score.type, "score");
    assert.equal(score.score, 1.98);
    assert.equal(score.confidence, 0.97);
    assert.deepEqual({ ...score.legend }, { 0: LEVELS[0], 1: LEVELS[1], 2: LEVELS[2] });
    assert.deepEqual({ ...score.probabilities }, { 0: 0.01, 1: 0, 2: 0.99 });

    assert.deepEqual({ ...result.answers.has_injuries }, { type: "noul", noul: 0.03 });

    assert.equal(result.receipt.status, "answered");
    assert.equal(result.receipt.questionCount, 3);
    assert.deepEqual(result.receipt.kindCounts, { choice: 1, score: 1, noul: 1 });
    assert.deepEqual(result.receipt.usage, { inputTokens: 435, outputTokens: 85 });
    // The serialized result is what the relay hands back: no state echo.
    assert.doesNotMatch(JSON.stringify(result.receipt), /Falcons|Rovers/);
  });

  it("reports a missing credential without reaching the transport", async () => {
    const { transport, calls } = recorder(() => jsonResponse(nativeBody()));
    const result = await runDecision(validBody(), {
      env: { [DATA_POLICY_ENV]: "cloud_allowed" },
      transport,
    });
    assert.equal(result.reasonCode, "missing_credential");
    assert.equal(result.receipt.status, "blocked");
    assert.equal(result.receipt.questionCount, 3);
    assert.equal(calls.length, 0);
  });

  it("turns provider failures into sanitized reason codes", async () => {
    const cases = [
      ["auth_denied", () => jsonResponse({ error: "denied: key sk-live-provider-secret" }, 401)],
      ["auth_denied", () => jsonResponse({ error: "forbidden" }, 403)],
      ["rate_limited", () => jsonResponse({ error: "slow down" }, 429)],
      ["upstream_error", () => jsonResponse({ error: "internal trace at db.internal" }, 503)],
      ["malformed_response", () => jsonResponse("not json at all")],
      ["malformed_response", () => jsonResponse({ answers: nativeBody().answers })],
      ["model_mismatch", () => jsonResponse(nativeBody({ model: "jev-9.9.9" }))],
      ["network_error", () => Promise.reject(new TypeError("fetch failed"))],
      [
        "redirect_refused",
        () => new Response(null, { status: 302, headers: { location: "https://elsewhere.test" } }),
      ],
    ];
    for (const [reasonCode, handler] of cases) {
      const { transport, calls } = recorder(handler);
      const result = await runDecision(validBody(), { env: CLOUD, transport });
      assert.equal(result.ok, false, reasonCode);
      assert.equal(result.reasonCode, reasonCode);
      assert.equal(result.receipt.status, "failed");
      assert.equal(result.answers, undefined);
      assert.equal(calls.length, 1, "the worker never retries");
      const serialized = JSON.stringify(result);
      for (const secret of ["sk-live-provider-secret", "db.internal", "relay-key", "elsewhere.test"]) {
        assert.doesNotMatch(serialized, new RegExp(secret.replace(/\./g, "\\.")));
      }
    }
  });

  it("refuses a malformed answer rather than returning a partial set", async () => {
    const body = nativeBody();
    body.answers.has_injuries.noul = 1.4;
    const { transport } = recorder(() => jsonResponse(body));
    const result = await runDecision(validBody(), { env: CLOUD, transport });
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, "noul_invalid");
    assert.equal(result.answers, undefined);
  });
});

// ---------------------------------------------------------------------------
// Worker: cancellation
// ---------------------------------------------------------------------------

describe("decision worker cancellation", () => {
  it("does not start a decision for an already-aborted caller", async () => {
    const { transport, calls } = recorder(() => jsonResponse(nativeBody()));
    const result = await runDecision(validBody(), {
      env: trapEnv({ [DATA_POLICY_ENV]: "cloud_allowed" }),
      transport,
      abortSignal: AbortSignal.abort(),
    });
    assert.equal(result.reasonCode, "aborted");
    assert.equal(result.receipt.status, "blocked");
    assert.equal(result.receipt.questionCount, 0);
    assert.equal(calls.length, 0);
  });

  it("reports an abort raised during the request", async () => {
    const controller = new AbortController();
    const { transport, calls } = recorder(
      (_n, _url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(new Error("aborted")));
          controller.abort();
        })
    );
    const result = await runDecision(validBody(), {
      env: CLOUD,
      transport,
      abortSignal: controller.signal,
    });
    assert.equal(result.reasonCode, "aborted");
    assert.equal(result.answers, undefined);
    assert.equal(calls.length, 1);
  });

  it("discards a successful response that lands after the caller aborted", async () => {
    const controller = new AbortController();
    const { transport, calls } = recorder(() => {
      // The transport ignores the abort and answers anyway; the worker must
      // not hand answers to a caller that already walked away.
      controller.abort();
      return jsonResponse(nativeBody());
    });
    const result = await runDecision(validBody(), {
      env: CLOUD,
      transport,
      abortSignal: controller.signal,
    });
    assert.equal(calls.length, 1);
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, "aborted");
    assert.equal(result.answers, undefined);
    assert.equal(result.receipt.status, "blocked");
  });
});

// ---------------------------------------------------------------------------
// Worker: the compiled process itself
// ---------------------------------------------------------------------------

/** Run the real compiled worker over stdin with a controlled environment. */
function runWorker(input, env = {}) {
  const childEnv = { ...process.env, ...env };
  delete childEnv.TYPESAFE_API_KEY;
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete childEnv[key];
  }
  const run = spawnSync(process.execPath, [WORKER], {
    input,
    encoding: "utf-8",
    timeout: 60_000,
    env: childEnv,
  });
  return run;
}

describe("decision worker process", () => {
  it("writes exactly one typed line on stdout and nothing on stderr", () => {
    const run = runWorker(validBody(), { [DATA_POLICY_ENV]: "cloud_allowed" });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stderr, "");
    const lines = run.stdout.split("\n").filter((line) => line.length > 0);
    assert.equal(lines.length, 1, run.stdout);

    const result = JSON.parse(lines[0]);
    // No credential is present, so this stops before any network attempt.
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, "missing_credential");
    assert.equal(result.receipt.provider, "jev");
    assert.equal(result.receipt.requestedModel, DEFAULT_JEV_MODEL);
  });

  it("refuses without cloud consent and never echoes the body or an environment secret", () => {
    const run = runWorker(validBody(), {
      [DATA_POLICY_ENV]: undefined,
      OPENAI_API_KEY: "sk-decoy-openai",
      ANTHROPIC_API_KEY: "sk-decoy-anthropic",
    });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stderr, "");
    const result = JSON.parse(run.stdout.trim());
    assert.equal(result.reasonCode, "local_only");
    assert.doesNotMatch(run.stdout, /Falcons|Rovers|summarize_result|sk-decoy/);
  });

  it("refuses an oversized stdin body without buffering it", () => {
    // Just over the bound: the whole body still fits in the pipe buffer, so
    // the refusal is attributable to the cap rather than to a short write.
    const body = JSON.stringify({ state: "x".repeat(MAX_RELAY_BODY_BYTES), questions: mixedQuestions() });
    const run = runWorker(body, { [DATA_POLICY_ENV]: "cloud_allowed" });
    assert.equal(run.status, 0, run.stderr);
    const result = JSON.parse(run.stdout.trim());
    assert.equal(result.reasonCode, "request_too_large");
    assert.ok(run.stdout.length < 1_000, "an oversized body must not be echoed");
  });

  it("answers a malformed body with a typed refusal rather than a stack trace", () => {
    const run = runWorker("{nope", { [DATA_POLICY_ENV]: "cloud_allowed" });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stderr, "");
    assert.equal(JSON.parse(run.stdout.trim()).reasonCode, "invalid_request");
    assert.doesNotMatch(run.stdout, /Traceback|at Object|SyntaxError/);
  });

  it("imports the decision client and node builtins and nothing else", () => {
    const seen = new Set();
    const external = new Set();
    const visit = (file) => {
      if (seen.has(file)) return;
      seen.add(file);
      const source = readFileSync(file, "utf-8");
      const specifiers = [...source.matchAll(/\bfrom\s*"([^"]+)"/g), ...source.matchAll(/\bimport\s*\(\s*"([^"]+)"/g)];
      for (const [, specifier] of specifiers) {
        if (specifier.startsWith(".")) {
          visit(join(dirname(file), specifier));
        } else if (!specifier.startsWith("node:")) {
          external.add(specifier);
        }
      }
    };
    visit(WORKER);

    assert.deepEqual([...external], [], "the worker must not pull in a package dependency");
    assert.deepEqual(
      [...seen].map((file) => file.slice(distDir.length + 1)).sort(),
      ["decision-client.js", "decision-relay.js"],
      "no engine, CLI, MCP, memory or listener module may enter the import graph"
    );
  });
});

// ---------------------------------------------------------------------------
// Python handler contract (docker/relay/decision_api.py)
// ---------------------------------------------------------------------------

// The driver stubs `aiohttp` in sys.modules — CI does not install it — and
// patches `decision_api.buffered`, so no Node child process is ever spawned
// from Python here. Everything else is the real handler.
const DRIVER = `
import asyncio, json, os, sys, types


class _Response:
    def __init__(self, data, status=200, headers=None):
        self.data = data
        self.status = status
        self.headers = dict(headers or {})


class _Router:
    def __init__(self):
        self.routes = []

    def add_get(self, path, handler):
        self.routes.append(("GET", path, handler))

    def add_post(self, path, handler):
        self.routes.append(("POST", path, handler))


class _Application(dict):
    def __init__(self):
        super().__init__()
        self.router = _Router()


_web = types.SimpleNamespace(
    Request=object,
    Response=_Response,
    Application=_Application,
    json_response=lambda data, status=200, headers=None: _Response(data, status, headers),
)
_aiohttp = types.ModuleType("aiohttp")
_aiohttp.web = _web
sys.modules["aiohttp"] = _aiohttp

sys.path.insert(0, sys.argv[1])
import decision_api


STATE = "Synthetic match report: Falcons 2-1 Rovers. This fixture supplies no injury report."
QUESTIONS = {"has_injuries": {"type": "noul", "instructions": "Does the state report an injury?"}}
BODY = {"state": STATE, "questions": QUESTIONS}
NODE_BIN = "/usr/bin/node"
ENTRY = "/app/dist/index.js"
BUILD_ENV = {"PATH": "/usr/bin", "SPORTSCLAW_DECISION_DATA_POLICY": "cloud_allowed"}

OK_RESULT = {
    "ok": True,
    "model": "jev-1.13.0",
    "answers": {"has_injuries": {"type": "noul", "noul": 0.03}},
    "receipt": {"provider": "jev", "status": "answered", "reasonCode": "answered",
                "requestedModel": "jev-1.13.0", "model": "jev-1.13.0", "latencyMs": 12,
                "questionCount": 1, "kindCounts": {"choice": 0, "score": 0, "noul": 1}},
}
REFUSAL_RESULT = {
    "ok": False,
    "reasonCode": "rate_limited",
    "receipt": {"provider": "jev", "status": "failed", "reasonCode": "rate_limited",
                "requestedModel": "jev-1.13.0", "latencyMs": 9,
                "questionCount": 1, "kindCounts": {"choice": 0, "score": 0, "noul": 1}},
}


class _Content:
    def __init__(self, chunks, hang=False):
        self._chunks = list(chunks)
        self.reads = 0
        self.hang = hang

    async def readany(self):
        self.reads += 1
        if self.hang:
            await asyncio.sleep(3600)
        return self._chunks.pop(0) if self._chunks else b""


class Req:
    def __init__(self, app, chunks=(), content_length=None, hang=False, headers=None):
        self.app = app
        self.content = _Content(chunks, hang)
        self.content_length = content_length
        self.headers = headers or {}


def raw(body):
    return json.dumps(body).encode()


def denier(status=401):
    def auth_error(_request):
        return _Response({"status": False, "error": "unauthorized"}, status)
    return auth_error


def allow(_request):
    return None


def recorder(stdout=None, returncode=0, error=None):
    calls = []

    async def fake_buffered(cmd, env, timeout, stdin=None):
        calls.append({"cmd": list(cmd), "env": dict(env), "timeout": timeout,
                      "stdin": None if stdin is None else stdin.decode()})
        if error is not None:
            raise error
        payload = stdout if stdout is not None else (json.dumps(OK_RESULT) + "\\n").encode()
        return payload, b"worker stderr: " + STATE.encode(), returncode

    decision_api.buffered = fake_buffered
    return calls


def handler(auth=allow, max_concurrency=2, timeout=7):
    return decision_api.make_decision_handler(
        auth_error=auth, node_bin=NODE_BIN, entry=ENTRY,
        build_env=lambda: dict(BUILD_ENV), max_concurrency=max_concurrency,
        timeout=timeout,
    )


def out(payload):
    print(json.dumps(payload))


def described(response, app=None):
    payload = {
        "status": response.status,
        "data": response.data,
        "headers": response.headers,
        "body": json.dumps(response.data),
    }
    if app is not None:
        payload["active_queries"] = app.get("active_queries", 0)
    return payload


async def scenario_routes():
    app = _Application()
    decision_api.register_decision_routes(
        app, auth_error=allow, node_bin=NODE_BIN, entry=ENTRY,
        build_env=lambda: dict(BUILD_ENV), max_concurrency=1,
    )
    out({
        "routes": [[m, p] for m, p, _ in app.router.routes],
        "route": decision_api.DECISION_ROUTE,
        "worker_path": decision_api.worker_path(ENTRY),
        "max_body": decision_api.MAX_DECISION_BODY_BYTES,
        "process_timeout": decision_api.DECISION_PROCESS_TIMEOUT_SEC,
        "policy_env": decision_api.DATA_POLICY_ENV,
    })


async def scenario_policy():
    results = {}
    for label, value in [("unset", None), ("empty", ""), ("cloud", "cloud_allowed"),
                         ("local", "local_only"), ("upper", "CLOUD_ALLOWED"),
                         ("padded", " cloud_allowed"), ("truthy", "true")]:
        env = {} if value is None else {decision_api.DATA_POLICY_ENV: value}
        results[label] = {
            "policy": decision_api.data_policy(env),
            "enabled": decision_api.decision_enabled(env),
        }
    out({"results": results})


async def scenario_auth_first():
    # Auth is checked before policy, before the body is read and before
    # capacity: a denied caller learns nothing about any of them.
    os.environ.pop(decision_api.DATA_POLICY_ENV, None)
    calls = recorder()
    app = _Application()
    app["active_queries"] = 5
    decide = handler(auth=denier(), max_concurrency=1)
    request = Req(app, chunks=[b"x" * 100], content_length=decision_api.MAX_DECISION_BODY_BYTES * 4)
    response = await decide(request)
    out({**described(response, app), "reads": request.content.reads, "spawns": len(calls)})


async def scenario_disabled():
    results = {}
    for label, value in [("unset", None), ("local_only", "local_only"), ("garbage", "yes")]:
        os.environ.pop(decision_api.DATA_POLICY_ENV, None)
        if value is not None:
            os.environ[decision_api.DATA_POLICY_ENV] = value
        calls = recorder()
        app = _Application()
        decide = handler()
        request = Req(app, chunks=[raw(BODY)])
        response = await decide(request)
        results[label] = {**described(response, app), "reads": request.content.reads,
                          "spawns": len(calls)}
    out({"results": results})


async def scenario_body():
    os.environ[decision_api.DATA_POLICY_ENV] = "cloud_allowed"
    limit = decision_api.MAX_DECISION_BODY_BYTES
    results = {}

    async def check(name, chunks, content_length=None):
        calls = recorder()
        app = _Application()
        decide = handler()
        request = Req(app, chunks=chunks, content_length=content_length)
        response = await decide(request)
        results[name] = {**described(response, app), "reads": request.content.reads,
                         "spawns": len(calls)}

    await check("declared-oversize", [b"{}"], content_length=limit + 1)
    await check("streamed-oversize", [b"a" * (limit // 2 + 1)] * 2)
    await check("at-limit-but-invalid", [b"a" * limit])
    await check("invalid-json", [b"{nope"])
    await check("non-object", [b"[1, 2, 3]"])
    await check("bad-utf8", [b'{"state": "\\xff\\xfe"}'])
    await check("extra-key", [raw({"state": STATE, "questions": QUESTIONS, "model": "jev-9.9.9"})])
    await check("credential-key", [raw({"state": STATE, "questions": QUESTIONS, "apiKey": "sk-live-1"})])
    await check("missing-questions", [raw({"state": STATE})])
    await check("missing-state", [raw({"questions": QUESTIONS})])
    await check("empty-object", [b"{}"])
    out({"results": results, "state": STATE})


async def scenario_body_timeout():
    # The handler bounds the body read at 5s; shorten that bound so the test
    # proves the bound exists without waiting for it.
    os.environ[decision_api.DATA_POLICY_ENV] = "cloud_allowed"
    calls = recorder()
    app = _Application()
    decide = handler()
    real_wait_for = asyncio.wait_for

    async def quick_wait_for(awaitable, timeout):
        return await real_wait_for(awaitable, 0.05)

    asyncio.wait_for = quick_wait_for
    try:
        response = await decide(Req(app, hang=True))
    finally:
        asyncio.wait_for = real_wait_for
    out({**described(response, app), "spawns": len(calls)})


async def scenario_dispatch():
    os.environ[decision_api.DATA_POLICY_ENV] = "cloud_allowed"
    results = {}

    async def check(name, body, stdout=None):
        calls = recorder(stdout=stdout)
        app = _Application()
        decide = handler(timeout=7)
        response = await decide(Req(app, chunks=[raw(body)]))
        results[name] = {**described(response, app), "calls": calls}

    await check("answered", BODY)
    # Key order in the caller's JSON must not change what the worker receives.
    await check("reordered", {"questions": QUESTIONS, "state": STATE})
    await check("structured-state", {"state": {"fixture": {"home": "Falcons"}}, "questions": QUESTIONS})
    await check("typed-refusal", BODY, stdout=(json.dumps(REFUSAL_RESULT) + "\\n").encode())
    out({"results": results,
         "expected_stdin": json.dumps({"state": STATE, "questions": QUESTIONS}),
         "expected_structured_stdin": json.dumps(
             {"state": {"fixture": {"home": "Falcons"}}, "questions": QUESTIONS}),
         "worker_path": decision_api.worker_path(ENTRY),
         "node_bin": NODE_BIN,
         "build_env": BUILD_ENV})


async def scenario_capacity():
    os.environ[decision_api.DATA_POLICY_ENV] = "cloud_allowed"
    calls = recorder()
    app = _Application()
    app["active_queries"] = 2
    decide = handler(max_concurrency=2)
    response = await decide(Req(app, chunks=[raw(BODY)]))
    refused = {**described(response, app), "spawns": len(calls)}

    # A slot released by a finished decision is available to the next caller.
    app["active_queries"] = 1
    after = await decide(Req(app, chunks=[raw(BODY)]))
    out({"refused": refused, "accepted": described(after, app),
         "spawns": len(calls), "active_after": app.get("active_queries")})


async def scenario_failures():
    os.environ[decision_api.DATA_POLICY_ENV] = "cloud_allowed"
    results = {}

    async def check(name, stdout=None, returncode=0, error=None):
        recorder(stdout=stdout, returncode=returncode, error=error)
        app = _Application()
        app["active_queries"] = 0
        decide = handler()
        response = await decide(Req(app, chunks=[raw(BODY)]))
        results[name] = described(response, app)

    await check("timeout", error=asyncio.TimeoutError())
    await check("spawn-failed", error=OSError("no such executable"))
    await check("output-too-large", error=ValueError("query output exceeds configured limit"))
    await check("nonzero-exit", returncode=1)
    await check("crashed-empty", stdout=b"", returncode=1)
    await check("not-json", stdout=b"worker crashed: " + STATE.encode())
    await check("not-an-object", stdout=b"[1, 2, 3]")
    await check("untyped-ok", stdout=json.dumps({"ok": "yes", "receipt": {}}).encode())
    await check("no-receipt", stdout=json.dumps({"ok": True, "model": "jev-1.13.0",
                                                 "answers": {}}).encode())
    await check("ok-without-answers", stdout=json.dumps(
        {"ok": True, "model": "jev-1.13.0", "receipt": {}}).encode())
    await check("ok-without-model", stdout=json.dumps(
        {"ok": True, "answers": {}, "receipt": {}}).encode())
    await check("refusal-without-reason", stdout=json.dumps(
        {"ok": False, "receipt": {}}).encode())
    await check("bad-utf8-output", stdout=b"\\xff\\xfe")
    out({"results": results, "state": STATE})


SCENARIOS = {
    "routes": scenario_routes,
    "policy": scenario_policy,
    "auth_first": scenario_auth_first,
    "disabled": scenario_disabled,
    "body": scenario_body,
    "body_timeout": scenario_body_timeout,
    "dispatch": scenario_dispatch,
    "capacity": scenario_capacity,
    "failures": scenario_failures,
}

asyncio.run(SCENARIOS[sys.argv[2]]())
`;

let workDir;
let driverPath;

function runScenario(scenario) {
  const run = spawnSync(PYTHON, [driverPath, relayDir, scenario], {
    encoding: "utf-8",
    timeout: 120_000,
    env: { ...process.env },
  });
  assert.equal(
    run.status,
    0,
    `scenario ${scenario} driver must exit cleanly:\n${run.stdout ?? ""}\n${run.stderr ?? ""}`
  );
  const lines = run.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}

before(() => {
  workDir = mkdtempSync(join(tmpdir(), "sportsclaw-decision-relay-"));
  driverPath = join(workDir, "driver_decision.py");
  writeFileSync(driverPath, DRIVER, "utf-8");
});

after(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("decision API registration and configuration", () => {
  it("registers exactly one POST route and resolves the worker beside the engine entry", () => {
    const result = runScenario("routes");
    assert.deepEqual(result.routes, [["POST", "/api/decide"]]);
    assert.equal(result.route, "/api/decide");
    assert.equal(result.worker_path, "/app/dist/decision-relay.js");
    // Mirrors MAX_RELAY_BODY_BYTES; the process bound outlives the worker's own.
    assert.equal(result.max_body, MAX_RELAY_BODY_BYTES);
    assert.ok(result.process_timeout * 1000 > RELAY_TIMEOUT_MS);
    assert.equal(result.policy_env, DATA_POLICY_ENV);
  });

  it("only treats an exact cloud_allowed as consent", () => {
    const { results } = runScenario("policy");
    assert.deepEqual(results.cloud, { policy: "cloud_allowed", enabled: true });
    for (const label of ["unset", "empty", "local", "upper", "padded", "truthy"]) {
      assert.deepEqual(results[label], { policy: "local_only", enabled: false }, label);
    }
  });
});

describe("decision API authentication and data policy", () => {
  it("denies before reading the body, checking the policy or taking a slot", () => {
    const result = runScenario("auth_first");
    assert.equal(result.status, 401);
    assert.equal(result.headers["Cache-Control"], "no-store");
    assert.equal(result.reads, 0, "a denied request body is never read");
    assert.equal(result.spawns, 0);
    assert.equal(result.active_queries, 5, "a denied request takes no capacity");
  });

  it("stays disabled until cloud egress is opted into", () => {
    const { results } = runScenario("disabled");
    for (const label of ["unset", "local_only", "garbage"]) {
      const result = results[label];
      assert.equal(result.status, 503, label);
      assert.match(result.data.error, /data policy/i, label);
      assert.equal(result.data.status, false, label);
      assert.equal(result.headers["Cache-Control"], "no-store", label);
      assert.equal(result.spawns, 0, label);
      assert.equal(result.active_queries, 0, label);
    }
  });
});

describe("decision API body handling", () => {
  it("refuses an oversized body and never buffers it", () => {
    const { results } = runScenario("body");
    assert.equal(results["declared-oversize"].status, 413);
    assert.match(results["declared-oversize"].data.error, /exceeds 32768 bytes/);
    assert.equal(results["declared-oversize"].reads, 0, "a declared oversize is refused unread");
    assert.equal(results["streamed-oversize"].status, 413);
    for (const name of ["declared-oversize", "streamed-oversize"]) {
      assert.equal(results[name].spawns, 0, name);
      assert.equal(results[name].headers["Cache-Control"], "no-store", name);
    }
  });

  it("accepts a JSON object carrying exactly state and questions", () => {
    const { results, state } = runScenario("body");
    const rejected = [
      "at-limit-but-invalid",
      "invalid-json",
      "non-object",
      "bad-utf8",
      "extra-key",
      "credential-key",
      "missing-questions",
      "missing-state",
      "empty-object",
    ];
    for (const name of rejected) {
      const result = results[name];
      assert.equal(result.status, 400, `${name}: ${result.body}`);
      assert.equal(result.data.status, false, name);
      assert.equal(result.spawns, 0, name);
      assert.equal(result.active_queries, 0, name);
      assert.ok(!/Traceback/.test(result.data.error), `no stack traces: ${name}`);
      assert.ok(!result.body.includes(state), `no body echo: ${name}`);
      assert.ok(!result.body.includes("sk-live-1"), `no credential echo: ${name}`);
    }
    for (const name of ["extra-key", "credential-key", "missing-questions", "missing-state"]) {
      assert.match(results[name].data.error, /exactly state and questions/, name);
    }
  });

  it("bounds the body read with a deadline", () => {
    const result = runScenario("body_timeout");
    assert.equal(result.status, 408);
    assert.match(result.data.error, /timed out/);
    assert.equal(result.headers["Cache-Control"], "no-store");
    assert.equal(result.spawns, 0);
    assert.equal(result.active_queries, 0);
  });
});

describe("decision API dispatch", () => {
  it("spawns the worker with server configuration and a re-serialized body", () => {
    const { results, expected_stdin, worker_path, node_bin, build_env } = runScenario("dispatch");
    const { calls, status, data, headers } = results.answered;

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].cmd, [node_bin, worker_path]);
    assert.deepEqual(calls[0].env, build_env);
    assert.equal(calls[0].timeout, 7);
    assert.equal(calls[0].stdin, expected_stdin);

    assert.equal(status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.model, "jev-1.13.0");
    assert.deepEqual(data.answers, { has_injuries: { type: "noul", noul: 0.03 } });
    assert.equal(headers["Cache-Control"], "no-store");
    assert.equal(results.answered.active_queries, 0, "the slot is released");
  });

  it("re-serializes from the two recognized fields, whatever the caller's key order", () => {
    const { results, expected_stdin, expected_structured_stdin } = runScenario("dispatch");
    assert.equal(results.reordered.calls[0].stdin, expected_stdin);
    assert.equal(results["structured-state"].calls[0].stdin, expected_structured_stdin);
    assert.match(expected_structured_stdin, /^\{"state": \{"fixture"/);
  });

  it("passes a typed refusal through as a 200 the caller must inspect", () => {
    const { results } = runScenario("dispatch");
    const refusal = results["typed-refusal"];
    assert.equal(refusal.status, 200, "a typed refusal is a successful transaction");
    assert.equal(refusal.data.ok, false);
    assert.equal(refusal.data.reasonCode, "rate_limited");
    assert.equal(refusal.data.answers, undefined);
    assert.equal(refusal.active_queries, 0);
  });

  it("refuses at capacity without spawning a worker", () => {
    const result = runScenario("capacity");
    assert.equal(result.refused.status, 429);
    assert.match(result.refused.data.error, /capacity/i);
    assert.equal(result.refused.headers["Cache-Control"], "no-store");
    assert.equal(result.refused.spawns, 0, "a refused request never reaches the worker");
    assert.equal(result.refused.active_queries, 2, "a refusal leaves the counter untouched");
    assert.equal(result.spawns, 1, "only the admitted request reaches the worker");
    assert.equal(result.accepted.status, 200);
    assert.equal(result.active_after, 1, "the admitted request releases its slot");
  });
});

describe("decision API worker failures", () => {
  it("maps every worker failure to a sanitized status and releases the slot", () => {
    const { results, state } = runScenario("failures");
    const expected = {
      timeout: 504,
      "spawn-failed": 502,
      "output-too-large": 502,
      "nonzero-exit": 502,
      "crashed-empty": 502,
      "not-json": 502,
      "not-an-object": 502,
      "untyped-ok": 502,
      "no-receipt": 502,
      "ok-without-answers": 502,
      "ok-without-model": 502,
      "refusal-without-reason": 502,
      "bad-utf8-output": 502,
    };
    for (const [name, status] of Object.entries(expected)) {
      const result = results[name];
      assert.equal(result.status, status, `${name}: ${result.body}`);
      assert.equal(result.data.status, false, name);
      assert.equal(result.headers["Cache-Control"], "no-store", name);
      assert.equal(result.active_queries, 0, `${name} must release its slot`);
      // Neither the caller's state nor the worker's stderr is a public protocol.
      assert.ok(!result.body.includes(state), `no state leak: ${name}`);
      assert.ok(!/worker stderr|Traceback|no such executable/.test(result.body), `no internals: ${name}`);
      assert.match(result.data.error, /decision (failed|timed out)/, name);
    }
  });
});
