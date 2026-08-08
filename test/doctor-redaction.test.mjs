/**
 * Release gate: `sportsclaw doctor` must prove configuration without printing
 * any credential substring or the configured private endpoint.
 *
 * Offline: doctor only shells out to python/machina locally — no network.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Sentinels: first 6 and last 4 characters are unique tokens that cannot occur
// in doctor output by accident, so a masked `abc123...wxyz` render is detectable.
const AZURE_KEY = "AZKEY0-sentinel-azure-key-material-9ZQ1";
const AZURE_BASE_URL = "https://sentinel-endpoint-9f31.invalid/openai/v1";
const AZURE_HOST = "sentinel-endpoint-9f31";
// Assembled from fragments so no complete key-shaped literal exists in source
// (secret scanners flag the joined form); the runtime value is unchanged.
const ANTHROPIC_ENV_KEY = ["ANTENV", "sentinel", "anthropic", "env", "key", "8XQ2"].join("-");
const ANTHROPIC_STORED_KEY = "ANTKCH-sentinel-anthropic-stored-7WQ3";
const OPENAI_KEY = "OAIKEY-sentinel-openai-key-material-6VQ4";
const DRIFT_SAVED_KEY = "DRIFTA-sentinel-config-json-key-5UQ5";
// Assembled from fragments for the same reason as ANTHROPIC_ENV_KEY above.
const DRIFT_DOTENV_KEY = ["DRIFTB", "sentinel", "dotenv", "key", "4TQ6"].join("-");
// Chat-integration drift sentinels — same fragment assembly, so no complete
// bot-token-shaped literal exists in this source file.
const DRIFT_TELEGRAM_SAVED = ["DRIFTC", "sentinel", "telegram", "config", "3SQ7"].join("-");
const DRIFT_TELEGRAM_DOTENV = ["DRIFTD", "sentinel", "telegram", "dotenv", "2RQ8"].join("-");
const DRIFT_DISCORD_SAVED = ["DRIFTE", "sentinel", "discord", "config", "1PQ9"].join("-");
const DRIFT_DISCORD_DOTENV = ["DRIFTF", "sentinel", "discord", "dotenv", "0NQ0"].join("-");

const STRIPPED_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "AZURE_FOUNDRY_API_KEY",
  "AZURE_FOUNDRY_BASE_URL",
  "AZURE_FOUNDRY_API_MODE",
  "AZURE_FOUNDRY_AUTH_MODE",
  "SPORTSCLAW_PROVIDER",
  "SPORTSCLAW_MODEL",
  "TELEGRAM_BOT_TOKEN",
  "DISCORD_BOT_TOKEN",
];

function makeHome(files) {
  const home = mkdtempSync(join(tmpdir(), "sportsclaw-doctor-"));
  const dir = join(home, ".sportsclaw");
  mkdirSync(dir, { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(dir, name), contents);
  }
  return home;
}

/** Runs `node dist/index.js doctor` and returns stdout+stderr, tolerating a nonzero exit. */
function runDoctor(home, extraEnv = {}) {
  const env = { ...process.env, HOME: home, NO_COLOR: "1", ...extraEnv };
  for (const key of STRIPPED_ENV_KEYS) {
    if (!(key in extraEnv)) delete env[key];
  }
  try {
    return execFileSync(process.execPath, ["dist/index.js", "doctor"], {
      cwd: process.cwd(),
      env,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    // Python / sports-skills checks can fail on this machine — doctor still
    // printed the auth section, which is what we assert on.
    const out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
    if (out.length > 0) return out;
    throw err;
  }
}

/** Asserts no full value, leading/trailing fragment, or masked render leaked. */
function assertRedacted(output, secret, label) {
  const first6 = secret.slice(0, 6);
  const last4 = secret.slice(-4);
  assert.ok(!output.includes(secret), `${label}: full value leaked`);
  assert.ok(!output.includes(first6), `${label}: leading fragment "${first6}" leaked`);
  assert.ok(!output.includes(last4), `${label}: trailing fragment "${last4}" leaked`);
  assert.ok(
    !output.includes(`${first6}...${last4}`),
    `${label}: masked value leaked`,
  );
}

describe("sportsclaw doctor credential redaction", () => {
  it("reports installed schemas as sport and support-module totals even with a runtime filter", () => {
    const home = makeHome({
      "config.json": JSON.stringify({ provider: "openai", model: "gpt-4.1" }),
    });
    const schemaDir = join(home, ".sportsclaw", "schemas");
    mkdirSync(schemaDir, { recursive: true });
    for (const sport of ["nba", "nfl", "kalshi"]) {
      writeFileSync(join(schemaDir, `${sport}.json`), JSON.stringify({ sport, tools: [] }));
    }
    try {
      const out = runDoctor(home, {
        OPENAI_API_KEY: OPENAI_KEY,
        SPORTSCLAW_SKILLS: "nba",
      });
      assert.match(out, /3 schemas \(2 sports, 1 support modules\)/);
      assert.doesNotMatch(out, /3 sport schemas installed/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("does not print Azure Foundry key material or the configured base URL", () => {
    const home = makeHome({
      "config.json": JSON.stringify({ provider: "azure-foundry", model: "gpt-5.2" }),
      ".env": [
        `AZURE_FOUNDRY_BASE_URL=${AZURE_BASE_URL}`,
        "AZURE_FOUNDRY_AUTH_MODE=api_key",
        `AZURE_FOUNDRY_API_KEY=${AZURE_KEY}`,
        "",
      ].join("\n"),
    });
    try {
      const out = runDoctor(home);
      assertRedacted(out, AZURE_KEY, "azure api key");
      assert.ok(!out.includes(AZURE_HOST), "azure base URL host leaked");
      assert.ok(!out.includes(AZURE_BASE_URL), "azure base URL leaked");
      assert.match(out, /Azure Foundry API key configured/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("does not print the configured base URL in Azure Foundry Entra ID mode", () => {
    const home = makeHome({
      "config.json": JSON.stringify({ provider: "azure-foundry", model: "gpt-5.2" }),
      ".env": [
        `AZURE_FOUNDRY_BASE_URL=${AZURE_BASE_URL}`,
        "AZURE_FOUNDRY_AUTH_MODE=entra_id",
        "",
      ].join("\n"),
    });
    try {
      const out = runDoctor(home);
      assert.ok(!out.includes(AZURE_HOST), "azure base URL host leaked");
      assert.ok(!out.includes(AZURE_BASE_URL), "azure base URL leaked");
      assert.match(out, /Entra ID/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("still reports a missing Azure Foundry base URL", () => {
    const home = makeHome({
      "config.json": JSON.stringify({ provider: "azure-foundry", model: "gpt-5.2" }),
      ".env": "AZURE_FOUNDRY_AUTH_MODE=entra_id\n",
    });
    try {
      const out = runDoctor(home);
      assert.match(out, /AZURE_FOUNDRY_BASE_URL is not set/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("does not print Anthropic key material from the environment", () => {
    const home = makeHome({
      "config.json": JSON.stringify({ provider: "anthropic", model: "claude-opus-5" }),
    });
    try {
      const out = runDoctor(home, { ANTHROPIC_API_KEY: ANTHROPIC_ENV_KEY });
      assertRedacted(out, ANTHROPIC_ENV_KEY, "anthropic env key");
      assert.match(out, /Anthropic API key configured \(source: env\)/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("does not print Anthropic key material from the credential store", () => {
    const home = makeHome({
      "config.json": JSON.stringify({ provider: "anthropic", model: "claude-opus-5" }),
      "credentials.json": JSON.stringify({ ANTHROPIC_API_KEY: ANTHROPIC_STORED_KEY }),
    });
    try {
      const out = runDoctor(home);
      assertRedacted(out, ANTHROPIC_STORED_KEY, "anthropic stored key");
      assert.match(out, /Anthropic API key configured \(source: keychain\)/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("still reports missing Anthropic credentials", () => {
    const home = makeHome({
      "config.json": JSON.stringify({ provider: "anthropic", model: "claude-opus-5" }),
    });
    try {
      const out = runDoctor(home);
      assert.match(out, /No Anthropic credentials/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("does not print key material for other providers", () => {
    const home = makeHome({
      "config.json": JSON.stringify({
        provider: "openai",
        model: "gpt-5.2",
        apiKey: OPENAI_KEY,
      }),
    });
    try {
      const out = runDoctor(home);
      assertRedacted(out, OPENAI_KEY, "openai key");
      assert.match(out, /openai API key configured/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("does not print key material in the config drift report", () => {
    const home = makeHome({
      "config.json": JSON.stringify({
        provider: "anthropic",
        model: "claude-opus-5",
        apiKey: DRIFT_SAVED_KEY,
        chatIntegrations: {
          telegram: { botToken: DRIFT_TELEGRAM_SAVED },
          discord: { botToken: DRIFT_DISCORD_SAVED },
        },
      }),
      ".env": [
        `ANTHROPIC_API_KEY=${DRIFT_DOTENV_KEY}`,
        `TELEGRAM_BOT_TOKEN=${DRIFT_TELEGRAM_DOTENV}`,
        `DISCORD_BOT_TOKEN=${DRIFT_DISCORD_DOTENV}`,
        "",
      ].join("\n"),
    });
    try {
      const out = runDoctor(home);
      assert.match(out, /Config drift/);
      assertRedacted(out, DRIFT_SAVED_KEY, "drift config.json key");
      assertRedacted(out, DRIFT_DOTENV_KEY, "drift .env key");
      assertRedacted(out, DRIFT_TELEGRAM_SAVED, "drift config.json telegram token");
      assertRedacted(out, DRIFT_TELEGRAM_DOTENV, "drift .env telegram token");
      assertRedacted(out, DRIFT_DISCORD_SAVED, "drift config.json discord token");
      assertRedacted(out, DRIFT_DISCORD_DOTENV, "drift .env discord token");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
