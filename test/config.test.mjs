/**
 * Persistent config resolution — no-network tests.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function runResolveConfigWithHome(home, extraEnv = {}) {
  const stdout = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "const { resolveConfig } = await import('./dist/config.js'); console.log(JSON.stringify(resolveConfig()));",
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: home,
        ...extraEnv,
      },
      encoding: "utf-8",
    },
  );
  return JSON.parse(stdout);
}

function runCliWithHome(cliArgs, home, extraEnv = {}) {
  const env = {
    ...process.env,
    HOME: home,
    ...extraEnv,
  };
  // Strip shell-level provider/Foundry values so only HOME-persisted config counts.
  for (const key of [
    "AZURE_FOUNDRY_BASE_URL",
    "AZURE_FOUNDRY_API_MODE",
    "AZURE_FOUNDRY_AUTH_MODE",
    "AZURE_FOUNDRY_API_KEY",
    "SPORTSCLAW_PROVIDER",
    "SPORTSCLAW_MODEL",
  ]) {
    delete env[key];
  }

  try {
    return execFileSync(process.execPath, ["dist/index.js", ...cliArgs], {
      cwd: process.cwd(),
      env,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    // `health --json` exits 1 when status is "down" — the payload is still on stdout.
    if (typeof err.stdout === "string" && err.stdout.length > 0) return err.stdout;
    throw err;
  }
}

describe("CLI config preflight", () => {
  it("loads ~/.sportsclaw/.env before running `health --json`", () => {
    const home = mkdtempSync(join(tmpdir(), "sportsclaw-preflight-"));
    try {
      const dir = join(home, ".sportsclaw");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "config.json"),
        JSON.stringify({ provider: "azure-foundry", model: "gpt-5.2" }, null, 2),
      );
      writeFileSync(
        join(dir, ".env"),
        [
          "AZURE_FOUNDRY_BASE_URL=https://fake-foundry.invalid/openai/v1",
          "AZURE_FOUNDRY_API_MODE=responses",
          "AZURE_FOUNDRY_AUTH_MODE=entra_id",
          "",
        ].join("\n"),
      );

      const stdout = runCliWithHome(["health", "--json"], home);
      const payload = JSON.parse(stdout);

      assert.strictEqual(payload.config.provider, "azure-foundry");
      assert.strictEqual(payload.config.azureFoundryBaseUrlConfigured, true);
      assert.strictEqual(payload.config.azureFoundryAuthMode, "entra_id");
      assert.deepStrictEqual(
        payload.errors.filter((e) => e.includes("AZURE_FOUNDRY_BASE_URL")),
        [],
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("resolveConfig", () => {
  it("does not reuse a persisted API key when SPORTSCLAW_PROVIDER overrides the persisted provider", () => {
    const home = mkdtempSync(join(tmpdir(), "sportsclaw-config-"));
    try {
      const dir = join(home, ".sportsclaw");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "config.json"),
        JSON.stringify(
          {
            provider: "google",
            model: "gemini-3.5-flash",
            apiKey: "google-key-should-not-leak",
          },
          null,
          2,
        ),
      );

      const resolved = runResolveConfigWithHome(home, {
        SPORTSCLAW_PROVIDER: "azure-foundry",
        AZURE_FOUNDRY_BASE_URL: "https://example.openai.azure.com/openai/v1",
        AZURE_FOUNDRY_AUTH_MODE: "entra_id",
        AZURE_FOUNDRY_API_KEY: "",
      });

      assert.strictEqual(resolved.provider, "azure-foundry");
      assert.strictEqual(resolved.apiKey, undefined);
      assert.strictEqual(resolved.model, "gpt-5.2");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("uses the persisted API key when the persisted provider is still active", () => {
    const home = mkdtempSync(join(tmpdir(), "sportsclaw-config-"));
    try {
      const dir = join(home, ".sportsclaw");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "config.json"),
        JSON.stringify(
          {
            provider: "azure-foundry",
            model: "gpt-5.2",
            apiKey: "azure-key",
          },
          null,
          2,
        ),
      );

      const resolved = runResolveConfigWithHome(home, {
        AZURE_FOUNDRY_BASE_URL: "https://example.openai.azure.com/openai/v1",
        AZURE_FOUNDRY_API_KEY: "",
      });

      assert.strictEqual(resolved.provider, "azure-foundry");
      assert.strictEqual(resolved.apiKey, "azure-key");
      assert.strictEqual(resolved.model, "gpt-5.2");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
