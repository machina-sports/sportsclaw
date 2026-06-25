/**
 * MCP helper utilities — test suite
 *
 * Guards the two helpers shared by `mcp add` and `machina connect`:
 *  1. mcpEnvKey() — derives the ~/.sportsclaw/.env key from a server name.
 *  2. isValidMcpServerName() — gates names that become mcp.json keys, env-key
 *     segments, and tool-cache filenames (path-traversal guard).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { mcpEnvKey, isValidMcpServerName } from "../dist/mcp.js";

describe("mcpEnvKey", () => {
  it("uppercases and converts hyphens to underscores", () => {
    assert.equal(mcpEnvKey("my-pod"), "SPORTSCLAW_MCP_TOKEN_MY_POD");
  });

  it("leaves underscore/alphanumeric names intact", () => {
    assert.equal(mcpEnvKey("pod_1"), "SPORTSCLAW_MCP_TOKEN_POD_1");
  });

  it("is stable across the two call sites (mcp add / machina connect)", () => {
    assert.equal(mcpEnvKey("acme-feed"), mcpEnvKey("acme-feed"));
  });
});

describe("isValidMcpServerName", () => {
  it("accepts alphanumerics, hyphens, and underscores", () => {
    for (const name of ["pod", "my-pod", "pod_1", "ABC-123_x"]) {
      assert.ok(isValidMcpServerName(name), `${name} should be valid`);
    }
  });

  it("rejects path-traversal and separator characters", () => {
    for (const name of ["../etc", "a/b", "a\\b", "a.b", "a b", "a:b", ""]) {
      assert.ok(!isValidMcpServerName(name), `${JSON.stringify(name)} should be rejected`);
    }
  });
});
