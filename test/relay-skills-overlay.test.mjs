/**
 * Relay skills overlay — data-only image contract
 *
 * docker/relay/Dockerfile.skills-overlay upgrades sports-skills on top of the
 * exact running relay image without rebuilding the engine. These tests pin:
 *
 *   1. the base is the immutable relay digest and no engine/relay code is copied;
 *   2. a constraints file pins sports-skills exactly, wired via PIP_CONSTRAINT
 *      before any install so the deployed unpinned bootstrap cannot float;
 *   3. both /opt/venv and the managed venv get the exact version, verified by
 *      distribution metadata, module __version__ and `pip check`;
 *   4. the managed venv comes from the real deployed ensureVenv — never a faked
 *      extras marker;
 *   5. schemas are force-regenerated and fail closed on count, version and the
 *      new tools.
 *
 * The Dockerfile is asserted as text (never built here).
 */

import assert from "node:assert/strict";
import { describe, it, before } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const dockerfilePath = join(repoRoot, "docker/relay/Dockerfile.skills-overlay");
const constraintsPath = join(repoRoot, "docker/relay/skills-overlay.constraints.txt");
const pythonSourcePath = join(repoRoot, "src/python.ts");
const schemaSourcePath = join(repoRoot, "src/schema.ts");

const VERSION = "0.36.0";
const BASE_IMAGE =
  "machinasports/sportsclaw-relay@sha256:164eef1c961ac8b61ac3277f289f1c9d24ff1c67977830f154d70a2d0d413abe";
const CONSTRAINTS_IN_IMAGE = "/opt/sportsclaw/skills-overlay.constraints.txt";

let dockerfile;
/** Top-level Dockerfile instructions (continuations joined, comments dropped). */
let instructions;

before(() => {
  dockerfile = readFileSync(dockerfilePath, "utf8");

  // Drop heredoc bodies so only real instructions remain.
  const withoutHeredocs = dockerfile.replace(/<<'EOF'\r?\n[\s\S]*?\r?\nEOF\r?\n/g, "<<'EOF'\n");
  instructions = withoutHeredocs
    .replace(/\\\r?\n\s*/g, " ")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
});

/** Body of the heredoc RUN whose script contains `marker`. */
function heredocContaining(marker) {
  const bodies = [...dockerfile.matchAll(/<<'EOF'\r?\n([\s\S]*?)\r?\nEOF/g)].map((m) => m[1]);
  const matches = bodies.filter((body) => body.includes(marker));
  assert.equal(matches.length, 1, `exactly one build script must contain ${marker}`);
  return matches[0];
}

describe("relay skills overlay", () => {
  it("builds FROM the exact immutable relay digest only", () => {
    const fromLines = instructions.filter((line) => /^FROM\b/i.test(line));
    assert.deepEqual(fromLines, [`FROM ${BASE_IMAGE}`]);
  });

  it("never copies or compiles engine, relay server or entrypoint code", () => {
    const copies = instructions.filter((line) => /^(COPY|ADD)\b/i.test(line));
    assert.deepEqual(copies, [
      `COPY docker/relay/skills-overlay.constraints.txt ${CONSTRAINTS_IN_IMAGE}`,
    ]);
    assert.ok(!/\b(npm|npx|tsc)\b/.test(dockerfile), "no Node build/install may run");
    assert.ok(
      !instructions.some((line) => /^(ENTRYPOINT|CMD|VOLUME|WORKDIR|USER)\b/i.test(line)),
      "runtime wiring must be inherited from the base image"
    );
    const envNames = instructions
      .filter((line) => /^ENV\b/i.test(line))
      .map((line) => line.match(/^ENV\s+(\w+)=/)?.[1]);
    assert.deepEqual(envNames, ["PIP_CONSTRAINT"], "provider/memory/schema env must be inherited");
  });

  it("pins sports-skills exactly in the constraints file", () => {
    const lines = readFileSync(constraintsPath, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));
    assert.deepEqual(lines, [`sports-skills==${VERSION}`]);
  });

  it("sets PIP_CONSTRAINT to the copied constraints before any RUN", () => {
    const envIndex = instructions.indexOf(`ENV PIP_CONSTRAINT=${CONSTRAINTS_IN_IMAGE}`);
    const firstRun = instructions.findIndex((line) => /^RUN\b/.test(line));
    assert.ok(envIndex >= 0, "ENV PIP_CONSTRAINT must point at the copied constraints file");
    assert.ok(firstRun > envIndex, "PIP_CONSTRAINT must be set before any install runs");
  });

  it("upgrades /opt/venv to the exact version without [all] extras and verifies it", () => {
    const run = instructions.find(
      (line) => /^RUN\s+\/opt\/venv\/bin\/python3 -m pip install\b/.test(line)
    );
    assert.ok(run, "a RUN must pip install into /opt/venv");
    assert.ok(run.includes(`"sports-skills==${VERSION}"`), "must install the exact pin");
    assert.ok(!run.includes("[all]"), "/opt/venv must not pull the [all] extras");
    assert.ok(run.includes("/opt/venv/bin/python3 -m pip check"), "must run pip check");
    assert.ok(run.includes("md.version('sports-skills')"), "must check distribution metadata");
    assert.ok(run.includes("sports_skills.__version__"), "must check the module version");
    assert.ok(run.includes(`('${VERSION}', '${VERSION}')`), "must assert both equal the pin");
  });

  it("creates the managed venv through the real deployed ensureVenv", () => {
    const pythonSource = readFileSync(pythonSourcePath, "utf8");
    assert.match(pythonSource, /export function ensureVenv\(basePythonPath\?: string\)/);
    const marker = pythonSource.match(/EXTRAS_MARKER = join\(VENV_DIR, "([^"]+)"\)/)?.[1];
    assert.ok(marker, "src/python.ts must define the extras marker file");

    const script = heredocContaining("ensureVenv(");
    assert.ok(script.includes('import { ensureVenv } from "/app/dist/python.js";'));
    assert.ok(script.includes('ensureVenv("/opt/venv/bin/python3")'));
    assert.match(script, /if \(!venv\.ok\) throw new Error/, "ensureVenv failure must fail the build");
    assert.ok(script.includes("execFileSync(venv.pythonPath"), "must install into the returned path");
    assert.ok(script.includes(`"sports-skills[all]==${VERSION}"`), "must install the exact [all] pin");
    assert.ok(script.includes('"pip", "check"'), "must run pip check");
    assert.ok(script.includes("md.version('sports-skills')") && script.includes("sports_skills.__version__"));
    assert.ok(script.includes(`('${VERSION}', '${VERSION}')`));

    assert.ok(!dockerfile.includes(marker), `the ${marker} marker must never be written by hand`);
    assert.ok(!/writeFileSync|>\s*\S*\.sportsclaw/.test(dockerfile), "no artificial marker writes");
  });

  it("force-regenerates schemas and fails closed on count, version and new tools", () => {
    const schemaSource = readFileSync(schemaSourcePath, "utf8");
    assert.match(schemaSource, /export async function bootstrapDefaultSchemas\(/);
    assert.match(schemaSource, /force\?: boolean/);
    assert.match(schemaSource, /export const DEFAULT_SKILLS\b/);
    assert.match(schemaSource, /export function getSchemaDir\(/);

    const script = heredocContaining("bootstrapDefaultSchemas(");
    assert.ok(script.includes('from "/app/dist/schema.js"'));
    assert.ok(
      script.includes('bootstrapDefaultSchemas({ pythonPath: "/opt/venv/bin/python3" }, { force: true'),
      "bootstrap must be forced against /opt/venv"
    );
    assert.match(script, /if \(count !== DEFAULT_SKILLS\.length\) \{\s*throw/);
    assert.match(script, new RegExp(`schema\\.version !== "${VERSION.replace(/\./g, "\\.")}"\\) throw`));
    assert.match(script, /if \(!schemas\.has\(skill\)\) throw/);
    for (const name of ["get_fantasy_trending", "get_wta_entry_list", "get_wta_player_results"]) {
      assert.ok(script.includes(`"${name}"`), `${name} must be a required tool`);
    }
    assert.match(script, /nfl: \["get_fantasy_trending"\]/);
    assert.match(script, /tennis: \["get_wta_entry_list", "get_wta_player_results"\]/);
  });

  it("never masks a failed build step", () => {
    assert.ok(!/\|\|/.test(dockerfile), "no `||` fallback may swallow a failure");
    assert.ok(!/2>\s*\/dev\/null/.test(dockerfile), "no stderr may be discarded");
    assert.ok(!/catch\s*[({]/.test(dockerfile), "build scripts must not catch and continue");
  });
});
