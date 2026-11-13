// RunOptions.media on the wire: through the real "openai-compatible" provider
// (AI SDK OpenAI chat converter + mediaFetch), a registered marker text part
// reaches the server as a vLLM video_url / audio_url part. A local HTTP server
// records the request; no model runs.
import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { generateText } from "ai";
import { resolveModel } from "../dist/llm-providers.js";
import { registerMedia, releaseMedia, mediaPartFor, validateMedia } from "../dist/media-input.js";

async function withServer(fn) {
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
  const saved = process.env.OPENAI_COMPATIBLE_BASE_URL;
  process.env.OPENAI_COMPATIBLE_BASE_URL = `http://127.0.0.1:${server.address().port}/v1`;
  try {
    return await fn(bodies);
  } finally {
    if (saved === undefined) delete process.env.OPENAI_COMPATIBLE_BASE_URL;
    else process.env.OPENAI_COMPATIBLE_BASE_URL = saved;
    await new Promise((resolve) => server.close(resolve));
  }
}

const VIDEO = { kind: "video", data: Buffer.from("fake mp4 bytes").toString("base64"), mimeType: "video/mp4" };
const AUDIO = { kind: "audio", data: Buffer.from("fake wav bytes").toString("base64"), mimeType: "audio/wav" };

test("registered markers reach vLLM as video_url and audio_url parts; other text is untouched", async () => {
  const video = registerMedia(VIDEO);
  const audio = registerMedia(AUDIO);
  try {
    await withServer(async (bodies) => {
      const model = resolveModel("openai-compatible", "basketball");
      const { text } = await generateText({
        model,
        messages: [{ role: "user", content: [
          { type: "text", text: "Who made the shot?" },
          { type: "text", text: video },
          { type: "text", text: audio },
          { type: "text", text: "[[sportsclaw-media:00000000-0000-0000-0000-000000000000]]" },
        ] }],
      });
      assert.equal(text, "a three");
      const content = bodies[0].messages.at(-1).content;
      assert.deepEqual(content[0], { type: "text", text: "Who made the shot?" });
      assert.deepEqual(content[1], { type: "video_url", video_url: { url: `data:video/mp4;base64,${VIDEO.data}` } });
      assert.deepEqual(content[2], { type: "audio_url", audio_url: { url: `data:audio/wav;base64,${AUDIO.data}` } });
      assert.equal(content[3].type, "text", "an unknown marker stays text");
    });
  } finally {
    releaseMedia([video, audio]);
  }
  assert.equal(mediaPartFor(video), undefined, "released markers match nothing");
});

test("media is validated: kind matches mime type, base64 data, size and count limits", () => {
  assert.deepEqual(validateMedia([VIDEO, AUDIO]), [VIDEO, AUDIO]);
  for (const bad of [
    [{ ...VIDEO, mimeType: "audio/wav" }],
    [{ ...VIDEO, kind: "image" }],
    [{ ...VIDEO, data: "not base64!" }],
    [{ ...VIDEO, extra: 1 }],
    [VIDEO, VIDEO, VIDEO, VIDEO, VIDEO],
    "nope",
  ]) assert.throws(() => validateMedia(bad), /media|video|audio|base64/, JSON.stringify(bad).slice(0, 60));
});

// ---------------------------------------------------------------------------
// Still images (a crop of one player, a frame of a broadcast)
// ---------------------------------------------------------------------------
const IMAGE = { kind: "image", data: Buffer.from("fake jpeg bytes").toString("base64"), mimeType: "image/jpeg" };

test("an image attachment is valid and reaches the server as an image_url part", async () => {
  assert.deepEqual(validateMedia([IMAGE]), [IMAGE]);
  await withServer(async (bodies) => {
    const marker = registerMedia(IMAGE);
    try {
      await generateText({
        model: resolveModel("openai-compatible", "basketball"),
        messages: [{ role: "user", content: [{ type: "text", text: marker }, { type: "text", text: "What number is on the jersey?" }] }],
      });
    } finally {
      releaseMedia([marker]);
    }
    const parts = bodies[0].messages.at(-1).content;
    assert.deepEqual(parts[0], { type: "image_url", image_url: { url: `data:image/jpeg;base64,${IMAGE.data}` } });
    assert.equal(parts[1].text, "What number is on the jersey?");
  });
});

test("an image must carry an image type", () => {
  assert.throws(() => validateMedia([{ ...IMAGE, mimeType: "video/mp4" }]), /invalid image mimeType/);
  assert.throws(() => validateMedia([{ ...IMAGE, kind: "picture" }]), /invalid media kind/);
});
