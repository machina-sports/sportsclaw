/**
 * The engine's chat model can be the `brain` role: `inference.roles.brain` in the engine
 * config names the route, as it does for an operator job. The request is checked on the
 * wire against a stand-in server. No live calls, no credentials.
 */
import assert from "node:assert/strict";
import http from "node:http";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

const root = mkdtempSync(join(tmpdir(), "sportsclaw-brain-role-"));
for (const dir of ["memory", "schemas", "agents", "sessions"]) mkdirSync(join(root, dir), { recursive: true });
Object.assign(process.env, {
  HOME: root,
  SPORTSCLAW_MEMORY_DIR: join(root, "memory"),
  sportsclaw_SCHEMA_DIR: join(root, "schemas"),
  SPORTSCLAW_AGENTS_DIR: join(root, "agents"),
  SPORTSCLAW_SESSION_DIR: join(root, "sessions"),
  SPORTSCLAW_MEMORY_PROVIDER: "file",
});
for (const key of ["SPORTSCLAW_SKILLS", "sportsclaw_SKILLS", "SPORTSCLAW_MEMORY_BACKEND", "HINDSIGHT_BASE_URL"]) delete process.env[key];
globalThis.AI_SDK_LOG_WARNINGS = false;

const { sportsclawEngine } = await import("../dist/engine.js");
after(() => rmSync(root, { recursive: true, force: true }));

async function withModel(fn) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requests.push({ url: req.url, authorization: req.headers.authorization, body: JSON.parse(body || "{}") });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        id: "c1", object: "chat.completion", created: 1, model: "brain-model",
        choices: [{ index: 0, message: { role: "assistant", content: "Hello from the brain." }, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}/v1`, requests);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const withBrain = (brain) => new sportsclawEngine({ thinkingBudget: 0, inference: { roles: { brain } } });

describe("the engine's chat model as the brain role", () => {
  it("sends chat to the role's endpoint and model, with its server options", async () => {
    await withModel(async (baseUrl, requests) => {
      const engine = withBrain({ route: "nim", model: "brain-model", baseUrl, requestBody: { top_k: 1 } });
      assert.equal(engine.mainModelId, "brain-model");
      const text = await engine.run("Say hello.");
      assert.equal(text, "Hello from the brain.");
      const chat = requests.filter((r) => r.url === "/v1/chat/completions");
      assert.ok(chat.length >= 1);
      assert.ok(chat.every((r) => r.body.model === "brain-model" && r.body.top_k === 1));
    });
  });

  it("reads a hosted route's key from the variable the role names", async () => {
    await withModel(async (baseUrl, requests) => {
      process.env.BRAIN_ROLE_TEST_KEY = "test-key";
      try {
        const engine = withBrain({ route: "api", model: "brain-model", baseUrl, credentialEnv: "BRAIN_ROLE_TEST_KEY" });
        await engine.run("Say hello.");
        assert.ok(requests.every((r) => r.authorization === "Bearer test-key"));
      } finally {
        delete process.env.BRAIN_ROLE_TEST_KEY;
      }
    });
  });

  it("stops a hung brain call at its timeout, naming the role and the limit", async () => {
    let requests = 0;
    const server = http.createServer(() => { requests++; /* never answers */ });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    process.env.BRAIN_ROLE_TEST_KEY = "test-key";
    try {
      const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
      const engine = withBrain({ route: "api", model: "brain-model", baseUrl, credentialEnv: "BRAIN_ROLE_TEST_KEY", timeoutMs: 200 });
      await assert.rejects(engine.run("Say hello."), /Role "brain": model call timed out after 200 ms/);
      assert.equal(requests, 1, "a timeout is not retried");
    } finally {
      delete process.env.BRAIN_ROLE_TEST_KEY;
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("retries the main call on a real 5xx status only, not on any number that starts with 5", async () => {
    const answering = async (status, message, fn, extra = {}) => {
      let requests = 0;
      const server = http.createServer((req, res) => {
        requests++;
        req.resume();
        req.on("end", () => {
          res.statusCode = status;
          res.setHeader("content-type", "application/json");
          res.setHeader("retry-after-ms", "0");
          res.end(JSON.stringify({ error: { message, type: "invalid_request_error" } }));
        });
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        const engine = withBrain({ route: "nim", model: "brain-model", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, ...extra });
        await assert.rejects(engine.run("Say hello."), fn);
        return requests;
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    };
    // A 400 whose text holds 512: one request, no retry.
    assert.equal(await answering(400, "top_k 512 is out of range", /512/), 1);
    // A 503 whose text holds no number: the SDK's 3 attempts, then the engine's 2 retries.
    assert.equal(await answering(503, "upstream overloaded", /overloaded/), 9);
  });

  it("does not retry a timeout whose limit merely contains 500", async () => {
    let requests = 0;
    const server = http.createServer(() => { requests++; /* never answers */ });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
      const engine = withBrain({ route: "nim", model: "brain-model", baseUrl, timeoutMs: 1500 });
      await assert.rejects(engine.run("Say hello."), /timed out after 1500 ms/);
      assert.equal(requests, 1);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("refuses a brain role that cannot chat or is not valid", () => {
    assert.throws(() => withBrain({ route: "mock", model: "m" }), /brain.*mock/);
    assert.throws(() => withBrain({ route: "nim", baseUrl: "http://127.0.0.1:1/v1" }), /model/);
    assert.throws(() => withBrain({ route: "api", model: "m", baseUrl: "https://x.example/v1", credentialEnv: "BRAIN_ROLE_UNSET_KEY" }), /BRAIN_ROLE_UNSET_KEY is not set/);
  });

  it("leaves the engine on its provider when no brain role is configured", () => {
    process.env.OPENAI_COMPATIBLE_BASE_URL = "http://127.0.0.1:1/v1";
    try {
      const engine = new sportsclawEngine({ thinkingBudget: 0, provider: "openai-compatible", model: "m", inference: { roles: {} } });
      assert.equal(engine.mainModelId, "m");
    } finally {
      delete process.env.OPENAI_COMPATIBLE_BASE_URL;
    }
  });
});
