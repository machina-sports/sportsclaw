/**
 * The `api` route: a model role on a hosted OpenAI-compatible service that needs a key.
 * The config names the environment variable that holds the key; the key itself is never
 * in config, in an error or in a trace. Checked against a local HTTP server.
 */
import assert from "node:assert/strict";
import http from "node:http";
import { describe, it } from "node:test";

const { invokeModelRole, validateModelRoleRouterConfig } = await import("../dist/inference/model-role-router.js");

const KEY = "synthetic-key-0123456789";
const VIDEO = { kind: "video", data: Buffer.from("mp4-bytes").toString("base64"), mimeType: "video/mp4" };

/** Runs `fn(baseUrl, requests)` against a server recording each request; answers "ready", or the given status. */
async function withService(fn, status = 200) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requests.push({ authorization: req.headers.authorization, body: JSON.parse(body || "{}") });
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(status === 200
        ? { id: "c1", object: "chat.completion", created: 1, model: "hosted-vision",
            choices: [{ index: 0, message: { role: "assistant", content: "ready" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } }
        : { error: { message: "invalid api key", type: "authentication_error" } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.SC_TEST_ROLE_KEY = KEY;
  try {
    return await fn(`http://127.0.0.1:${server.address().port}/v1`, requests);
  } finally {
    delete process.env.SC_TEST_ROLE_KEY;
    await new Promise((resolve) => server.close(resolve));
  }
}

const hosted = (baseUrl, extra = {}) => ({ roles: { eyes: { route: "api", model: "hosted-vision", baseUrl, credentialEnv: "SC_TEST_ROLE_KEY", ...extra } } });
const call = (config, extra = {}) => invokeModelRole({ role: "eyes", source: "benchmark", input: "Say ready.", config, ...extra });

describe("a model role on a hosted service that needs a key", () => {
  it("sends the key from the named environment variable, and reports the route", async () => {
    await withService(async (baseUrl, requests) => {
      const result = await call(hosted(baseUrl));
      assert.equal(result.output, "ready");
      assert.equal(result.trace.route, "api");
      assert.equal(result.trace.status, "completed");
      assert.equal(requests[0].authorization, `Bearer ${KEY}`);
      assert.equal(requests[0].body.model, "hosted-vision");
    });
  });

  it("carries media and server options like a local route does", async () => {
    await withService(async (baseUrl, requests) => {
      await call(hosted(baseUrl, { requestBody: { top_k: 1 } }), { media: [VIDEO], sampling: { maxOutputTokens: 64 } });
      const { body } = requests[0];
      assert.deepEqual(body.messages[0].content.map((p) => p.type), ["video_url", "text"]);
      assert.deepEqual([body.top_k, body.max_tokens], [1, 64]);
    });
  });

  it("fails before any request when the variable is unset or not a usable key, naming the variable only", async () => {
    await withService(async (baseUrl, requests) => {
      delete process.env.SC_TEST_ROLE_KEY;
      await assert.rejects(call(hosted(baseUrl)), /SC_TEST_ROLE_KEY is not set/);
      process.env.SC_TEST_ROLE_KEY = "has a space";
      await assert.rejects(call(hosted(baseUrl)), (err) => /SC_TEST_ROLE_KEY/.test(err.message) && !err.message.includes("has a space"));
      assert.equal(requests.length, 0);
    });
  });

  it("never puts the key in an error or a trace", async () => {
    await withService(async (baseUrl) => {
      await assert.rejects(call(hosted(baseUrl)), (err) => {
        assert.equal(err.trace.status, "failed");
        assert.ok(!JSON.stringify({ message: err.message, trace: err.trace }).includes(KEY));
        return true;
      });
    }, 401);
  });

  it("requires an endpoint and a variable name, and refuses to send a key over plain HTTP to another machine", () => {
    const check = (extra, omit = []) => {
      const route = { route: "api", model: "m", baseUrl: "https://api.example.com/v1", credentialEnv: "SOME_KEY", ...extra };
      for (const key of omit) delete route[key];
      return validateModelRoleRouterConfig({ roles: { eyes: route } });
    };
    assert.equal(check({}).ok, true);
    assert.equal(check({ baseUrl: "http://127.0.0.1:8000/v1" }).ok, true, "loopback may be plain HTTP");
    assert.match(check({}, ["baseUrl"]).error, /baseUrl/);
    assert.match(check({}, ["credentialEnv"]).error, /credentialEnv/);
    assert.match(check({ credentialEnv: "sk-live-abc123" }).error, /name of an environment variable/);
    assert.match(check({ baseUrl: "http://api.example.com/v1" }).error, /https/);
    assert.match(check({ credentialless: true }).error, /credentialless/);
    // The keyless local route still takes no key.
    assert.match(validateModelRoleRouterConfig({ roles: { eyes: { route: "nim", model: "m", credentialEnv: "SOME_KEY" } } }).error, /credentialEnv/);
  });
});
