/**
 * Operator job config — schema validation + loader tests.
 *
 * The validator is pure (no I/O) so most tests pass plain objects in.
 * The loader needs a temp config dir, which we redirect via the path
 * helpers exported alongside the loader.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  validateOperatorJobConfig,
} from "../dist/operator-config.js";

// ---------------------------------------------------------------------------
// validateOperatorJobConfig — required fields
// ---------------------------------------------------------------------------

describe("validateOperatorJobConfig — required fields", () => {
  it("rejects a non-object input", () => {
    const r = validateOperatorJobConfig("not an object");
    assert.strictEqual(r.valid, false);
    assert.ok(r.issues.length > 0);
  });

  it("rejects an array at the top level", () => {
    const r = validateOperatorJobConfig([]);
    assert.strictEqual(r.valid, false);
  });

  it("rejects a config with no jobId", () => {
    const r = validateOperatorJobConfig({
      intervalMs: 60_000,
      personaText: "...",
    });
    assert.strictEqual(r.valid, false);
    assert.ok(r.issues.find((i) => i.field === "jobId"));
  });

  it("rejects a config with no intervalMs", () => {
    const r = validateOperatorJobConfig({
      jobId: "tv-operator",
      personaText: "...",
    });
    assert.strictEqual(r.valid, false);
    assert.ok(r.issues.find((i) => i.field === "intervalMs"));
  });

  it("rejects intervalMs <= 0", () => {
    for (const bad of [0, -1, -60_000]) {
      const r = validateOperatorJobConfig({
        jobId: "tv-operator",
        intervalMs: bad,
        personaText: "...",
      });
      assert.strictEqual(r.valid, false, `intervalMs=${bad}`);
      assert.ok(r.issues.find((i) => i.field === "intervalMs"));
    }
  });

  it("rejects non-numeric intervalMs", () => {
    const r = validateOperatorJobConfig({
      jobId: "x",
      intervalMs: "60000",
      personaText: "...",
    });
    assert.strictEqual(r.valid, false);
  });

  it("rejects a config with neither persona nor personaText", () => {
    const r = validateOperatorJobConfig({
      jobId: "x",
      intervalMs: 60_000,
    });
    assert.strictEqual(r.valid, false);
    assert.ok(r.issues.find((i) => i.field === "persona|personaText"));
  });

  it("rejects a config with BOTH persona and personaText", () => {
    const r = validateOperatorJobConfig({
      jobId: "x",
      intervalMs: 60_000,
      persona: "tv-host",
      personaText: "You are...",
    });
    assert.strictEqual(r.valid, false);
  });

  it("rejects a jobId that does not match the filename basename", () => {
    const r = validateOperatorJobConfig(
      {
        jobId: "different-id",
        intervalMs: 60_000,
        personaText: "...",
      },
      { sourcePath: "/tmp/foo/tv-operator.json" },
    );
    assert.strictEqual(r.valid, false);
    assert.ok(r.issues.find((i) => /must match filename/.test(i.message)));
  });

  it("rejects a jobId with path-separators or special chars", () => {
    for (const bad of ["../escape", "a/b", "with spaces", "you+me"]) {
      const r = validateOperatorJobConfig({
        jobId: bad,
        intervalMs: 60_000,
        personaText: "...",
      });
      assert.strictEqual(r.valid, false, `jobId=${bad}`);
    }
  });
});

// ---------------------------------------------------------------------------
// validateOperatorJobConfig — optional fields & type checks
// ---------------------------------------------------------------------------

describe("validateOperatorJobConfig — optional fields", () => {
  const base = {
    jobId: "ok-id",
    intervalMs: 60_000,
    personaText: "You are an autonomous operator.",
  };

  it("accepts a minimal valid config", () => {
    const r = validateOperatorJobConfig(base);
    assert.strictEqual(r.valid, true);
    assert.strictEqual(r.config.jobId, "ok-id");
    assert.strictEqual(r.config.intervalMs, 60_000);
  });

  it("rejects an unknown provider", () => {
    const r = validateOperatorJobConfig({ ...base, provider: "mystery-corp" });
    assert.strictEqual(r.valid, false);
    assert.ok(r.issues.find((i) => i.field === "provider"));
  });

  it("accepts known providers", () => {
    for (const provider of ["anthropic", "openai", "google"]) {
      const r = validateOperatorJobConfig({ ...base, provider });
      assert.strictEqual(r.valid, true, `provider=${provider}`);
    }
  });

  it("rejects a non-string label", () => {
    const r = validateOperatorJobConfig({ ...base, label: 42 });
    assert.strictEqual(r.valid, false);
  });

  it("rejects a non-array extraFragments", () => {
    const r = validateOperatorJobConfig({ ...base, extraFragments: "broadcast" });
    assert.strictEqual(r.valid, false);
  });

  it("rejects an extraFragments entry that is not a string", () => {
    const r = validateOperatorJobConfig({
      ...base,
      extraFragments: ["ok", 42],
    });
    assert.strictEqual(r.valid, false);
    assert.ok(r.issues.find((i) => i.field === "extraFragments[1]"));
  });

  it("rejects a tailServer that isn't a URL", () => {
    const r = validateOperatorJobConfig({ ...base, tailServer: "not a url" });
    assert.strictEqual(r.valid, false);
  });

  it("rejects a tailServer with file:// scheme", () => {
    const r = validateOperatorJobConfig({
      ...base,
      tailServer: "file:///etc/passwd",
    });
    assert.strictEqual(r.valid, false);
  });

  it("accepts a tailServer over http(s)", () => {
    for (const url of ["http://localhost:8090", "https://relay.example.com/sink"]) {
      const r = validateOperatorJobConfig({ ...base, tailServer: url });
      assert.strictEqual(r.valid, true, `url=${url}`);
    }
  });

  it("rejects guardOptions that is not an object", () => {
    for (const bad of [["a"], 42, "string", null]) {
      const r = validateOperatorJobConfig({ ...base, guardOptions: bad });
      assert.strictEqual(r.valid, false, `guardOptions=${JSON.stringify(bad)}`);
    }
  });

  it("accepts an empty guardOptions object", () => {
    const r = validateOperatorJobConfig({ ...base, guardOptions: {} });
    assert.strictEqual(r.valid, true);
  });

  it("accepts known sink values (noop, broadcast)", () => {
    for (const s of ["noop", "broadcast"]) {
      const r = validateOperatorJobConfig({ ...base, sink: s });
      assert.strictEqual(r.valid, true, `sink=${s}`);
      assert.strictEqual(r.config.sink, s);
    }
  });

  it("accepts an external sink name (e.g. package or path) — resolver will load it at runtime", () => {
    const r = validateOperatorJobConfig({
      ...base,
      sink: "@machina-sports/tv-operator-sink",
    });
    assert.strictEqual(r.valid, true);
  });

  it("rejects an empty sink string", () => {
    for (const bad of ["", "   "]) {
      const r = validateOperatorJobConfig({ ...base, sink: bad });
      assert.strictEqual(r.valid, false, `sink=${JSON.stringify(bad)}`);
      assert.ok(r.issues.find((i) => i.field === "sink"));
    }
  });

  it("rejects a non-string sink value", () => {
    for (const bad of [42, true, ["broadcast"], { name: "x" }]) {
      const r = validateOperatorJobConfig({ ...base, sink: bad });
      assert.strictEqual(r.valid, false, `sink=${JSON.stringify(bad)}`);
    }
  });

  it("collects multiple errors at once (line-precise)", () => {
    const r = validateOperatorJobConfig({
      intervalMs: -1,
      label: 42,
      provider: "wrong",
    });
    assert.strictEqual(r.valid, false);
    const fields = new Set(r.issues.map((i) => i.field));
    assert.ok(fields.has("jobId"));
    assert.ok(fields.has("intervalMs"));
    assert.ok(fields.has("label"));
    assert.ok(fields.has("provider"));
    assert.ok(fields.has("persona|personaText"));
  });
});
