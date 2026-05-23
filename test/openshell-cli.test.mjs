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
  parseInferenceGetOutput,
  parseProviderListOutput,
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
// parseProviderListOutput — `openshell provider list` table parser
// ---------------------------------------------------------------------------

describe("parseProviderListOutput", () => {
  // Captured verbatim from `openshell provider list` against OpenShell 0.0.47
  // with one provider (`nvidia-prod`). Header is wrapped in `\x1B[1m...\x1B[0m`.
  const WITH_PROVIDERS =
    "\x1B[1mNAME       \x1B[0m  \x1B[1mTYPE  \x1B[0m  \x1B[1mCREDENTIAL_KEYS \x1B[0m  \x1B[1mCONFIG_KEYS\x1B[0m\n" +
    "nvidia-prod  nvidia  1                 0\n";

  it("returns hasProviders=true when a data row follows the header", () => {
    assert.deepStrictEqual(parseProviderListOutput(WITH_PROVIDERS), {
      hasProviders: true,
    });
  });

  it("returns hasProviders=false when only the header is present", () => {
    const headerOnly =
      "\x1B[1mNAME       \x1B[0m  \x1B[1mTYPE  \x1B[0m  \x1B[1mCREDENTIAL_KEYS \x1B[0m  \x1B[1mCONFIG_KEYS\x1B[0m\n";
    assert.deepStrictEqual(parseProviderListOutput(headerOnly), {
      hasProviders: false,
    });
  });

  it("returns hasProviders=false for empty output", () => {
    assert.deepStrictEqual(parseProviderListOutput(""), {
      hasProviders: false,
    });
  });
});

// ---------------------------------------------------------------------------
// parseInferenceGetOutput — `openshell inference get` parser
// ---------------------------------------------------------------------------

describe("parseInferenceGetOutput", () => {
  // Captured verbatim from `openshell inference get` against OpenShell 0.0.47
  // with nvidia-prod / nvidia/nemotron-3-nano-30b-a3b pinned. Labels are
  // wrapped in `\x1B[2m...\x1B[0m` — the old `/Provider:\s*(\S+)/` regex
  // would capture `\x1B[0m` instead of the actual provider name.
  const CONFIGURED =
    "\x1B[1m\x1B[36mGateway inference:\x1B[39m\x1B[0m\n\n" +
    "  \x1B[2mProvider:\x1B[0m nvidia-prod\n" +
    "  \x1B[2mModel:\x1B[0m nvidia/nemotron-3-nano-30b-a3b\n" +
    "  \x1B[2mVersion:\x1B[0m 1\n" +
    "  \x1B[2mTimeout:\x1B[0m 300s\n";

  const NOT_CONFIGURED =
    "\x1B[1m\x1B[36mGateway inference:\x1B[39m\x1B[0m\n\n" +
    "  \x1B[2mNot configured\x1B[0m\n\n" +
    "\x1B[1m\x1B[36mSystem inference:\x1B[39m\x1B[0m\n\n" +
    "  \x1B[2mNot configured\x1B[0m\n";

  it("extracts provider and model through ANSI-wrapped labels", () => {
    assert.deepStrictEqual(parseInferenceGetOutput(CONFIGURED), {
      provider: "nvidia-prod",
      model: "nvidia/nemotron-3-nano-30b-a3b",
    });
  });

  it("returns empty provider/model when both sections report 'Not configured'", () => {
    assert.deepStrictEqual(parseInferenceGetOutput(NOT_CONFIGURED), {
      provider: undefined,
      model: undefined,
    });
  });

  it("returns Gateway inference values even when System inference is 'Not configured'", () => {
    // Real observed case: gateway routing pinned, but system-level default
    // still unset. We care about gateway routing — that's what `inference.local`
    // resolves through.
    const MIXED =
      "\x1B[1m\x1B[36mGateway inference:\x1B[39m\x1B[0m\n\n" +
      "  \x1B[2mProvider:\x1B[0m nvidia-prod\n" +
      "  \x1B[2mModel:\x1B[0m nvidia/nemotron-3-nano-30b-a3b\n" +
      "  \x1B[2mVersion:\x1B[0m 1\n" +
      "  \x1B[2mTimeout:\x1B[0m 300s\n\n" +
      "\x1B[1m\x1B[36mSystem inference:\x1B[39m\x1B[0m\n\n" +
      "  \x1B[2mNot configured\x1B[0m\n";
    assert.deepStrictEqual(parseInferenceGetOutput(MIXED), {
      provider: "nvidia-prod",
      model: "nvidia/nemotron-3-nano-30b-a3b",
    });
  });

  it("returns empty when output is unrecognizable", () => {
    assert.deepStrictEqual(parseInferenceGetOutput("unexpected garbage\n"), {
      provider: undefined,
      model: undefined,
    });
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
