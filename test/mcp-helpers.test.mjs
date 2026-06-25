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

import {
  mcpEnvKey,
  isValidMcpServerName,
  envKeyCollision,
  validateConnectBundle,
} from "../dist/mcp.js";

describe("mcpEnvKey", () => {
  it("uppercases and converts hyphens to underscores", () => {
    assert.equal(mcpEnvKey("my-pod"), "SPORTSCLAW_MCP_TOKEN_MY_POD");
  });

  it("leaves underscore/alphanumeric names intact", () => {
    assert.equal(mcpEnvKey("pod_1"), "SPORTSCLAW_MCP_TOKEN_POD_1");
  });

  it("produces the documented key shape (the resolveTokens contract)", () => {
    assert.equal(mcpEnvKey("acme-feed"), "SPORTSCLAW_MCP_TOKEN_ACME_FEED");
  });
});

describe("envKeyCollision", () => {
  it("flags a different name that folds to the same env-key", () => {
    const configs = { "my-pod": { url: "https://a" } };
    assert.equal(envKeyCollision("my_pod", configs), "my-pod");
    assert.equal(envKeyCollision("MY-POD", configs), "my-pod");
  });

  it("does not flag the same name (reconnect is not a collision)", () => {
    const configs = { "my-pod": { url: "https://a" } };
    assert.equal(envKeyCollision("my-pod", configs), null);
  });

  it("returns null when no existing name shares the slot", () => {
    const configs = { "other-pod": { url: "https://a" } };
    assert.equal(envKeyCollision("my-pod", configs), null);
  });
});

describe("validateConnectBundle", () => {
  const good = {
    name: "nba-premium",
    url: "https://pod.machina.gg/mcp/sse",
    token: "sk_live_abc123",
    auth_header: "X-Api-Token",
    durable: true,
  };

  it("accepts a well-formed https bundle and normalizes it", () => {
    const r = validateConnectBundle(good, {});
    assert.equal(r.ok, true);
    assert.deepEqual(r, {
      ok: true,
      name: "nba-premium",
      url: "https://pod.machina.gg/mcp/sse",
      token: "sk_live_abc123",
      durable: true,
    });
  });

  it("allows http only for a loopback dev pod", () => {
    assert.equal(validateConnectBundle({ ...good, url: "http://localhost:8080/mcp/sse" }, {}).ok, true);
    const remote = validateConnectBundle({ ...good, url: "http://pod.machina.gg/mcp/sse" }, {});
    assert.equal(remote.ok, false);
    assert.match(remote.error, /non-HTTPS/i);
  });

  it("rejects a null bundle or a CLI error bundle", () => {
    assert.match(validateConnectBundle(null, {}).error, /Could not connect/);
    assert.match(validateConnectBundle({ error: "no session" }, {}).error, /no session/);
  });

  it("rejects non-string / missing name or url (no coercion)", () => {
    assert.equal(validateConnectBundle({ ...good, name: 42 }, {}).ok, false);
    assert.equal(validateConnectBundle({ ...good, url: undefined }, {}).ok, false);
  });

  it("rejects an unparseable url", () => {
    assert.match(validateConnectBundle({ ...good, url: "not a url" }, {}).error, /unparseable/i);
  });

  it("rejects a missing token with a reveal hint", () => {
    const r = validateConnectBundle({ ...good, token: null }, {});
    assert.equal(r.ok, false);
    assert.match(r.hint, /--reveal/);
  });

  it("rejects a path-traversal pod name", () => {
    assert.equal(validateConnectBundle({ ...good, name: "../etc/passwd" }, {}).ok, false);
  });

  it("rejects a token containing a newline (dotenv injection guard)", () => {
    assert.match(validateConnectBundle({ ...good, token: "abc\nINJECTED=1" }, {}).error, /newline/i);
  });

  it("rejects a non-X-Api-Token auth header with an upgrade hint", () => {
    const r = validateConnectBundle({ ...good, auth_header: "Authorization" }, {});
    assert.equal(r.ok, false);
    assert.match(r.hint, /upgrade/i);
  });

  it("rejects a name that collides with an existing token slot", () => {
    const r = validateConnectBundle({ ...good, name: "nba_premium" }, { "nba-premium": { url: "https://x" } });
    assert.equal(r.ok, false);
    assert.match(r.error, /token slot/);
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
