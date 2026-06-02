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

  it("accepts a skills list of strings", () => {
    const r = validateOperatorJobConfig({
      ...base,
      skills: ["football", "kalshi", "polymarket"],
    });
    assert.strictEqual(r.valid, true);
    assert.deepStrictEqual(r.config.skills, ["football", "kalshi", "polymarket"]);
  });

  it("accepts an empty skills array (caller's choice — launcher won't set the env var)", () => {
    const r = validateOperatorJobConfig({ ...base, skills: [] });
    assert.strictEqual(r.valid, true);
    assert.deepStrictEqual(r.config.skills, []);
  });

  it("rejects a non-array skills value", () => {
    for (const bad of ["football", 42, { football: true }]) {
      const r = validateOperatorJobConfig({ ...base, skills: bad });
      assert.strictEqual(r.valid, false, `skills=${JSON.stringify(bad)}`);
      assert.ok(r.issues.find((i) => i.field === "skills"));
    }
  });

  it("rejects a skills entry that is not a string", () => {
    const r = validateOperatorJobConfig({
      ...base,
      skills: ["football", 42, "polymarket"],
    });
    assert.strictEqual(r.valid, false);
    assert.ok(r.issues.find((i) => i.field === "skills[1]"));
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

  it("accepts enableMemoryTools as boolean (true and false)", () => {
    for (const v of [true, false]) {
      const r = validateOperatorJobConfig({ ...base, enableMemoryTools: v });
      assert.strictEqual(r.valid, true, `enableMemoryTools=${v}`);
      assert.strictEqual(r.config.enableMemoryTools, v);
    }
  });

  it("rejects a non-boolean enableMemoryTools", () => {
    for (const bad of ["true", 1, 0, null, [], {}]) {
      const r = validateOperatorJobConfig({ ...base, enableMemoryTools: bad });
      assert.strictEqual(r.valid, false, `enableMemoryTools=${JSON.stringify(bad)}`);
      assert.ok(r.issues.find((i) => i.field === "enableMemoryTools"));
    }
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

  // --- broadcastSafety --------------------------------------------------

  it("accepts a minimal broadcastSafety block (enabled only)", () => {
    const r = validateOperatorJobConfig({
      ...base,
      broadcastSafety: { enabled: true },
    });
    assert.strictEqual(r.valid, true);
    assert.deepStrictEqual(r.config.broadcastSafety, { enabled: true });
  });

  it("accepts broadcastSafety with full options and a fallbackManifest", () => {
    const r = validateOperatorJobConfig({
      ...base,
      broadcastSafety: {
        enabled: true,
        options: {
          minimumTotalDurationSec: 60,
          maximumTotalDurationSec: 3600,
          requireFallbackForEveryBlock: true,
          requireFreshnessForLiveBlocks: true,
          maxLiveAgeMs: 10000,
          expectedBlockCountMin: 1,
        },
        fallbackManifest: { id: "fallback-1", channelId: "x", blocks: [] },
      },
    });
    assert.strictEqual(r.valid, true);
  });

  it("rejects a non-object broadcastSafety", () => {
    for (const bad of ["yes", 42, ["enabled"], null]) {
      const r = validateOperatorJobConfig({ ...base, broadcastSafety: bad });
      assert.strictEqual(r.valid, false, `broadcastSafety=${JSON.stringify(bad)}`);
      // null is treated as "unset" by the validator (matches the `!== undefined`
      // gate but `null` !== undefined → still validates and falls through). The
      // other cases must surface a broadcastSafety-field issue.
      if (bad !== null) {
        assert.ok(r.issues.find((i) => i.field === "broadcastSafety"));
      }
    }
  });

  it("rejects a non-boolean broadcastSafety.enabled", () => {
    const r = validateOperatorJobConfig({
      ...base,
      broadcastSafety: { enabled: "true" },
    });
    assert.strictEqual(r.valid, false);
    assert.ok(r.issues.find((i) => i.field === "broadcastSafety.enabled"));
  });

  it("rejects a non-object broadcastSafety.options", () => {
    const r = validateOperatorJobConfig({
      ...base,
      broadcastSafety: { enabled: true, options: "all" },
    });
    assert.strictEqual(r.valid, false);
    assert.ok(r.issues.find((i) => i.field === "broadcastSafety.options"));
  });

  it("rejects non-numeric broadcastSafety.options numeric fields", () => {
    const numericFields = [
      "minimumTotalDurationSec",
      "maximumTotalDurationSec",
      "maxLiveAgeMs",
      "expectedBlockCountMin",
    ];
    for (const field of numericFields) {
      const r = validateOperatorJobConfig({
        ...base,
        broadcastSafety: { enabled: true, options: { [field]: "60" } },
      });
      assert.strictEqual(r.valid, false, `field=${field}`);
      assert.ok(
        r.issues.find((i) => i.field === `broadcastSafety.options.${field}`),
        `expected issue on broadcastSafety.options.${field}`,
      );
    }
  });

  it("rejects non-boolean broadcastSafety.options boolean fields", () => {
    const booleanFields = [
      "requireFallbackForEveryBlock",
      "requireFreshnessForLiveBlocks",
    ];
    for (const field of booleanFields) {
      const r = validateOperatorJobConfig({
        ...base,
        broadcastSafety: { enabled: true, options: { [field]: "yes" } },
      });
      assert.strictEqual(r.valid, false, `field=${field}`);
      assert.ok(
        r.issues.find((i) => i.field === `broadcastSafety.options.${field}`),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// validateOperatorJobConfig — openshell block (Phase 2a)
// ---------------------------------------------------------------------------

describe("validateOperatorJobConfig — openshell block", () => {
  const base = {
    jobId: "openshell-job",
    intervalMs: 60_000,
    personaText: "You are an autonomous operator.",
  };

  it("accepts a config with no openshell block (default direct mode)", () => {
    const r = validateOperatorJobConfig(base);
    assert.strictEqual(r.valid, true);
    assert.strictEqual(r.config.openshell, undefined);
  });

  it("accepts an empty openshell block (defaults to enabled)", () => {
    const r = validateOperatorJobConfig({
      ...base,
      provider: "anthropic",
      openshell: {},
    });
    assert.strictEqual(r.valid, true);
    assert.deepStrictEqual(r.config.openshell, {
      enabled: undefined,
      baseUrl: undefined,
    });
  });

  it("accepts openshell with explicit enabled=true", () => {
    const r = validateOperatorJobConfig({
      ...base,
      provider: "anthropic",
      openshell: { enabled: true, baseUrl: "https://inference.local" },
    });
    assert.strictEqual(r.valid, true);
    assert.strictEqual(r.config.openshell.enabled, true);
    assert.strictEqual(r.config.openshell.baseUrl, "https://inference.local");
  });

  it("accepts openshell with enabled=false (block present but inert)", () => {
    const r = validateOperatorJobConfig({
      ...base,
      provider: "google",  // would normally fail D1, but disabled block is fine
      openshell: { enabled: false },
    });
    assert.strictEqual(r.valid, true);
    assert.strictEqual(r.config.openshell.enabled, false);
  });

  it("rejects non-object openshell", () => {
    for (const bad of ["yes", 42, true, []]) {
      const r = validateOperatorJobConfig({ ...base, openshell: bad });
      assert.strictEqual(r.valid, false, `openshell=${JSON.stringify(bad)}`);
      assert.ok(r.issues.find((i) => i.field === "openshell"));
    }
  });

  it("rejects non-boolean openshell.enabled", () => {
    const r = validateOperatorJobConfig({
      ...base,
      openshell: { enabled: "true" },
    });
    assert.strictEqual(r.valid, false);
    assert.ok(r.issues.find((i) => i.field === "openshell.enabled"));
  });

  it("rejects non-string openshell.baseUrl", () => {
    const r = validateOperatorJobConfig({
      ...base,
      openshell: { baseUrl: 42 },
    });
    assert.strictEqual(r.valid, false);
    assert.ok(r.issues.find((i) => i.field === "openshell.baseUrl"));
  });

  it("rejects openshell.baseUrl that isn't a URL", () => {
    const r = validateOperatorJobConfig({
      ...base,
      openshell: { baseUrl: "not a url" },
    });
    assert.strictEqual(r.valid, false);
    assert.ok(r.issues.find((i) => i.field === "openshell.baseUrl"));
  });

  it("rejects openshell.baseUrl with file:// scheme", () => {
    const r = validateOperatorJobConfig({
      ...base,
      openshell: { baseUrl: "file:///etc/passwd" },
    });
    assert.strictEqual(r.valid, false);
    assert.ok(r.issues.find((i) => i.field === "openshell.baseUrl"));
  });

  it("rejects openshell + provider=google (D1)", () => {
    const r = validateOperatorJobConfig({
      ...base,
      provider: "google",
      openshell: {},
    });
    assert.strictEqual(r.valid, false);
    assert.ok(r.issues.find((i) => i.field === "openshell"));
  });

  it("rejects openshell + provider=google even with explicit enabled=true", () => {
    const r = validateOperatorJobConfig({
      ...base,
      provider: "google",
      openshell: { enabled: true },
    });
    assert.strictEqual(r.valid, false);
  });
});

// ---------------------------------------------------------------------------
// inference block — model-role router config
// ---------------------------------------------------------------------------

describe("validateOperatorJobConfig — inference block", () => {
  const base = {
    jobId: "inference-job",
    intervalMs: 60_000,
    personaText: "You are an autonomous operator.",
  };

  it("accepts a config with no inference block", () => {
    const r = validateOperatorJobConfig(base);
    assert.strictEqual(r.valid, true);
    assert.strictEqual(r.config.inference, undefined);
  });

  it("accepts the target four-role NIM/H200 inference config", () => {
    const r = validateOperatorJobConfig({
      ...base,
      inference: {
        roles: {
          eyes: {
            route: "nim",
            locality: "h200",
            accelerator: "h200",
            model: "nvidia/cosmos3-nano-reasoner",
          },
          brain: {
            route: "nim",
            locality: "h200",
            accelerator: "h200",
            model: "nvidia/nemotron-3-super-120b-a12b",
          },
          hands: {
            route: "nim",
            locality: "h200",
            accelerator: "h200",
            model: "nvidia/cosmos3-super-i2v",
          },
          voice: {
            route: "nim",
            locality: "h200",
            accelerator: "h200",
            model: "nvidia/llama-3.3-nemotron-super-49b",
          },
        },
      },
    });
    assert.strictEqual(r.valid, true, JSON.stringify(r.issues));
    assert.strictEqual(r.config.inference.roles.eyes.model, "nvidia/cosmos3-nano-reasoner");
    assert.strictEqual(r.config.inference.roles.voice.route, "nim");
  });

  it("rejects a non-object inference block", () => {
    for (const bad of ["nim", 42, true, []]) {
      const r = validateOperatorJobConfig({ ...base, inference: bad });
      assert.strictEqual(r.valid, false, `inference=${JSON.stringify(bad)}`);
      assert.ok(r.issues.find((i) => i.field === "inference"));
    }
  });

  it("rejects an inference block with an unknown role", () => {
    const r = validateOperatorJobConfig({
      ...base,
      inference: { roles: { ears: { route: "mock", model: "m" } } },
    });
    assert.strictEqual(r.valid, false);
    assert.ok(r.issues.find((i) => i.field === "inference"));
  });

  it("rejects an inference block with a missing model", () => {
    const r = validateOperatorJobConfig({
      ...base,
      inference: { roles: { eyes: { route: "nim" } } },
    });
    assert.strictEqual(r.valid, false);
    const issue = r.issues.find((i) => i.field === "inference");
    assert.ok(issue);
    assert.ok(issue.message.includes("eyes"));
  });
});
