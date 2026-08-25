/**
 * Relay provider → API-key env mapping contract
 *
 * `_build_env` in the relay server translates a per-request `api_key` into the
 * environment variable the engine reads for the active provider. That mapping
 * duplicates `PROVIDER_ENV` in src/config.ts, and the two had already drifted:
 * the relay knew anthropic, openai and google, but not azure-foundry, so an
 * azure-foundry request carrying `api_key` wrote the caller's key to
 * ANTHROPIC_API_KEY. The run then authenticated with the wrong credential —
 * or silently reused an unrelated one — instead of failing.
 *
 * The expectation is derived from the engine source rather than restated here,
 * so adding a provider to src/config.ts without teaching the relay about it
 * fails this test instead of shipping a misrouted credential.
 */

import assert from "node:assert/strict";
import { describe, it, before } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const relayServerPath = join(repoRoot, "docker/relay/relay_server.py");
const configPath = join(repoRoot, "src/config.ts");

let relayServer;
let engineProviders;

before(() => {
  relayServer = readFileSync(relayServerPath, "utf8");

  // PROVIDER_ENV in src/config.ts is the single source of truth.
  const block = readFileSync(configPath, "utf8").match(
    /export const PROVIDER_ENV: Record<LLMProvider, string> = \{([\s\S]*?)\};/
  );
  assert.ok(block, "PROVIDER_ENV not found in src/config.ts");

  engineProviders = new Map(
    [...block[1].matchAll(/"?([a-z-]+)"?\s*:\s*"([A-Z0-9_]+)"/g)].map((m) => [m[1], m[2]])
  );
  assert.ok(engineProviders.size >= 4, "expected at least four providers in PROVIDER_ENV");
});

describe("relay provider key map", () => {
  it("covers every provider the engine knows, with the same env var", () => {
    const keyMap = relayServer.match(/key_map = \{([\s\S]*?)\}/);
    assert.ok(keyMap, "key_map not found in _build_env");

    const relayProviders = new Map(
      [...keyMap[1].matchAll(/"([a-z-]+)"\s*:\s*"([A-Z0-9_]+)"/g)].map((m) => [m[1], m[2]])
    );

    for (const [provider, envVar] of engineProviders) {
      assert.equal(
        relayProviders.get(provider),
        envVar,
        `relay key_map must map ${provider} to ${envVar} (see PROVIDER_ENV in src/config.ts)`
      );
    }
  });

  it("rejects an unknown provider instead of defaulting to a real credential", () => {
    // The previous `key_map.get(provider, "ANTHROPIC_API_KEY")` turned any
    // unrecognised provider into an Anthropic credential write.
    assert.doesNotMatch(
      relayServer,
      /key_map\.get\(provider,\s*"ANTHROPIC_API_KEY"\)/,
      "unknown providers must not fall back to ANTHROPIC_API_KEY"
    );
    assert.match(
      relayServer,
      /unsupported provider for api_key override/,
      "an unknown provider should surface an explicit error"
    );
  });
});
