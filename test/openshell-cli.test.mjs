/**
 * `sportsclaw openshell` CLI — focused tests on the pure helpers.
 *
 * The doctor's individual probes shell out to `openshell` and `docker`,
 * which would make any test depend on host state. We test the
 * formatter and the scaffold builder directly with synthetic inputs.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildScaffoldConfig,
  formatReport,
} from "../dist/openshell-cli.js";

// ---------------------------------------------------------------------------
// formatReport
// ---------------------------------------------------------------------------

describe("formatReport", () => {
  it("includes a marker, label, and detail per result", () => {
    const out = formatReport({
      results: [
        { id: "a", label: "Item A", status: "ok", detail: "v1.2.3" },
        { id: "b", label: "Item B", status: "missing", detail: "not found", hint: "do X" },
      ],
      allOk: false,
    });
    assert.match(out, /Item A/);
    assert.match(out, /v1\.2\.3/);
    assert.match(out, /Item B/);
    assert.match(out, /not found/);
    assert.match(out, /→ do X/);
  });

  it("prints the all-ok banner when every check passes", () => {
    const out = formatReport({
      results: [{ id: "a", label: "Item A", status: "ok", detail: "" }],
      allOk: true,
    });
    assert.match(out, /All checks passed/);
    assert.match(out, /openshell sandbox create/);
  });

  it("prints a remediation hint pointing at `setup` when any check fails", () => {
    const out = formatReport({
      results: [
        { id: "a", label: "Item A", status: "ok" },
        { id: "b", label: "Item B", status: "missing", hint: "do X" },
      ],
      allOk: false,
    });
    assert.match(out, /sportsclaw openshell setup/);
  });

  it("renders a `warn` status with its hint", () => {
    const out = formatReport({
      results: [
        { id: "k", label: "API key", status: "warn", detail: "not set", hint: "export X" },
      ],
      allOk: false,
    });
    assert.match(out, /API key/);
    assert.match(out, /not set/);
    assert.match(out, /→ export X/);
  });

  it("does not print a remediation arrow for OK rows", () => {
    const out = formatReport({
      results: [{ id: "a", label: "Item A", status: "ok", detail: "fine", hint: "ignored" }],
      allOk: true,
    });
    assert.doesNotMatch(out, /→ ignored/);
  });
});

// ---------------------------------------------------------------------------
// buildScaffoldConfig
// ---------------------------------------------------------------------------

describe("buildScaffoldConfig", () => {
  it("produces valid JSON with the openshell block enabled by default", () => {
    const raw = buildScaffoldConfig({
      jobId: "tv-op",
      personaText: "You are an operator.",
      provider: "anthropic",
      model: "claude-opus-4-6",
      intervalMs: 60000,
    });
    const cfg = JSON.parse(raw);
    assert.strictEqual(cfg.jobId, "tv-op");
    assert.strictEqual(cfg.provider, "anthropic");
    assert.strictEqual(cfg.model, "claude-opus-4-6");
    assert.strictEqual(cfg.intervalMs, 60000);
    assert.strictEqual(cfg.personaText, "You are an operator.");
    assert.deepStrictEqual(cfg.openshell, {});
  });

  it("ends with a trailing newline (POSIX file convention)", () => {
    const raw = buildScaffoldConfig({
      jobId: "x",
      personaText: "...",
      provider: "openai",
      model: "gpt-4.1",
      intervalMs: 30000,
    });
    assert.ok(raw.endsWith("\n"));
  });

  it("survives the operator-config validator", async () => {
    const { validateOperatorJobConfig } = await import("../dist/operator-config.js");
    const raw = buildScaffoldConfig({
      jobId: "scaffold-test",
      personaText: "You are SportsClaw.",
      provider: "anthropic",
      model: "claude-opus-4-6",
      intervalMs: 60000,
    });
    const parsed = JSON.parse(raw);
    const result = validateOperatorJobConfig(parsed);
    assert.strictEqual(result.valid, true, JSON.stringify(result.issues));
    assert.deepStrictEqual(result.config.openshell, {
      enabled: undefined,
      baseUrl: undefined,
    });
  });
});
