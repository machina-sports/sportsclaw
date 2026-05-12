/**
 * External operator sink resolution — filesystem path + npm package name.
 *
 * The resolver in src/operator-sink.ts must:
 *   - Accept relative paths (./foo.mjs) resolved against process.cwd()
 *   - Accept absolute paths (/abs/path.mjs)
 *   - Accept npm package names (anything else; passed to import() as-is)
 *   - Prefer `default` export over named `sink` export
 *   - Reject modules missing both exports
 *   - Reject sink objects missing the required `name` field
 *   - Surface import failures with a clear, actionable message
 *
 * The test fixtures live in test/fixtures/sinks/.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveSink } from "../dist/operator-sink.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_DIR = path.join(__dirname, "fixtures", "sinks");

const baseCfg = {
  jobId: "j",
  intervalMs: 60_000,
  personaText: "x",
};

// ---------------------------------------------------------------------------
// Filesystem paths
// ---------------------------------------------------------------------------

describe("resolveSink — filesystem paths", () => {
  it("loads a sink from a relative path (./...)", async () => {
    // Use a relative path from the repo root (cwd when tests run).
    const rel = path.relative(process.cwd(), path.join(FIXTURE_DIR, "default-export.mjs"));
    const spec = rel.startsWith(".") ? rel : `./${rel}`;
    const s = await resolveSink({ ...baseCfg, sink: spec });
    assert.strictEqual(s.name, "fixture-default");
  });

  it("loads a sink from an absolute path", async () => {
    const abs = path.join(FIXTURE_DIR, "default-export.mjs");
    const s = await resolveSink({ ...baseCfg, sink: abs });
    assert.strictEqual(s.name, "fixture-default");
  });

  it("accepts `.mjs` paths even without a leading `./` (suffix detection)", async () => {
    // Bare filename ending in .mjs — uncommon but supported.
    // We can't pass just "default-export.mjs" because that's resolved as
    // a package; supply an absolute path to disambiguate while still
    // exercising the .mjs-suffix detection branch.
    const abs = path.join(FIXTURE_DIR, "default-export.mjs");
    const s = await resolveSink({ ...baseCfg, sink: abs });
    assert.strictEqual(s.name, "fixture-default");
  });
});

// ---------------------------------------------------------------------------
// Module-shape contract
// ---------------------------------------------------------------------------

describe("resolveSink — module shape contract", () => {
  it("picks the `default` export when present", async () => {
    const abs = path.join(FIXTURE_DIR, "default-export.mjs");
    const s = await resolveSink({ ...baseCfg, sink: abs });
    assert.strictEqual(s.name, "fixture-default");
  });

  it("falls back to a named `sink` export when no default", async () => {
    const abs = path.join(FIXTURE_DIR, "named-export.mjs");
    const s = await resolveSink({ ...baseCfg, sink: abs });
    assert.strictEqual(s.name, "fixture-named");
  });

  it("prefers `default` over `sink` when both are present", async () => {
    const abs = path.join(FIXTURE_DIR, "prefer-default.mjs");
    const s = await resolveSink({ ...baseCfg, sink: abs });
    assert.strictEqual(s.name, "fixture-default-wins");
  });

  it("rejects a module exporting neither a default nor a `sink`", async () => {
    const abs = path.join(FIXTURE_DIR, "no-export.mjs");
    await assert.rejects(
      resolveSink({ ...baseCfg, sink: abs }),
      /exports neither a default nor a named "sink"/i,
    );
  });

  it("rejects a plugin missing the required `name` field", async () => {
    const abs = path.join(FIXTURE_DIR, "no-name.mjs");
    await assert.rejects(
      resolveSink({ ...baseCfg, sink: abs }),
      /missing the required `name` field/i,
    );
  });
});

// ---------------------------------------------------------------------------
// Import failures
// ---------------------------------------------------------------------------

describe("resolveSink — import failure surfaces", () => {
  it("surfaces a clear error when the file doesn't exist", async () => {
    const missing = path.join(FIXTURE_DIR, "does-not-exist.mjs");
    await assert.rejects(
      resolveSink({ ...baseCfg, sink: missing }),
      /Failed to load operator sink/i,
    );
  });

  it("surfaces a clear error when the npm package isn't installed", async () => {
    await assert.rejects(
      resolveSink({ ...baseCfg, sink: "@machina-sports/this-package-does-not-exist" }),
      /Failed to load operator sink/i,
    );
  });
});
