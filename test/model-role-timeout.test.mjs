/**
 * A hosted (`api`) model route always has a request timeout: 300 s when the role sets
 * none, the role's own timeoutMs when it does. A timed-out call fails once (no hidden
 * retries) with a message that names the role and the limit, so a host can show it.
 */
import assert from "node:assert/strict";
import http from "node:http";
import { describe, it } from "node:test";

const { invokeModelRole, resolveNativeRoleEndpoint } = await import("../dist/inference/model-role-router.js");

const api = (extra = {}) => ({ route: "api", model: "m", baseUrl: "https://api.example.com/v1", credentialEnv: "SC_TIMEOUT_TEST_KEY", ...extra });
const env = { SC_TIMEOUT_TEST_KEY: "synthetic-key-0123456789" };

describe("model route timeouts", () => {
  it("gives an api route 300 s when the role sets no timeoutMs, and keeps an explicit one", () => {
    assert.equal(resolveNativeRoleEndpoint(api(), env).timeoutMs, 300_000);
    assert.equal(resolveNativeRoleEndpoint(api({ timeoutMs: 1234 }), env).timeoutMs, 1234);
  });

  it("leaves a keyless nim route as it was", () => {
    assert.equal(resolveNativeRoleEndpoint({ route: "nim", model: "m", baseUrl: "http://127.0.0.1:9/v1" }, env).timeoutMs, undefined);
  });

  it("fails a hung call once, naming the role and the limit", async () => {
    let requests = 0;
    const server = http.createServer(() => { requests++; /* never answers */ });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    process.env.SC_TIMEOUT_TEST_KEY = env.SC_TIMEOUT_TEST_KEY;
    try {
      const config = { roles: { writer: api({ baseUrl: `http://127.0.0.1:${server.address().port}/v1`, timeoutMs: 200 }) } };
      const started = Date.now();
      await assert.rejects(
        invokeModelRole({ role: "writer", source: "benchmark", input: "Say ready.", config }),
        (err) => {
          assert.match(err.message, /"writer"/);
          assert.match(err.message, /timed out after 200 ms/);
          return true;
        },
      );
      assert.ok(Date.now() - started < 5000);
      assert.equal(requests, 1, "a timeout is not retried behind the caller's back");
    } finally {
      delete process.env.SC_TIMEOUT_TEST_KEY;
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
