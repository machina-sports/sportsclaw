/**
 * Relay container contract — reproducible-image test suite
 *
 * The relay image must be byte-reproducible with respect to its sports data
 * backend: an unpinned `pip install sports-skills` silently floats to whatever
 * version PyPI serves at build time, so two builds of the same commit can ship
 * different tool catalogs. These tests pin the Dockerfile contract:
 *
 *   1. a single declared ARG carries the sports-skills version;
 *   2. pip installs that exact version (==), not a floating range;
 *   3. the build asserts the *installed* metadata version matches the ARG, so a
 *      resolver substitution fails the build instead of shipping;
 *   4. schema bootstrap fails closed — no `|| echo` warning fallback that turns
 *      a broken bootstrap into a green image with no schemas;
 *   5. the bootstrap writes to the directory the engine actually reads — the env
 *      name is case-sensitive (`sportsclaw_SCHEMA_DIR`), so an uppercase ENV
 *      silently sends build-time schemas to `/root/.sportsclaw/schemas`;
 *   6. every Python module the relay server imports is COPYed into the image.
 *
 * The Dockerfile is asserted as text (never built here) so the contract is
 * enforced on every CI run without a Docker daemon or cross-arch emulation.
 * Where a value must agree with the engine, it is derived from the engine source
 * rather than restated, so drift on either side fails.
 */

import assert from "node:assert/strict";
import { describe, it, before } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const dockerfilePath = join(repoRoot, "docker/relay/Dockerfile");
const relayServerPath = join(repoRoot, "docker/relay/relay_server.py");
const schemaSourcePath = join(repoRoot, "src/schema.ts");

const EXPECTED_SPORTS_SKILLS_VERSION = "0.31.0";

let dockerfile;
/** Non-comment, non-blank Dockerfile lines with line continuations joined. */
let instructions;

before(() => {
  dockerfile = readFileSync(dockerfilePath, "utf8");

  const joined = dockerfile.replace(/\\\r?\n\s*/g, " ");
  instructions = joined
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
});

describe("relay container contract", () => {
  it("declares ARG SPORTS_SKILLS_VERSION pinned to the release version", () => {
    const argLines = instructions.filter((line) => /^ARG\s+SPORTS_SKILLS_VERSION\b/.test(line));

    assert.equal(
      argLines.length,
      1,
      `exactly one ARG SPORTS_SKILLS_VERSION must be declared (found ${argLines.length})`
    );
    assert.equal(
      argLines[0],
      `ARG SPORTS_SKILLS_VERSION=${EXPECTED_SPORTS_SKILLS_VERSION}`,
      "ARG must carry the pinned default version"
    );
  });

  it("declares the version ARG before the pip installation that consumes it", () => {
    const argIndex = instructions.findIndex((line) => /^ARG\s+SPORTS_SKILLS_VERSION\b/.test(line));
    const pipIndex = instructions.findIndex(
      (line) => /^RUN\b/.test(line) && /pip install/.test(line) && /sports-skills/.test(line)
    );

    assert.ok(argIndex >= 0, "ARG SPORTS_SKILLS_VERSION must exist");
    assert.ok(pipIndex >= 0, "a RUN pip install of sports-skills must exist");
    assert.ok(
      argIndex < pipIndex,
      `ARG (line index ${argIndex}) must be declared before the pip install (line index ${pipIndex})`
    );
  });

  it("pip installs sports-skills at the exact ARG version", () => {
    const pipLine = instructions.find(
      (line) => /^RUN\b/.test(line) && /pip install/.test(line) && /sports-skills/.test(line)
    );

    assert.ok(pipLine, "a RUN pip install of sports-skills must exist");
    assert.match(
      pipLine,
      /sports-skills==\$\{SPORTS_SKILLS_VERSION\}/,
      "sports-skills must be pinned to ==${SPORTS_SKILLS_VERSION}"
    );
    assert.ok(
      !/(?:^|\s)sports-skills(?=\s|$)/.test(pipLine),
      "sports-skills must never be installed unpinned"
    );
  });

  it("keeps aiohttp as a separate installed dependency", () => {
    const aiohttpLines = instructions.filter(
      (line) => /^RUN\b/.test(line) && /pip install/.test(line) && /\baiohttp\b/.test(line)
    );

    assert.ok(aiohttpLines.length >= 1, "aiohttp must still be installed via pip");
    assert.ok(
      !/aiohttp==\$\{SPORTS_SKILLS_VERSION\}/.test(aiohttpLines.join("\n")),
      "aiohttp must not inherit the sports-skills version pin"
    );
  });

  it("asserts the installed sports-skills version equals the ARG at build time", () => {
    const assertLines = instructions.filter(
      (line) => /^RUN\b/.test(line) && /importlib\.metadata/.test(line)
    );

    assert.equal(
      assertLines.length,
      1,
      `exactly one build-time version assertion is expected (found ${assertLines.length})`
    );

    const assertLine = assertLines[0];
    assert.match(
      assertLine,
      /importlib\.metadata/,
      "assertion must read the installed distribution metadata"
    );
    assert.match(
      assertLine,
      /version\((['"])sports-skills\1\)/,
      "assertion must query importlib.metadata.version('sports-skills')"
    );
    assert.match(
      assertLine,
      /\$\{?SPORTS_SKILLS_VERSION\}?/,
      "assertion must compare against the SPORTS_SKILLS_VERSION argument"
    );
    assert.match(assertLine, /\bassert\b/, "assertion must actually assert (fail the build)");
  });

  it("bootstraps schemas with a fail-closed init and no warning fallback", () => {
    const initLines = instructions.filter(
      (line) => /^RUN\b/.test(line) && /dist\/index\.js\s+init\b/.test(line)
    );

    assert.equal(
      initLines.length,
      1,
      `exactly one schema bootstrap RUN is expected (found ${initLines.length})`
    );

    const initLine = initLines[0];
    assert.equal(
      initLine,
      "RUN node dist/index.js init --all --verbose",
      "schema bootstrap must be an unguarded, fail-closed init"
    );
    assert.ok(!initLine.includes("||"), "no `||` fallback may swallow a failed bootstrap");
    assert.ok(!/\becho\b/.test(initLine), "no `echo` warning fallback may mask a failed bootstrap");
    assert.ok(!/2>&1/.test(initLine), "no stderr redirection should hide bootstrap failures");
  });

  it("sets the schema dir under the exact env name the engine reads", () => {
    const engineSource = readFileSync(schemaSourcePath, "utf-8");
    const engineEnv = engineSource.match(/process\.env\.(\w*SCHEMA_DIR)\b/);

    assert.ok(engineEnv, "src/schema.ts must resolve the schema dir from an env var");
    const envName = engineEnv[1];

    const envLines = instructions.filter((line) => /^ENV\s+\w*SCHEMA_DIR=/.test(line));
    assert.equal(
      envLines.length,
      1,
      `exactly one schema-dir ENV is expected (found ${envLines.length}: ${envLines.join(" | ")})`
    );
    assert.equal(
      envLines[0],
      `ENV ${envName}=/app/.sportsclaw/schemas`,
      `the ENV name must match the engine's \`process.env.${envName}\` byte for byte — ` +
        "env var names are case-sensitive, so a mismatch sends build-time schemas to " +
        "/root/.sportsclaw/schemas and ships an image whose runtime catalog is empty"
    );
  });

  it("never uses a differently-cased schema dir env name", () => {
    const engineSource = readFileSync(schemaSourcePath, "utf-8");
    const envName = engineSource.match(/process\.env\.(\w*SCHEMA_DIR)\b/)[1];

    const wrongCase = [...dockerfile.matchAll(/\b(\w*SCHEMA_DIR)\b/g)]
      .map((m) => m[1])
      .filter((name) => name !== envName);

    assert.deepEqual(
      [...new Set(wrongCase)],
      [],
      `only \`${envName}\` may appear; other casings are silently ignored by the engine`
    );
  });

  it("declares the schema dir env before the bootstrap init consumes it", () => {
    const envIndex = instructions.findIndex((line) => /^ENV\s+\w*SCHEMA_DIR=/.test(line));
    const initIndex = instructions.findIndex(
      (line) => /^RUN\b/.test(line) && /dist\/index\.js\s+init\b/.test(line)
    );

    assert.ok(envIndex >= 0, "a schema-dir ENV must exist");
    assert.ok(initIndex >= 0, "the schema bootstrap RUN must exist");
    assert.ok(
      envIndex < initIndex,
      `ENV (index ${envIndex}) must precede the bootstrap init (index ${initIndex})`
    );
  });

  it("ships every local Python module the relay server imports", () => {
    const relaySource = readFileSync(relayServerPath, "utf-8");
    const relayDir = dirname(relayServerPath);

    const localImports = [...relaySource.matchAll(/^(?:from|import)\s+(\w+)/gm)]
      .map((m) => m[1])
      .filter((name) => existsSync(join(relayDir, `${name}.py`)));

    assert.ok(
      localImports.length >= 1,
      "the relay server must import its catalog parser as a local module"
    );

    const copyLines = instructions.filter((line) => /^COPY\s+docker\/relay\//.test(line));

    for (const moduleName of new Set(localImports)) {
      assert.ok(
        copyLines.some((line) =>
          new RegExp(`^COPY\\s+docker/relay/${moduleName}\\.py\\s+/opt/sportsclaw/${moduleName}\\.py$`).test(line)
        ),
        `docker/relay/${moduleName}.py must be COPYed next to relay_server.py ` +
          `(otherwise the relay crashes on import at container start). COPY lines: ${copyLines.join(" | ")}`
      );
    }
  });

  it("never masks a schema bootstrap failure anywhere in the Dockerfile", () => {
    const masked = instructions.filter(
      (line) => /init\b/.test(line) && /\|\|/.test(line) && /echo/.test(line)
    );

    assert.deepEqual(masked, [], "no instruction may `|| echo` over a schema bootstrap failure");
    assert.ok(
      !/Warning: schema bootstrap incomplete/.test(dockerfile),
      "the schema bootstrap warning fallback must be gone"
    );
  });
});
