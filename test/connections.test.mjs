/**
 * Connection-Brokered Auth & Sandbox Environment — Test Suite
 *
 * Verifies that:
 *  1. Sensitive keys (ANTHROPIC_API_KEY, DISCORD_BOT_TOKEN, etc.) are always stripped from sandbox environments.
 *  2. Safe keys (PATH, HOME, USER, etc.) are retained in sandbox environments.
 *  3. Credentials for named connections are correctly resolved and injected.
 *  4. Fallback resolution works for standard connection defaults.
 */

import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { ConnectionManager, SENSITIVE_PROCESS_KEYS, SAFE_ENV_KEYS } from "../dist/connections.js";

describe("ConnectionManager & Sandbox Environment", () => {
  let originalEnv = {};

  beforeEach(() => {
    // Backup original environment
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    // Restore original environment
    process.env = { ...originalEnv };
  });

  it("should strip highly sensitive keys from sandbox environment by default", () => {
    // Set some sensitive process keys
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-key-12345";
    process.env.DISCORD_BOT_TOKEN = "test-discord-bot-token-67890";
    process.env.OPENAI_API_KEY = "sk-proj-openai-test-key";

    // Set some safe keys
    process.env.PATH = "/usr/bin:/bin";
    process.env.HOME = "/Users/test";

    const manager = new ConnectionManager();
    const sandboxEnv = manager.getSandboxEnv();

    // Verify sensitive keys are stripped
    for (const key of SENSITIVE_PROCESS_KEYS) {
      assert.strictEqual(sandboxEnv[key], undefined, `Sensitive key ${key} must be stripped from sandbox env`);
    }

    // Verify safe keys are kept
    assert.strictEqual(sandboxEnv.PATH, "/usr/bin:/bin");
    assert.strictEqual(sandboxEnv.HOME, "/Users/test");
  });

  it("should securely broker and inject credentials for default connections", () => {
    // Mock the credentials in parent process.env
    process.env.POLYMARKET_API_KEY = "poly-key-abc";
    process.env.POLYMARKET_SECRET = "poly-secret-xyz";
    process.env.POLYMARKET_PASSPHRASE = "poly-passphrase-123";
    
    // Also set a sensitive process key to ensure it gets stripped at the same time
    process.env.ANTHROPIC_API_KEY = "should-be-removed";

    const manager = new ConnectionManager();
    const sandboxEnv = manager.getSandboxEnv("polymarket");

    // Verify sensitive key is stripped
    assert.strictEqual(sandboxEnv.ANTHROPIC_API_KEY, undefined);

    // Verify connection credentials are fully resolved and injected
    assert.strictEqual(sandboxEnv.POLYMARKET_API_KEY, "poly-key-abc");
    assert.strictEqual(sandboxEnv.POLYMARKET_SECRET, "poly-secret-xyz");
    assert.strictEqual(sandboxEnv.POLYMARKET_PASSPHRASE, "poly-passphrase-123");
  });

  it("should support fallback lookup for standard connection names case-insensitively", () => {
    process.env.KALSHI_API_KEY = "kalshi-key-abc";
    process.env.KALSHI_SECRET = "kalshi-secret-xyz";

    const manager = new ConnectionManager();
    const sandboxEnv = manager.getSandboxEnv("KaLsHi");

    assert.strictEqual(sandboxEnv.KALSHI_API_KEY, "kalshi-key-abc");
    assert.strictEqual(sandboxEnv.KALSHI_SECRET, "kalshi-secret-xyz");
  });

  it("should support customized connection definitions with env mapping", () => {
    // Write a temporary local connections.json in the current working directory to test custom configuration
    const customConfig = {
      "custom-odds-provider": {
        type: "http",
        envMapping: {
          ODDS_KEY: "env:MY_CUSTOM_SECRET_KEY",
          LITERAL_KEY: "my-literal-value"
        }
      }
    };

    const configPath = path.join(process.cwd(), "connections.json");
    fs.writeFileSync(configPath, JSON.stringify(customConfig, null, 2));

    try {
      process.env.MY_CUSTOM_SECRET_KEY = "custom-odds-key-value";

      const manager = new ConnectionManager(true);
      const sandboxEnv = manager.getSandboxEnv("custom-odds-provider");

      // Verify custom mapped env variables are resolved and injected
      assert.strictEqual(sandboxEnv.ODDS_KEY, "custom-odds-key-value");
      assert.strictEqual(sandboxEnv.LITERAL_KEY, "my-literal-value");
      assert.strictEqual(sandboxEnv.MY_CUSTOM_SECRET_KEY, undefined, "Source key should not be exposed directly if not in safe keys");
    } finally {
      // Clean up local connections.json
      if (fs.existsSync(configPath)) {
        fs.unlinkSync(configPath);
      }
    }
  });
});
