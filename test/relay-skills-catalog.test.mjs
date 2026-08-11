/**
 * Relay `/api/skills` catalog contract — regression suite for the 0.29.3 canary
 *
 * Production evidence (relay-v0.29.3 canary): the container shipped 20 schema
 * files / 291 tools and `node /app/dist/index.js list --json` returned correct
 * categorized arrays, yet `GET /api/skills` returned `{"skills": []}`. The relay
 * ran `sportsclaw list` in *human* mode and scraped only lines starting with
 * `- `; the human renderer emits categorized, comma-separated prose, so nothing
 * matched and the endpoint reported a successful empty catalog.
 *
 * These tests execute the real parsing behaviour rather than asserting on source
 * text. The parser (`docker/relay/skills_catalog.py`) is stdlib-only, so it runs
 * here without aiohttp; the endpoint itself is exercised by importing
 * `relay_server.py` with a stub `aiohttp` module and a fake `node` binary, which
 * proves the handler really invokes `list --json` and really validates the child
 * return code.
 */

import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const relayDir = join(repoRoot, "docker/relay");
const PYTHON = process.env.PYTHON_PATH || "python3";

// --- Python drivers ---------------------------------------------------------
// Written to a temp dir so nothing test-only ships inside docker/relay.

const PARSE_DRIVER = `
import json, sys

sys.path.insert(0, sys.argv[1])
from skills_catalog import CatalogError, parse_catalog

payload = json.loads(sys.stdin.read())
try:
    skills = parse_catalog(payload["stdout"], payload["returncode"])
    print(json.dumps({"ok": True, "skills": skills}))
except CatalogError as exc:
    # Any other exception type escapes on purpose: the driver exits nonzero and
    # the test fails, which pins CatalogError as the declared failure mode.
    print(json.dumps({"ok": False, "error": str(exc)}))
`;

const ENDPOINT_DRIVER = `
"""Call relay_server.list_skills() with a stubbed aiohttp and a fake node."""
import asyncio, json, sys, types


class _Response:
    def __init__(self, data, status=200):
        self.data = data
        self.status = status


def _json_response(data, status=200):
    return _Response(data, status)


_web = types.SimpleNamespace(
    Request=object,
    Response=_Response,
    StreamResponse=object,
    Application=object,
    json_response=_json_response,
    run_app=None,
)
_aiohttp = types.ModuleType("aiohttp")
_aiohttp.web = _web
sys.modules["aiohttp"] = _aiohttp

sys.path.insert(0, sys.argv[1])
import relay_server

response = asyncio.run(relay_server.list_skills(object()))
print(json.dumps({"status_code": response.status, "body": response.data}))
`;

const FAKE_NODE = `#!/usr/bin/env python3
"""Stands in for \`node\` so the handler's argv, exit code and stderr are ours."""
import os, sys

with open(os.environ["ARGV_LOG"], "w") as handle:
    handle.write("\\n".join(sys.argv[1:]))

stderr_text = os.environ.get("FAKE_STDERR", "")
if stderr_text:
    sys.stderr.write(stderr_text)

with open(os.environ["FAKE_STDOUT_FILE"]) as handle:
    sys.stdout.write(handle.read())

sys.exit(int(os.environ.get("FAKE_EXIT", "0")))
`;

let workDir;
let parseDriver;
let endpointDriver;
let fakeNode;
let argvLog;
let stdoutFile;

before(() => {
  workDir = mkdtempSync(join(tmpdir(), "sportsclaw-relay-skills-"));
  parseDriver = join(workDir, "driver_parse.py");
  endpointDriver = join(workDir, "driver_endpoint.py");
  fakeNode = join(workDir, "fake_node.py");
  argvLog = join(workDir, "argv.log");
  stdoutFile = join(workDir, "stdout.txt");

  writeFileSync(parseDriver, PARSE_DRIVER, "utf-8");
  writeFileSync(endpointDriver, ENDPOINT_DRIVER, "utf-8");
  writeFileSync(fakeNode, FAKE_NODE, "utf-8");
  chmodSync(fakeNode, 0o755);
});

after(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/** Run the stdlib parser over raw CLI output. Returns {ok, skills|error}. */
function parseCatalog(stdout, returncode = 0) {
  const run = spawnSync(PYTHON, [parseDriver, relayDir], {
    input: JSON.stringify({ stdout, returncode }),
    encoding: "utf-8",
  });
  assert.equal(
    run.status,
    0,
    `parser driver must exit cleanly:\n${run.stdout ?? ""}\n${run.stderr ?? ""}`
  );
  return JSON.parse(lastJsonLine(run.stdout));
}

/** Drive the real /api/skills handler against a fake CLI. */
function callSkillsEndpoint({ stdout = "", exitCode = 0, stderr = "" } = {}) {
  writeFileSync(stdoutFile, stdout, "utf-8");
  writeFileSync(argvLog, "", "utf-8");

  const run = spawnSync(PYTHON, [endpointDriver, relayDir], {
    encoding: "utf-8",
    env: {
      ...process.env,
      SPORTSCLAW_BIN: fakeNode,
      SPORTSCLAW_ENTRY: "/app/dist/index.js",
      ARGV_LOG: argvLog,
      FAKE_STDOUT_FILE: stdoutFile,
      FAKE_EXIT: String(exitCode),
      FAKE_STDERR: stderr,
    },
  });
  assert.equal(
    run.status,
    0,
    `endpoint driver must exit cleanly:\n${run.stdout ?? ""}\n${run.stderr ?? ""}`
  );

  return {
    ...JSON.parse(lastJsonLine(run.stdout)),
    argv: readFileSync(argvLog, "utf-8").split("\n").filter(Boolean),
  };
}

function lastJsonLine(text) {
  const lines = (text ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  assert.ok(lines.length > 0, "driver produced no output");
  return lines[lines.length - 1];
}

/** A structurally valid `list --json` payload. */
function catalogPayload(overrides = {}) {
  return JSON.stringify({
    schemaDir: "/app/.sportsclaw/schemas",
    defaultSports: [],
    optionalSports: [],
    defaultSupport: [],
    optionalSupport: [],
    unknown: [],
    totals: { sports: 0, support: 0, schemas: 0, tools: 0 },
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Parser behaviour
// ---------------------------------------------------------------------------

describe("relay skills catalog parser", () => {
  it("flattens the five categories in declared order, first occurrence wins", () => {
    const result = parseCatalog(
      catalogPayload({
        defaultSports: ["nba", "nfl", "nba"],
        optionalSports: ["esports", "nba"],
        defaultSupport: ["kalshi", "news"],
        optionalSupport: ["polymarket-trading", "news"],
        unknown: ["quidditch"],
      })
    );

    assert.equal(result.ok, true, `expected success, got ${result.error}`);
    assert.deepEqual(result.skills, [
      "nba",
      "nfl",
      "esports",
      "kalshi",
      "news",
      "polymarket-trading",
      "quidditch",
    ]);
  });

  it("trims surrounding whitespace on names", () => {
    const result = parseCatalog(catalogPayload({ defaultSports: ["  nba  "] }));

    assert.equal(result.ok, true, `expected success, got ${result.error}`);
    assert.deepEqual(result.skills, ["nba"]);
  });

  it("returns an empty list for a valid but empty catalog", () => {
    const result = parseCatalog(catalogPayload());

    assert.equal(result.ok, true, `expected success, got ${result.error}`);
    assert.deepEqual(result.skills, []);
  });

  it("rejects malformed JSON instead of reporting an empty catalog", () => {
    const result = parseCatalog("Installed schemas (20) — 291 tools\n  Default (14)\n");

    assert.equal(result.ok, false, "human output must not parse as a catalog");
    assert.match(result.error, /json/i);
  });

  it("rejects a JSON payload that is not an object", () => {
    const result = parseCatalog("[1, 2, 3]");

    assert.equal(result.ok, false, "a non-object payload must fail");
  });

  it("rejects a category that is not an array", () => {
    const result = parseCatalog(catalogPayload({ defaultSports: { nba: 4 } }));

    assert.equal(result.ok, false, "an object-valued category must fail");
    assert.match(result.error, /defaultSports/);
  });

  it("rejects a non-string entry inside a category", () => {
    const result = parseCatalog(catalogPayload({ optionalSupport: ["kalshi", 7] }));

    assert.equal(result.ok, false, "a numeric entry must fail");
    assert.match(result.error, /optionalSupport/);
  });

  it("rejects a blank entry inside a category", () => {
    const result = parseCatalog(catalogPayload({ unknown: ["   "] }));

    assert.equal(result.ok, false, "a blank name must fail");
    assert.match(result.error, /unknown/);
  });

  it("rejects a payload missing a category key", () => {
    const partial = JSON.parse(catalogPayload());
    delete partial.defaultSupport;
    const result = parseCatalog(JSON.stringify(partial));

    assert.equal(result.ok, false, "a missing category must fail, not silently vanish");
    assert.match(result.error, /defaultSupport/);
  });

  it("fails on a nonzero return code even when stdout is a valid catalog", () => {
    const result = parseCatalog(catalogPayload({ defaultSports: ["nba"] }), 3);

    assert.equal(result.ok, false, "a failed child must never yield a success payload");
    assert.match(result.error, /3/);
  });
});

// ---------------------------------------------------------------------------
// Endpoint wiring
// ---------------------------------------------------------------------------

describe("relay /api/skills endpoint", () => {
  it("invokes the CLI in structured mode, never human mode", () => {
    const result = callSkillsEndpoint({
      stdout: catalogPayload({ defaultSports: ["nba"] }),
    });

    assert.deepEqual(result.argv, ["/app/dist/index.js", "list", "--json"]);
  });

  it("returns the flat combined catalog on success", () => {
    const result = callSkillsEndpoint({
      stdout: catalogPayload({
        defaultSports: ["nba", "nfl"],
        defaultSupport: ["kalshi"],
        unknown: ["quidditch"],
      }),
    });

    assert.equal(result.status_code, 200);
    assert.deepEqual(result.body, {
      status: true,
      skills: ["nba", "nfl", "kalshi", "quidditch"],
    });
  });

  it("returns HTTP 500 when the CLI exits nonzero, not a false empty success", () => {
    const result = callSkillsEndpoint({
      stdout: "",
      exitCode: 1,
      stderr: "ANTHROPIC_API_KEY=sk-ant-secret leaked into stderr",
    });

    assert.equal(result.status_code, 500);
    assert.equal(result.body.status, false);
    assert.ok(result.body.error, "an error message is part of the contract");
    assert.ok(
      !result.body.error.includes("sk-ant-secret"),
      `child stderr must not be echoed to the client: ${result.body.error}`
    );
  });

  it("returns HTTP 500 when the CLI emits human output instead of JSON", () => {
    const result = callSkillsEndpoint({
      stdout: "Installed schemas (20) — 291 tools\n  Default (14)\n    football, nfl, nba\n",
    });

    assert.equal(result.status_code, 500);
    assert.equal(result.body.status, false);
    assert.ok(!("skills" in result.body), "a parse failure must not report a catalog");
  });

  it("no longer scrapes bullet lines out of human output", () => {
    const source = readFileSync(join(relayDir, "relay_server.py"), "utf-8");
    const listSkills = source.slice(source.indexOf("async def list_skills"));
    const body = listSkills.slice(0, listSkills.indexOf("async def query_stream"));

    assert.ok(!/lstrip\(/.test(body), "the `- ` bullet scraper must be gone");
    assert.ok(!/startswith\("- "\)/.test(body), "the `- ` bullet filter must be gone");
  });
});

// ---------------------------------------------------------------------------
// Engine env-name contract (the /root/.sportsclaw/schemas bug)
// ---------------------------------------------------------------------------

describe("engine schema-dir env name", () => {
  const distEntry = join(repoRoot, "dist/index.js");

  function listJson(env) {
    const run = spawnSync("node", [distEntry, "list", "--json"], {
      encoding: "utf-8",
      env: { ...process.env, ...env },
    });
    assert.equal(run.status, 0, `list --json failed: ${run.stderr}`);
    return JSON.parse(run.stdout);
  }

  it("honours the exact lowercase `sportsclaw_SCHEMA_DIR` spelling", () => {
    const dir = mkdtempSync(join(tmpdir(), "sportsclaw-schemadir-"));
    try {
      const parsed = listJson({
        sportsclaw_SCHEMA_DIR: dir,
        SPORTSCLAW_SCHEMA_DIR: undefined,
      });
      assert.equal(parsed.schemaDir, dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores the uppercase `SPORTSCLAW_SCHEMA_DIR` spelling", () => {
    const dir = mkdtempSync(join(tmpdir(), "sportsclaw-schemadir-upper-"));
    try {
      const parsed = listJson({
        SPORTSCLAW_SCHEMA_DIR: dir,
        sportsclaw_SCHEMA_DIR: undefined,
      });
      assert.notEqual(
        parsed.schemaDir,
        dir,
        "if this ever passes, the Dockerfile ENV name must be revisited"
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
