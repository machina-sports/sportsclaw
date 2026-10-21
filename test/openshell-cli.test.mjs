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
  interpretSandboxProbeResult,
  parseGatewayListJson,
  parseProviderNames,
} from "../dist/openshell-cli.js";

function stripAnsi(text) {
  return text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

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
    assert.match(stripAnsi(out), /→ do X/);
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
    assert.match(stripAnsi(out), /→ export X/);
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
// 0.1.x structured CLI output
//
// The 0.0.47 provider-table and `inference` parsers were removed with the
// managed route; 0.1.x exposes `gateway list -o json` (bare array) and the
// documented one-name-per-line `provider list --names`.
// ---------------------------------------------------------------------------

describe("parseGatewayListJson", () => {
  it("counts entries in the bare JSON array", () => {
    assert.strictEqual(parseGatewayListJson("[]"), 0);
    assert.strictEqual(parseGatewayListJson('[{"name":"local"}]\n'), 1);
  });

  it("returns undefined for non-array or unparseable output", () => {
    assert.strictEqual(parseGatewayListJson(""), undefined);
    assert.strictEqual(parseGatewayListJson("{}"), undefined);
    assert.strictEqual(parseGatewayListJson("NAME  ENDPOINT\n"), undefined);
  });
});

describe("parseProviderNames", () => {
  it("returns one provider per non-blank line", () => {
    assert.deepStrictEqual(parseProviderNames("nvidia-native-prod\nollama\n"), ["nvidia-native-prod", "ollama"]);
  });

  it("returns [] for empty output", () => {
    assert.deepStrictEqual(parseProviderNames(""), []);
  });
});

// ---------------------------------------------------------------------------
// interpretSandboxProbeResult — `openshell sandbox create` probe interpreter
// ---------------------------------------------------------------------------

describe("interpretSandboxProbeResult", () => {
  it("returns 'ok' when sandbox provisions cleanly", () => {
    const r = interpretSandboxProbeResult({
      ok: true,
      stdout: "Created sandbox: sc-doctor-abc123\n  [0.3s] Running...\n  [0.4s] Completed\n",
      stderr: "",
      exitCode: 0,
      timedOut: false,
    });
    assert.strictEqual(r.id, "compute-driver");
    assert.strictEqual(r.status, "ok");
  });

  it("flags the supervisor-relay symptom with a service-restart hint", () => {
    // Verbatim from `openshell sandbox create` on 2026-05-23 when only the
    // gateway was running and no compute driver was registered. CLI exit was
    // 0 despite the timeout — we must look at the error text, not just exit.
    const r = interpretSandboxProbeResult({
      ok: true,
      stdout:
        "Created sandbox: sportsclaw-test\n\n  [0.0s] Requesting compute...\n\n" +
        "Error:   × sandbox provisioning timed out after 300s. Last reported status:\n" +
        "  │ DependenciesNotReady: Container is running; waiting for supervisor relay\n",
      stderr: "",
      exitCode: 0,
      timedOut: false,
    });
    assert.strictEqual(r.status, "missing");
    assert.match(r.detail, /no compute driver/i);
    assert.match(r.hint, /brew services restart/i);
  });

  it("flags the same symptom when our probe times out before the CLI prints", () => {
    // Real observed case: our 45s probe killed the CLI before its own 300s
    // wait completed, so no "supervisor relay" text was emitted. timedOut
    // must still produce the driver-bringup hint.
    const r = interpretSandboxProbeResult({
      ok: false,
      stdout: "Created sandbox: sc-doctor-xyz\n\n  [0.0s] Requesting compute...\n",
      stderr: "",
      exitCode: null,
      timedOut: true,
    });
    assert.strictEqual(r.status, "missing");
    assert.match(r.detail, /no compute driver/i);
    assert.match(r.hint, /brew services restart/i);
  });

  it("surfaces the first error line for unrelated failures", () => {
    const r = interpretSandboxProbeResult({
      ok: false,
      stdout: "",
      stderr:
        "Error:   × status: Internal, message: \"create sandbox failed: pull Docker image failed: denied\\ndenied\"\n",
      exitCode: 1,
      timedOut: false,
    });
    assert.strictEqual(r.status, "missing");
    assert.match(r.detail, /pull Docker image failed|denied/i);
    assert.doesNotMatch(r.hint ?? "", /brew services restart/i);
  });

  it("falls back to a generic detail when no error line is recognizable", () => {
    const r = interpretSandboxProbeResult({
      ok: false,
      stdout: "",
      stderr: "",
      exitCode: 137,
      timedOut: false,
    });
    assert.strictEqual(r.status, "missing");
    assert.match(r.detail, /exit 137/);
  });
});

// ---------------------------------------------------------------------------
// buildScaffoldConfig
// ---------------------------------------------------------------------------

describe("buildScaffoldConfig", () => {
  it("produces valid JSON with an explicit native openshell block", () => {
    const raw = buildScaffoldConfig({
      jobId: "tv-op",
      personaText: "You are an operator.",
      provider: "anthropic",
      model: "claude-opus-4-6",
      intervalMs: 60000,
      baseUrl: "https://api.anthropic.com/v1",
      credentialEnv: "ANTHROPIC_API_KEY",
    });
    const cfg = JSON.parse(raw);
    assert.strictEqual(cfg.jobId, "tv-op");
    assert.strictEqual(cfg.provider, "anthropic");
    assert.strictEqual(cfg.model, "claude-opus-4-6");
    assert.strictEqual(cfg.intervalMs, 60000);
    assert.strictEqual(cfg.personaText, "You are an operator.");
    assert.deepStrictEqual(cfg.openshell, {
      baseUrl: "https://api.anthropic.com/v1",
      credentialEnv: "ANTHROPIC_API_KEY",
    });
  });

  it("ends with a trailing newline (POSIX file convention)", () => {
    const raw = buildScaffoldConfig({
      jobId: "x",
      personaText: "...",
      provider: "openai",
      model: "gpt-4.1",
      intervalMs: 30000,
      baseUrl: "http://host.openshell.internal:8000/v1",
      credentialless: true,
    });
    assert.ok(raw.endsWith("\n"));
    assert.deepStrictEqual(JSON.parse(raw).openshell, {
      baseUrl: "http://host.openshell.internal:8000/v1",
      credentialless: true,
    });
  });

  it("survives the operator-config validator", async () => {
    const { validateOperatorJobConfig } = await import("../dist/operator-config.js");
    const raw = buildScaffoldConfig({
      jobId: "scaffold-test",
      personaText: "You are SportsClaw.",
      provider: "anthropic",
      model: "claude-opus-4-6",
      intervalMs: 60000,
      baseUrl: "https://api.anthropic.com/v1",
      credentialEnv: "ANTHROPIC_API_KEY",
    });
    const result = validateOperatorJobConfig(JSON.parse(raw));
    assert.strictEqual(result.valid, true, JSON.stringify(result.issues));
    assert.strictEqual(result.config.openshell.baseUrl, "https://api.anthropic.com/v1");
    assert.strictEqual(result.config.openshell.credentialEnv, "ANTHROPIC_API_KEY");
  });
});
