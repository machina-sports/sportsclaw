/**
 * Watch-intent relay — stdin worker + POST /api/watch-intent handler
 *
 *   - `src/watch-intent-relay.ts` (via dist): `runWatchIntent()` with an
 *     injected env and model factory, plus the real compiled worker over stdin.
 *   - `docker/relay/watch_intent_api.py`: the real handler, driven by a Python
 *     driver that stubs `aiohttp` and patches the buffered subprocess call.
 *
 * Off unless SPORTSCLAW_WATCH_INTENT_ENABLED=true. Auth before body. Bounded
 * body, read and process deadlines, shared relay concurrency, no-store, no
 * content/stderr logging, and no request-owned provider/model/endpoint/tools.
 * Every non-auth response is the typed `watch-intent-v1` envelope.
 */

import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

globalThis.AI_SDK_LOG_WARNINGS = false;

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const relayDir = join(repoRoot, "docker/relay");
const distDir = join(repoRoot, "dist");
const WORKER = join(distDir, "watch-intent-relay.js");
const PYTHON = process.env.PYTHON_PATH || "python3";
const C = "watch-intent-v1";
const ENABLED = { SPORTSCLAW_WATCH_INTENT_ENABLED: "true" };

async function load(rel) {
  try {
    return await import(new URL(rel, import.meta.url));
  } catch (err) {
    if (err?.code === "ERR_MODULE_NOT_FOUND") return {};
    throw err;
  }
}

const relay = await load("../dist/watch-intent-relay.js");

function worker() {
  assert.equal(typeof relay.runWatchIntent, "function", "watch-intent-relay.js must export runWatchIntent()");
  assert.equal(relay.WATCH_INTENT_ENABLED_ENV, "SPORTSCLAW_WATCH_INTENT_ENABLED");
  assert.equal(relay.MAX_WATCH_INTENT_BODY_BYTES, 32 * 1024);
  return relay.runWatchIntent;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEXT = "follow the Lakers clutch take — private note acct_5150";

function body(overrides = {}) {
  return {
    contract: C,
    text: TEXT,
    locale: "en",
    eligible: {
      takes: [{ id: "take_lakers_clutch", label: "Lakers clutch moments" }],
      subscriptions: [{ id: "sub_active_1", takeId: "take_lakers_clutch", label: "Lakers clutch moments", state: "active" }],
    },
    ...overrides,
  };
}

function fakeModel(text) {
  const calls = [];
  return {
    calls,
    specificationVersion: "v2",
    provider: "fake",
    modelId: "fake-intent-model",
    supportedUrls: {},
    async doGenerate(options) {
      calls.push(options);
      return { content: [{ type: "text", text }], finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, warnings: [] };
    },
    async doStream() {
      throw new Error("no streaming");
    },
  };
}

function factory(model) {
  const calls = [];
  return {
    calls,
    createModel: (...args) => {
      calls.push(args);
      return model;
    },
  };
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

describe("watch-intent worker gating", () => {
  for (const [label, value] of [["unset", undefined], ["empty", ""], ["1", "1"], ["TRUE", "TRUE"], ["yes", "yes"], ["padded", " true"]]) {
    it(`is disabled when the flag is ${label}, before building a model`, async () => {
      const run = worker();
      const f = factory(fakeModel('{"action":"none","targetId":null}'));
      const env = value === undefined ? {} : { SPORTSCLAW_WATCH_INTENT_ENABLED: value };
      const result = await run(JSON.stringify(body()), { env, createModel: f.createModel });
      assert.deepEqual(result, { contract: C, ok: false, reasonCode: "disabled" });
      assert.equal(f.calls.length, 0);
    });
  }
});

describe("watch-intent worker request handling", () => {
  const bad = {
    "not json": "{nope",
    "array": JSON.stringify([body()]),
    "request-owned model": JSON.stringify(body({ model: "gpt-x" })),
    "request-owned provider": JSON.stringify(body({ provider: "openai" })),
    "request-owned endpoint": JSON.stringify(body({ baseUrl: "https://evil.example" })),
    "request-owned tools": JSON.stringify(body({ tools: ["web"] })),
    "history": JSON.stringify(body({ history: [] })),
    "identity": JSON.stringify(body({ userId: "u_1" })),
    "oversized body": JSON.stringify(body({ text: "x".repeat(33 * 1024) })),
    "empty": "",
  };
  for (const [label, raw] of Object.entries(bad)) {
    it(`refuses ${label} as invalid_request without building a model`, async () => {
      const run = worker();
      const f = factory(fakeModel('{"action":"none","targetId":null}'));
      const result = await run(raw, { env: { ...ENABLED }, createModel: f.createModel });
      assert.deepEqual(result, { contract: C, ok: false, reasonCode: "invalid_request" });
      assert.equal(f.calls.length, 0);
    });
  }

  it("interprets a valid request with the server-selected model", async () => {
    const run = worker();
    const model = fakeModel('{"action":"follow","targetId":"take_lakers_clutch"}');
    const f = factory(model);
    const result = await run(JSON.stringify(body()), { env: { ...ENABLED }, createModel: f.createModel });
    assert.deepEqual(result, { contract: C, ok: true, intent: { action: "follow", targetId: "take_lakers_clutch" } });
    assert.equal(f.calls.length, 1);
    assert.equal(model.calls.length, 1);
    assert.doesNotMatch(JSON.stringify(f.calls[0]), /Lakers|acct_5150/, "model selection never sees request content");
  });

  it("maps a model construction failure to inference_unavailable without its message", async () => {
    const run = worker();
    const result = await run(JSON.stringify(body()), {
      env: { ...ENABLED },
      createModel: () => {
        throw new Error("missing OPENAI_API_KEY sk-live-777");
      },
    });
    assert.deepEqual(result, { contract: C, ok: false, reasonCode: "inference_unavailable" });
  });

  it("refuses an already-aborted caller", async () => {
    const run = worker();
    const f = factory(fakeModel('{"action":"none","targetId":null}'));
    const result = await run(JSON.stringify(body()), { env: { ...ENABLED }, createModel: f.createModel, abortSignal: AbortSignal.abort() });
    assert.deepEqual(result, { contract: C, ok: false, reasonCode: "aborted" });
  });
});

function runWorker(input, env = {}) {
  const childEnv = { ...process.env };
  for (const key of Object.keys(childEnv)) {
    if (/_API_KEY$|^SPORTSCLAW_|^OPENAI_BASE_URL$|^NIM_/.test(key)) delete childEnv[key];
  }
  Object.assign(childEnv, env);
  return spawnSync(process.execPath, [WORKER], { input, encoding: "utf-8", timeout: 60_000, env: childEnv });
}

describe("watch-intent worker process", () => {
  it("is off by default: one typed line, no stderr, no body echo", () => {
    assert.ok(existsSync(WORKER), "dist/watch-intent-relay.js must exist");
    const run = runWorker(JSON.stringify(body()));
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stderr, "");
    const lines = run.stdout.split("\n").filter(Boolean);
    assert.equal(lines.length, 1, run.stdout);
    assert.deepEqual(JSON.parse(lines[0]), { contract: C, ok: false, reasonCode: "disabled" });
    assert.doesNotMatch(run.stdout, /Lakers|acct_5150/);
  });

  it("answers a malformed body with a typed refusal, not a stack trace", () => {
    assert.ok(existsSync(WORKER), "dist/watch-intent-relay.js must exist");
    const run = runWorker("{nope", ENABLED);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stderr, "");
    assert.deepEqual(JSON.parse(run.stdout.trim()), { contract: C, ok: false, reasonCode: "invalid_request" });
  });

  it("keeps engine, MCP, tools, memory, operator and listener modules out of the import graph", () => {
    assert.ok(existsSync(WORKER), "dist/watch-intent-relay.js must exist");
    const seen = new Set();
    const visit = (file) => {
      if (seen.has(file)) return;
      seen.add(file);
      let source;
      try {
        source = readFileSync(file, "utf-8");
      } catch {
        return;
      }
      for (const [, spec] of [...source.matchAll(/\bfrom\s*"([^"]+)"/g), ...source.matchAll(/\bimport\s*\(\s*"([^"]+)"/g)]) {
        if (spec.startsWith(".")) visit(join(dirname(file), spec));
      }
    };
    visit(WORKER);
    const rels = [...seen].map((f) => f.slice(distDir.length + 1));
    assert.ok(rels.includes("watch-intent.js"), "the worker uses the typed interpreter");
    assert.ok(rels.includes("inference/run.js"), "the interpreter uses unified inference");
    for (const rel of rels) {
      assert.doesNotMatch(
        rel,
        /^(engine|mcp|tools|index|operate|operator-daemon|decision-relay)\.js$|memory|listeners?\//,
        `forbidden module in the worker graph: ${rel}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Python handler contract (docker/relay/watch_intent_api.py)
// ---------------------------------------------------------------------------

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
import watch_intent_api as api

C = "watch-intent-v1"
TEXT = ${JSON.stringify(TEXT)}
ELIGIBLE = {"takes": [{"id": "take_lakers_clutch", "label": "Lakers clutch moments"}],
            "subscriptions": [{"id": "sub_active_1", "takeId": "take_lakers_clutch",
                               "label": "Lakers clutch moments", "state": "active"}]}
BODY = {"contract": C, "text": TEXT, "locale": "en", "eligible": ELIGIBLE}
NODE_BIN = "/usr/bin/node"
ENTRY = "/app/dist/index.js"
BUILD_ENV = {"PATH": "/usr/bin", "SPORTSCLAW_WATCH_INTENT_ENABLED": "true"}
OK_RESULT = {"contract": C, "ok": True, "intent": {"action": "follow", "targetId": "take_lakers_clutch"}}
REFUSAL_RESULT = {"contract": C, "ok": False, "reasonCode": "unknown_id"}


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
    def __init__(self, app, chunks=(), content_length=None, hang=False):
        self.app = app
        self.content = _Content(chunks, hang)
        self.content_length = content_length
        self.headers = {}


def raw(body):
    return json.dumps(body).encode()


def denier(_request):
    return _Response({"status": False, "error": "unauthorized"}, 401)


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
        return payload, b"worker stderr: " + TEXT.encode(), returncode

    api.buffered = fake_buffered
    return calls


def handler(auth=allow, max_concurrency=2, timeout=7):
    return api.make_watch_intent_handler(
        auth_error=auth, node_bin=NODE_BIN, entry=ENTRY,
        build_env=lambda: dict(BUILD_ENV), max_concurrency=max_concurrency, timeout=timeout,
    )


def described(response, app=None):
    payload = {"status": response.status, "data": response.data, "headers": response.headers,
               "body": json.dumps(response.data)}
    if app is not None:
        payload["active_queries"] = app.get("active_queries", 0)
    return payload


def out(payload):
    print(json.dumps(payload))


def enable(value="true"):
    os.environ.pop(api.ENABLED_ENV, None)
    if value is not None:
        os.environ[api.ENABLED_ENV] = value


async def scenario_routes():
    app = _Application()
    api.register_watch_intent_routes(app, auth_error=allow, node_bin=NODE_BIN, entry=ENTRY,
                                     build_env=lambda: dict(BUILD_ENV), max_concurrency=1)
    out({"routes": [[m, p] for m, p, _ in app.router.routes], "route": api.WATCH_INTENT_ROUTE,
         "worker_path": api.worker_path(ENTRY), "max_body": api.MAX_WATCH_INTENT_BODY_BYTES,
         "process_timeout": api.WATCH_INTENT_PROCESS_TIMEOUT_SEC, "enabled_env": api.ENABLED_ENV,
         "flags": {label: api.watch_intent_enabled({} if v is None else {api.ENABLED_ENV: v})
                   for label, v in [("unset", None), ("true", "true"), ("one", "1"),
                                    ("upper", "TRUE"), ("padded", " true")]}})


async def scenario_auth_first():
    enable(None)
    calls = recorder()
    app = _Application()
    app["active_queries"] = 5
    request = Req(app, chunks=[b"x" * 100], content_length=api.MAX_WATCH_INTENT_BODY_BYTES * 4)
    response = await handler(auth=denier, max_concurrency=1)(request)
    out({**described(response, app), "reads": request.content.reads, "spawns": len(calls)})


async def scenario_disabled():
    results = {}
    for label, value in [("unset", None), ("one", "1"), ("garbage", "yes")]:
        enable(value)
        calls = recorder()
        app = _Application()
        request = Req(app, chunks=[raw(BODY)])
        response = await handler()(request)
        results[label] = {**described(response, app), "reads": request.content.reads, "spawns": len(calls)}
    out({"results": results})


async def scenario_body():
    enable()
    limit = api.MAX_WATCH_INTENT_BODY_BYTES
    results = {}

    async def check(name, chunks, content_length=None):
        calls = recorder()
        app = _Application()
        request = Req(app, chunks=chunks, content_length=content_length)
        response = await handler()(request)
        results[name] = {**described(response, app), "reads": request.content.reads, "spawns": len(calls)}

    await check("declared-oversize", [b"{}"], content_length=limit + 1)
    await check("streamed-oversize", [b"a" * (limit // 2 + 1)] * 2)
    await check("invalid-json", [b"{nope"])
    await check("non-object", [b"[1, 2]"])
    await check("bad-utf8", [b'{"text": "\\xff\\xfe"}'])
    await check("extra-model", [raw({**BODY, "model": "gpt-x"})])
    await check("extra-provider", [raw({**BODY, "provider": "openai"})])
    await check("extra-tools", [raw({**BODY, "tools": ["web"]})])
    await check("extra-user", [raw({**BODY, "userId": "u_1"})])
    await check("missing-eligible", [raw({k: v for k, v in BODY.items() if k != "eligible"})])
    await check("wrong-contract", [raw({**BODY, "contract": "watch-intent-v2"})])
    out({"results": results})


async def scenario_body_timeout():
    enable()
    calls = recorder()
    app = _Application()
    real_wait_for = asyncio.wait_for

    async def quick_wait_for(awaitable, timeout):
        return await real_wait_for(awaitable, 0.05)

    asyncio.wait_for = quick_wait_for
    try:
        response = await handler()(Req(app, hang=True))
    finally:
        asyncio.wait_for = real_wait_for
    out({**described(response, app), "spawns": len(calls)})


async def scenario_dispatch():
    enable()
    results = {}

    async def check(name, body, stdout=None):
        calls = recorder(stdout=stdout)
        app = _Application()
        response = await handler(timeout=7)(Req(app, chunks=[raw(body)]))
        results[name] = {**described(response, app), "calls": calls}

    await check("ok", BODY)
    await check("reordered", {"eligible": ELIGIBLE, "locale": "en", "text": TEXT, "contract": C})
    await check("typed-refusal", BODY, stdout=(json.dumps(REFUSAL_RESULT) + "\\n").encode())
    # Compact UTF-8, server-owned key order (review v1, bridge item 3).
    expected = json.dumps(BODY, ensure_ascii=False, separators=(",", ":"))
    out({"results": results, "expected_stdin": expected, "worker_path": api.worker_path(ENTRY),
         "node_bin": NODE_BIN, "build_env": BUILD_ENV})


async def scenario_capacity():
    enable()
    calls = recorder()
    app = _Application()
    app["active_queries"] = 2
    response = await handler(max_concurrency=2)(Req(app, chunks=[raw(BODY)]))
    out({**described(response, app), "spawns": len(calls)})


async def scenario_failures():
    enable()
    results = {}

    async def check(name, stdout=None, returncode=0, error=None):
        recorder(stdout=stdout, returncode=returncode, error=error)
        app = _Application()
        response = await handler()(Req(app, chunks=[raw(BODY)]))
        results[name] = described(response, app)

    await check("timeout", error=asyncio.TimeoutError())
    await check("spawn-failed", error=OSError("no such executable"))
    await check("output-too-large", error=ValueError("query output exceeds configured limit"))
    await check("nonzero-exit", returncode=1)
    await check("not-json", stdout=b"worker crashed: " + TEXT.encode())
    await check("missing-contract", stdout=json.dumps({"ok": True, "intent": OK_RESULT["intent"]}).encode())
    await check("unknown-action", stdout=json.dumps({**OK_RESULT, "intent": {"action": "delete", "targetId": None}}).encode())
    await check("extra-key", stdout=json.dumps({**OK_RESULT, "userId": "u_1"}).encode())
    await check("intent-extra-key", stdout=json.dumps({**OK_RESULT, "intent": {**OK_RESULT["intent"], "destination": "c"}}).encode())
    await check("unknown-reason", stdout=json.dumps({"contract": C, "ok": False, "reasonCode": "boom"}).encode())
    await check("raw-error", stdout=json.dumps({"contract": C, "ok": False, "reasonCode": "timeout", "error": "trace"}).encode())
    out({"results": results})


ACCENTED = "ÁÉÍÓÚáéíóúçãõâêô"


def label(i):
    return ("%02d" % i + ACCENTED * 6)[:80]


def unicode_body():
    """20 takes / 50 subscriptions with 80-character accented labels."""
    takes = [{"id": "take_lakers_clutch", "label": label(0)}] + [
        {"id": "take_%02d" % i, "label": label(i)} for i in range(1, 20)]
    subs = [{"id": "sub_%02d" % i, "takeId": takes[i % 20]["id"], "label": label(i),
             "state": "active" if i % 2 else "paused"} for i in range(50)]
    return {"contract": C, "text": "seguir o clássico São Paulo × Grêmio", "locale": "pt",
            "eligible": {"takes": takes, "subscriptions": subs}}


def raw_utf8(body):
    return json.dumps(body, ensure_ascii=False).encode("utf-8")


async def scenario_malformed_locale():
    enable()
    results = {}
    for name, value in [("list", []), ("dict", {}), ("list-en", ["en"]), ("dict-en", {"en": True}),
                        ("null", None), ("number", 1), ("bool", True), ("upper", "EN")]:
        calls = recorder()
        app = _Application()
        try:
            response = await handler()(Req(app, chunks=[raw({**BODY, "locale": value})]))
            results[name] = {**described(response, app), "spawns": len(calls)}
        except Exception as exc:
            results[name] = {"raised": type(exc).__name__, "spawns": len(calls),
                             "active_queries": app.get("active_queries", 0)}
    out({"results": results})


async def scenario_byte_cap():
    enable()
    limit = api.MAX_WATCH_INTENT_BODY_BYTES
    results = {}
    # Valid-size JSON whose re-serialization grows (1e9 -> 1000000000.0).
    pad = ",".join(["1e9"] * 7000)
    expanding = ('{"contract": "%s", "text": "t", "locale": "en", '
                 '"eligible": {"takes": [], "subscriptions": [], "pad": [%s]}}' % (C, pad)).encode()
    calls = recorder()
    app = _Application()
    try:
        response = await handler()(Req(app, chunks=[expanding]))
        results["expanding"] = {**described(response, app), "spawns": len(calls), "raw_bytes": len(expanding)}
    except Exception as exc:
        results["expanding"] = {"raised": type(exc).__name__, "spawns": len(calls), "raw_bytes": len(expanding)}

    body = unicode_body()
    calls = recorder()
    app = _Application()
    response = await handler()(Req(app, chunks=[raw_utf8(body)]))
    results["unicode"] = {**described(response, app), "spawns": len(calls),
                          "stdin": [c["stdin"] for c in calls],
                          "stdin_bytes": [len(c["stdin"].encode("utf-8")) for c in calls],
                          "raw_bytes": len(raw_utf8(body)), "escaped_bytes": len(json.dumps(body).encode())}
    out({"results": results, "limit": limit})


async def scenario_interop():
    """The actual handler and the actual buffered() spawning the compiled worker."""
    enable()
    worker_env = {
        "PATH": os.environ.get("PATH", ""),
        "HOME": os.environ.get("HOME", "/tmp"),
        "SPORTSCLAW_WATCH_INTENT_ENABLED": "true",
        "SPORTSCLAW_WATCH_INTENT_NATIVE_CONFIG": json.dumps(
            {"route": "nim", "model": "synthetic-native-model", "baseUrl": os.environ["WI_BASE_URL"]}),
    }
    results = {}
    for name, payload in [("ascii", raw(BODY)), ("unicode", raw_utf8(unicode_body()))]:
        app = _Application()
        h = api.make_watch_intent_handler(
            auth_error=allow, node_bin=os.environ["WI_NODE_BIN"], entry=os.environ["WI_ENTRY"],
            build_env=lambda: dict(worker_env), max_concurrency=2, timeout=30)
        response = await h(Req(app, chunks=[payload]))
        results[name] = {**described(response, app), "raw_bytes": len(payload)}
    out({"results": results})


SCENARIOS = {name[len("scenario_"):]: fn for name, fn in globals().items() if name.startswith("scenario_")}
asyncio.run(SCENARIOS[sys.argv[2]]())
`;

let workDir;
let driverPath;

function runScenario(scenario) {
  assert.ok(existsSync(join(relayDir, "watch_intent_api.py")), "watch_intent_api.py must implement the bounded interpretation route");
  const run = spawnSync(PYTHON, [driverPath, relayDir, scenario], { encoding: "utf-8", timeout: 120_000, env: { ...process.env } });
  return parseScenario(scenario, run);
}

/** Non-blocking variant, for scenarios that need this process's loopback fixture to answer. */
function runScenarioAsync(scenario, extraEnv) {
  assert.ok(existsSync(join(relayDir, "watch_intent_api.py")), "watch_intent_api.py must implement the bounded interpretation route");
  return new Promise((resolve) => {
    const child = spawn(PYTHON, [driverPath, relayDir, scenario], { env: { ...process.env, ...extraEnv } });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf-8").on("data", (c) => (stdout += c));
    child.stderr.setEncoding("utf-8").on("data", (c) => (stderr += c));
    const timer = setTimeout(() => child.kill("SIGKILL"), 90_000);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ status: -1, stdout, stderr: `${stderr}\n${err.message}` });
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  }).then((run) => parseScenario(scenario, run));
}

function parseScenario(scenario, run) {
  assert.equal(run.status, 0, `scenario ${scenario} driver must exit cleanly:\n${run.stdout ?? ""}\n${run.stderr ?? ""}`);
  assert.ok(!run.stderr.includes(TEXT) && !run.stderr.includes("acct_5150"), "the handler never logs request content");
  const lines = run.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  assert.equal(lines.length, 1, `the handler writes nothing to stdout itself:\n${run.stdout}`);
  return JSON.parse(lines[0]);
}

function assertEnvelope(result, status, reasonCodes, label) {
  assert.equal(result.status, status, `${label}: ${result.body}`);
  assert.equal(result.headers["Cache-Control"], "no-store", label);
  assert.equal(result.data.contract, C, label);
  assert.equal(result.data.ok, false, label);
  assert.deepEqual(Object.keys(result.data).sort(), ["contract", "ok", "reasonCode"], label);
  assert.ok([].concat(reasonCodes).includes(result.data.reasonCode), `${label}: ${result.data.reasonCode}`);
  assert.ok(!result.body.includes("acct_5150"), `${label}: no body echo`);
  assert.ok(!/worker stderr|Traceback|no such executable|trace/.test(result.body), `${label}: no internals`);
}

before(() => {
  workDir = mkdtempSync(join(tmpdir(), "sportsclaw-watch-intent-relay-"));
  driverPath = join(workDir, "driver_watch_intent.py");
  writeFileSync(driverPath, DRIVER, "utf-8");
});

after(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("watch-intent API registration", () => {
  it("registers one POST route, resolves the worker beside the entry and gates on an exact flag", () => {
    const result = runScenario("routes");
    assert.deepEqual(result.routes, [["POST", "/api/watch-intent"]]);
    assert.equal(result.route, "/api/watch-intent");
    assert.equal(result.worker_path, "/app/dist/watch-intent-relay.js");
    assert.equal(result.max_body, 32 * 1024);
    assert.ok(result.process_timeout > 0 && result.process_timeout <= 30);
    assert.equal(result.enabled_env, "SPORTSCLAW_WATCH_INTENT_ENABLED");
    assert.deepEqual(result.flags, { unset: false, true: true, one: false, upper: false, padded: false });
  });
});

describe("watch-intent API authentication and gating", () => {
  it("denies before reading the body, checking the flag or taking a slot", () => {
    const result = runScenario("auth_first");
    assert.equal(result.status, 401);
    assert.equal(result.headers["Cache-Control"], "no-store");
    assert.equal(result.reads, 0);
    assert.equal(result.spawns, 0);
    assert.equal(result.active_queries, 5);
  });

  it("is disabled unless the flag is exactly true", () => {
    const { results } = runScenario("disabled");
    for (const label of ["unset", "one", "garbage"]) {
      assertEnvelope(results[label], 503, "disabled", label);
      assert.equal(results[label].reads, 0, label);
      assert.equal(results[label].spawns, 0, label);
      assert.equal(results[label].active_queries, 0, label);
    }
  });
});

describe("watch-intent API body handling", () => {
  it("refuses oversized bodies without buffering them", () => {
    const { results } = runScenario("body");
    assertEnvelope(results["declared-oversize"], 413, "invalid_request", "declared-oversize");
    assert.equal(results["declared-oversize"].reads, 0);
    assertEnvelope(results["streamed-oversize"], 413, "invalid_request", "streamed-oversize");
    assert.equal(results["streamed-oversize"].spawns, 0);
  });

  it("accepts exactly contract, text, locale and eligible", () => {
    const { results } = runScenario("body");
    for (const name of ["invalid-json", "non-object", "bad-utf8", "extra-model", "extra-provider", "extra-tools",
      "extra-user", "missing-eligible", "wrong-contract"]) {
      assertEnvelope(results[name], 400, "invalid_request", name);
      assert.equal(results[name].spawns, 0, name);
      assert.equal(results[name].active_queries, 0, name);
    }
  });

  it("bounds the body read with a deadline", () => {
    const result = runScenario("body_timeout");
    assertEnvelope(result, 408, "invalid_request", "body_timeout");
    assert.equal(result.spawns, 0);
    assert.equal(result.active_queries, 0);
  });
});

describe("watch-intent API dispatch", () => {
  it("spawns the worker with server env only and a re-serialized exact-key body", () => {
    const { results, expected_stdin, worker_path, node_bin, build_env } = runScenario("dispatch");
    const { calls, status, data, headers } = results.ok;
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].cmd, [node_bin, worker_path]);
    assert.deepEqual(calls[0].env, build_env, "no request-derived environment");
    assert.equal(calls[0].timeout, 7);
    assert.equal(calls[0].stdin, expected_stdin);
    assert.equal(results.reordered.calls[0].stdin, expected_stdin, "key order is server-owned");
    assert.equal(status, 200);
    assert.deepEqual(data, { contract: C, ok: true, intent: { action: "follow", targetId: "take_lakers_clutch" } });
    assert.equal(headers["Cache-Control"], "no-store");
    assert.equal(results.ok.active_queries, 0, "the slot is released");
  });

  it("passes a typed refusal through as a 200 the caller must inspect", () => {
    const { results } = runScenario("dispatch");
    assert.equal(results["typed-refusal"].status, 200);
    assert.deepEqual(results["typed-refusal"].data, { contract: C, ok: false, reasonCode: "unknown_id" });
  });

  it("shares the relay's concurrency guard and refuses at capacity without spawning", () => {
    const result = runScenario("capacity");
    assertEnvelope(result, 429, "inference_unavailable", "capacity");
    assert.equal(result.spawns, 0);
    assert.equal(result.active_queries, 2);
  });

  it("maps every worker failure to a typed envelope and releases the slot", () => {
    const { results } = runScenario("failures");
    assertEnvelope(results.timeout, 504, "timeout", "timeout");
    for (const name of ["spawn-failed", "output-too-large", "nonzero-exit", "not-json", "missing-contract",
      "unknown-action", "extra-key", "intent-extra-key", "unknown-reason", "raw-error"]) {
      assertEnvelope(results[name], 502, ["inference_unavailable", "invalid_response"], name);
    }
    for (const [name, result] of Object.entries(results)) {
      assert.equal(result.active_queries, 0, `${name} must release its slot`);
      assert.ok(!result.body.includes("Lakers clutch"), `${name}: no content leak`);
    }
  });
});

// ---------------------------------------------------------------------------
// Review v1 corrections (engine item 4, bridge item 3)
// ---------------------------------------------------------------------------

describe("watch-intent API malformed locale", () => {
  it("answers non-string locales with a typed invalid_request and zero worker dispatch", () => {
    const { results } = runScenario("malformed_locale");
    for (const [name, result] of Object.entries(results)) {
      assert.equal(result.raised, undefined, `${name}: the authenticated handler raised ${result.raised} instead of refusing`);
      assertEnvelope(result, 400, "invalid_request", `locale ${name}`);
      assert.equal(result.spawns, 0, `${name}: no worker dispatch`);
      assert.equal(result.active_queries, 0, `${name}: no slot taken`);
    }
  });
});

describe("watch-intent API UTF-8 serialization", () => {
  it("forwards a near-capacity accented request as compact UTF-8 within the byte cap", () => {
    const { results, limit } = runScenario("byte_cap");
    const u = results.unicode;
    assert.ok(u.raw_bytes <= limit, `fixture sanity: the caller body (${u.raw_bytes} bytes) is within the cap`);
    assert.ok(u.escaped_bytes > limit, `fixture sanity: ASCII-escaped form (${u.escaped_bytes} bytes) exceeds the cap`);
    assert.equal(u.spawns, 1, `a valid near-capacity body is dispatched: ${u.body}`);
    assert.ok(u.stdin_bytes[0] <= limit, `worker stdin must fit the worker cap: ${u.stdin_bytes[0]} > ${limit}`);
    const stdin = u.stdin[0];
    assert.doesNotMatch(stdin, /\\u[0-9a-fA-F]{4}/, "non-ASCII text is not \\u-escaped");
    const parsed = JSON.parse(stdin);
    assert.deepEqual(Object.keys(parsed), ["contract", "text", "locale", "eligible"], "exact keys, server-owned order");
    assert.equal(stdin, JSON.stringify(parsed), "compact separators, byte-identical to the worker's own serialization");
  });

  it("enforces the cap on the re-serialized body, not only on the raw read", () => {
    const { results, limit } = runScenario("byte_cap");
    const e = results.expanding;
    assert.ok(e.raw_bytes <= limit, `fixture sanity: the raw body (${e.raw_bytes} bytes) passes the read cap`);
    assert.equal(e.raised, undefined, `the handler raised ${e.raised}`);
    assert.ok([400, 413].includes(e.status), `oversized re-serialization must be refused: ${e.status} ${e.body}`);
    assertEnvelope(e, e.status, "invalid_request", "expanding");
    assert.equal(e.spawns, 0, "nothing over the cap reaches the worker");
    assert.equal(e.active_queries, 0);
  });

  it("round-trips a near-capacity accented request through the actual handler and compiled worker", async () => {
    assert.ok(existsSync(WORKER), "dist/watch-intent-relay.js must exist");
    const seen = [];
    const server = http.createServer((req, res) => {
      let raw = "";
      req.setEncoding("utf-8");
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        seen.push({ url: req.url, raw });
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({
          id: "synthetic", object: "chat.completion", created: 1, model: "synthetic-native-model",
          choices: [{ index: 0, message: { role: "assistant", content: '{"action":"follow","targetId":"take_lakers_clutch"}' }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }));
      });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    try {
      const { results } = await runScenarioAsync("interop", {
        WI_NODE_BIN: process.execPath,
        WI_ENTRY: join(distDir, "index.js"),
        WI_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`,
      });
      const expected = { contract: C, ok: true, intent: { action: "follow", targetId: "take_lakers_clutch" } };

      // Control: the plain body crosses Python -> compiled worker -> synthetic model.
      assert.equal(results.ascii.status, 200, results.ascii.body);
      assert.deepEqual(results.ascii.data, expected, "control round trip");

      const u = results.unicode;
      assert.ok(u.raw_bytes <= 32 * 1024, "fixture sanity: the caller body is within the cap");
      assert.equal(u.status, 200, u.body);
      assert.deepEqual(u.data, expected, `the worker must accept what the handler forwards: ${u.body}`);
      assert.equal(seen.length, 2, "both requests reached the synthetic model");
      const label0 = ("00" + "ÁÉÍÓÚáéíóúçãõâêô".repeat(6)).slice(0, 80);
      assert.ok(JSON.stringify(JSON.parse(seen[1].raw)).includes(label0), "accented labels arrive intact at the model");
      assert.equal(u.active_queries, 0, "the slot is released");
    } finally {
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
    }
  });
});
