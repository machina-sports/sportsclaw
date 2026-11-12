/**
 * A model role that carries video and audio (invokeModelRole `media`), with the
 * sampling limits and server options a video model needs. The request is checked
 * on the wire against a local HTTP server: what a vLLM-served sports video model
 * is sent must be exactly what a direct client would send it.
 */
import assert from "node:assert/strict";
import http from "node:http";
import { describe, it } from "node:test";

const { invokeModelRole, validateModelRoleRouterConfig } = await import("../dist/inference/model-role-router.js");

const VIDEO = { kind: "video", data: Buffer.from("mp4-bytes").toString("base64"), mimeType: "video/mp4" };
const AUDIO = { kind: "audio", data: Buffer.from("wav-bytes").toString("base64"), mimeType: "audio/wav" };
const SERVER_OPTIONS = { top_k: 1, chat_template_kwargs: { enable_thinking: false }, mm_processor_kwargs: { use_audio_in_video: false } };

/** Runs `fn(baseUrl, bodies)` against a server that records each request body and answers "a three". */
async function withModel(fn) {
  const bodies = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      bodies.push(JSON.parse(body || "{}"));
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        id: "c1", object: "chat.completion", created: 1, model: "basketball",
        choices: [{ index: 0, message: { role: "assistant", content: "a three" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}/v1`, bodies);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const eyes = (baseUrl, extra = {}) => ({ roles: { eyes: { route: "nim", model: "basketball", baseUrl, ...extra } } });

describe("a model role that carries video and audio", () => {
  it("sends one user message of media parts then the prompt, with the limits and server options", async () => {
    await withModel(async (baseUrl, bodies) => {
      const result = await invokeModelRole({
        role: "eyes", source: "benchmark", config: eyes(baseUrl, { requestBody: SERVER_OPTIONS }),
        input: "<video>\n<so_embedding>\nWhat happened on this play?",
        media: [VIDEO, AUDIO],
        sampling: { maxOutputTokens: 512, temperature: 0, topP: 1 },
      });
      assert.equal(result.output, "a three");
      assert.equal(result.trace.status, "completed");
      assert.equal(bodies.length, 1);
      const { messages, ...rest } = bodies[0];
      assert.deepEqual(messages, [{ role: "user", content: [
        { type: "video_url", video_url: { url: `data:video/mp4;base64,${VIDEO.data}` } },
        { type: "audio_url", audio_url: { url: `data:audio/wav;base64,${AUDIO.data}` } },
        { type: "text", text: "<video>\n<so_embedding>\nWhat happened on this play?" },
      ] }]);
      assert.deepEqual(rest, { model: "basketball", max_tokens: 512, temperature: 0, top_p: 1, ...SERVER_OPTIONS });
    });
  });

  it("a call with no media is unchanged: the prompt alone, no extra fields", async () => {
    await withModel(async (baseUrl, bodies) => {
      await invokeModelRole({ role: "eyes", source: "benchmark", config: eyes(baseUrl), input: "Say hi." });
      assert.deepEqual(bodies[0].messages, [{ role: "user", content: "Say hi." }]);
      assert.deepEqual(Object.keys(bodies[0]).sort(), ["messages", "model"]);
    });
  });

  it("refuses bad media before any request", async () => {
    await withModel(async (baseUrl, bodies) => {
      await assert.rejects(
        invokeModelRole({ role: "eyes", source: "benchmark", config: eyes(baseUrl), input: "x", media: [{ ...VIDEO, data: "not base64!" }] }),
        /video data must be base64/,
      );
      assert.equal(bodies.length, 0);
    });
  });

  it("refuses server options that would replace the request itself, or that no route would send", () => {
    for (const key of ["model", "messages", "stream", "tools", "tool_choice"]) {
      const check = validateModelRoleRouterConfig(eyes("http://127.0.0.1:1/v1", { requestBody: { [key]: 1 } }));
      assert.equal(check.ok, false, key);
      assert.match(check.error, /requestBody/);
    }
    assert.equal(validateModelRoleRouterConfig(eyes("http://127.0.0.1:1/v1", { requestBody: ["top_k"] })).ok, false, "not an object");
    assert.equal(validateModelRoleRouterConfig({ roles: { eyes: { route: "mock", model: "m", requestBody: { top_k: 1 } } } }).ok, false, "only nim routes send it");
    assert.equal(validateModelRoleRouterConfig(eyes("http://127.0.0.1:1/v1", { requestBody: SERVER_OPTIONS })).ok, true);
  });
});

describe("a model role call with a system prompt", () => {
  const writer = (baseUrl) => ({ roles: { writer: { route: "nim", model: "basketball", baseUrl } } });

  it("sends it as the system message before the prompt", async () => {
    await withModel(async (baseUrl, bodies) => {
      await invokeModelRole({ role: "writer", source: "benchmark", config: writer(baseUrl), system: "Write one line per beat.", input: "Beat 1: Curry ties it." });
      assert.deepEqual(bodies[0].messages, [
        { role: "system", content: "Write one line per beat." },
        { role: "user", content: "Beat 1: Curry ties it." },
      ]);
    });
  });

  it("sends it before the media message too", async () => {
    await withModel(async (baseUrl, bodies) => {
      await invokeModelRole({ role: "eyes", source: "benchmark", config: eyes(baseUrl), system: "Answer in one sentence.", input: "What happened?", media: [VIDEO] });
      assert.equal(bodies[0].messages.length, 2);
      assert.deepEqual(bodies[0].messages[0], { role: "system", content: "Answer in one sentence." });
      assert.equal(bodies[0].messages[1].role, "user");
    });
  });

  it("sends no system message when none is given", async () => {
    await withModel(async (baseUrl, bodies) => {
      await invokeModelRole({ role: "writer", source: "benchmark", config: writer(baseUrl), input: "x" });
      assert.deepEqual(bodies[0].messages.map((m) => m.role), ["user"]);
    });
  });

  it("refuses a system prompt that is not text", async () => {
    await assert.rejects(invokeModelRole({ role: "writer", source: "benchmark", config: { roles: { writer: { route: "mock", model: "m" } } }, system: 5, input: "x" }), /system/);
  });
});
