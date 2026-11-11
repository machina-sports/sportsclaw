/**
 * Speech: text in, WAV audio out, on a route chosen in config.
 *
 * `inference.speech` uses the same routes as the model roles (`nim` for a server you run,
 * `api` for a hosted service with a key, `mock` for tests) and a `format` that names the
 * service's request shape. Every test talks to a stand-in HTTP server on loopback:
 * no live calls, no credentials.
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";
import { validateModelRoleRouterConfig } from "../dist/inference/model-role-router.js";
import { SPEECH_LIMITS, SpeechRouteError, speechText, synthesizeSpeech } from "../dist/inference/speech.js";
import * as sdk from "../dist/index.js";

/** A mono 16-bit WAV of the given length. */
function wav(ms, rate = 22050) {
  const samples = Math.round((rate * ms) / 1000);
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + samples * 2, 4);
  buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(samples * 2, 40);
  return buf;
}

/** Stand-in speech service. `respond(req, body)` returns {status, type, body, delayMs}. */
let server;
let base;
let requests;
let respond;

before(async () => {
  server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      const out = respond(req, body);
      setTimeout(() => {
        res.writeHead(out.status ?? 200, { "content-type": out.type ?? "audio/wav" });
        res.end(out.body);
      }, out.delayMs ?? 0);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}/v1`;
});

after(() => server.close());

function reset(handler = () => ({ body: wav(1000) })) {
  requests = [];
  respond = handler;
}

const riva = (extra = {}) => ({
  roles: {},
  speech: { route: "nim", format: "riva", voice: "Magpie-Multilingual.EN-US.Jason", baseUrl: base, ...extra },
});

const openai = (extra = {}) => ({
  roles: {},
  speech: { route: "api", format: "openai", model: "gpt-4o-mini-tts", voice: "alloy", baseUrl: base, credentialEnv: "SPEECH_TEST_KEY", ...extra },
});

const ENV = { SPEECH_TEST_KEY: "test-key" };

describe("speech config", () => {
  const check = (speech) => validateModelRoleRouterConfig({ roles: {}, speech });

  it("accepts a server you run, a hosted service and the mock", () => {
    assert.deepEqual(check({ route: "nim", format: "riva", voice: "Magpie-Multilingual.EN-US.Jason", baseUrl: "http://10.0.0.5:9000/v1" }), { ok: true });
    assert.deepEqual(check({ route: "api", format: "openai", model: "gpt-4o-mini-tts", voice: "alloy", baseUrl: "https://api.openai.com/v1", credentialEnv: "OPENAI_API_KEY" }), { ok: true });
    assert.deepEqual(check({ route: "mock", voice: "any" }), { ok: true });
  });

  it("stays optional", () => {
    assert.deepEqual(validateModelRoleRouterConfig({ roles: {} }), { ok: true });
  });

  it("names the routes and formats it knows", () => {
    assert.match(check({ route: "openshell", format: "riva", voice: "v", baseUrl: base }).error, /nim, api, mock/);
    assert.match(check({ route: "nim", format: "elevenlabs", voice: "v", baseUrl: base }).error, /riva, openai/);
  });

  it("needs a voice, an endpoint, and a model where the format takes one", () => {
    assert.match(check({ route: "nim", format: "riva", baseUrl: base }).error, /voice/);
    assert.match(check({ route: "nim", format: "riva", voice: "v" }).error, /baseUrl/);
    assert.match(check({ route: "nim", format: "openai", voice: "v", baseUrl: base }).error, /model/);
  });

  it("takes a hosted service's key by variable name, over https", () => {
    const hosted = { route: "api", format: "openai", model: "m", voice: "v", baseUrl: "https://speech.example.com/v1" };
    assert.match(check(hosted).error, /credentialEnv/);
    assert.match(check({ ...hosted, credentialEnv: "sk-not-a-variable-name" }).error, /credentialEnv/);
    assert.match(check({ ...hosted, credentialEnv: "SPEECH_KEY", baseUrl: "http://speech.example.com/v1" }).error, /https/);
    assert.deepEqual(check({ ...hosted, credentialEnv: "SPEECH_KEY", baseUrl: "http://127.0.0.1:9000/v1" }), { ok: true });
  });

  it("refuses a key variable on a keyless route and any field it does not know", () => {
    assert.match(check({ route: "nim", format: "riva", voice: "v", baseUrl: base, credentialEnv: "SPEECH_KEY" }).error, /credentialEnv/);
    assert.match(check({ route: "nim", format: "riva", voice: "v", baseUrl: base, apiKey: "not-a-real-key" }).error, /apiKey/);
  });
});

describe("synthesizeSpeech on a Riva (Magpie) server", () => {
  it("posts the text, voice and language as a form and returns the WAV", async () => {
    reset();
    const result = await synthesizeSpeech({ text: "Curry ties it with seven seconds left.", config: riva() });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, "POST");
    assert.equal(requests[0].url, "/v1/audio/synthesize");
    assert.match(requests[0].headers["content-type"], /^multipart\/form-data/);
    assert.equal(requests[0].headers.authorization, undefined);
    const form = requests[0].body.toString("utf8");
    for (const [name, value] of [["text", "Curry ties it with seven seconds left."], ["voice", "Magpie-Multilingual.EN-US.Jason"], ["language", "en-US"]]) {
      assert.match(form, new RegExp(`name="${name}"\\r\\n\\r\\n${value.replace(/[.]/g, "\\.")}\\r\\n`));
    }
    assert.deepEqual(Buffer.from(result.audio), wav(1000));
    assert.equal(result.mimeType, "audio/wav");
    assert.equal(result.durationMs, 1000);
    assert.equal(result.trace.status, "completed");
    assert.equal(result.trace.route, "nim");
    assert.equal(result.trace.format, "riva");
    assert.equal(result.trace.voice, "Magpie-Multilingual.EN-US.Jason");
    assert.equal(result.trace.characters, 38);
  });

  it("lets one call use another voice and language", async () => {
    reset();
    const result = await synthesizeSpeech({ text: "Olá.", config: riva(), voice: "Magpie-Multilingual.PT-BR.Aria.Happy", language: "pt-BR" });
    const form = requests[0].body.toString("utf8");
    assert.match(form, /name="voice"\r\n\r\nMagpie-Multilingual\.PT-BR\.Aria\.Happy\r\n/);
    assert.match(form, /name="language"\r\n\r\npt-BR\r\n/);
    assert.equal(result.trace.voice, "Magpie-Multilingual.PT-BR.Aria.Happy");
  });
});

describe("synthesizeSpeech on an OpenAI-style service", () => {
  it("posts JSON with the key from the named variable and asks for WAV", async () => {
    reset();
    const result = await synthesizeSpeech({ text: "They still lose by two.", config: openai(), env: ENV });
    assert.equal(requests[0].url, "/v1/audio/speech");
    assert.equal(requests[0].headers.authorization, "Bearer test-key");
    assert.match(requests[0].headers["content-type"], /^application\/json/);
    assert.deepEqual(JSON.parse(requests[0].body.toString("utf8")), {
      model: "gpt-4o-mini-tts",
      input: "They still lose by two.",
      voice: "alloy",
      response_format: "wav",
    });
    assert.equal(result.durationMs, 1000);
    assert.equal(result.trace.route, "api");
    assert.equal(result.trace.model, "gpt-4o-mini-tts");
  });

  it("sends nothing when the key variable is not set, and says which one", async () => {
    reset();
    await assert.rejects(synthesizeSpeech({ text: "x", config: openai(), env: {} }), (err) => {
      assert.ok(err instanceof SpeechRouteError);
      assert.match(err.message, /SPEECH_TEST_KEY is not set/);
      assert.equal(err.trace.status, "failed");
      return true;
    });
    assert.equal(requests.length, 0);
  });

  it("works keyless against a compatible server you run", async () => {
    reset();
    const config = { roles: {}, speech: { route: "nim", format: "openai", model: "kokoro", voice: "af_heart", baseUrl: base } };
    await synthesizeSpeech({ text: "x", config });
    assert.equal(requests[0].headers.authorization, undefined);
  });
});

describe("synthesizeSpeech refusals and failures", () => {
  it("refuses empty or over-long text before any request", async () => {
    reset();
    await assert.rejects(synthesizeSpeech({ text: "   ", config: riva() }), /text/);
    await assert.rejects(synthesizeSpeech({ text: "x".repeat(SPEECH_LIMITS.maxTextChars + 1), config: riva() }), /too long/);
    assert.equal(requests.length, 0);
  });

  it("refuses a missing or invalid speech config", async () => {
    await assert.rejects(synthesizeSpeech({ text: "x", config: { roles: {} } }), /inference\.speech/);
    await assert.rejects(synthesizeSpeech({ text: "x", config: riva({ format: "nope" }) }), /riva, openai/);
  });

  it("fails on an error status without repeating the service's text", async () => {
    reset(() => ({ status: 500, type: "application/json", body: JSON.stringify({ detail: "SECRET-UPSTREAM-TEXT" }) }));
    await assert.rejects(synthesizeSpeech({ text: "x", config: riva() }), (err) => {
      assert.ok(err instanceof SpeechRouteError);
      assert.match(err.message, /HTTP 500/);
      assert.ok(!err.message.includes("SECRET-UPSTREAM-TEXT"));
      return true;
    });
  });

  it("fails when the service returns something that is not WAV", async () => {
    reset(() => ({ type: "audio/mpeg", body: Buffer.from("ID3 not a wav file at all, just bytes") }));
    await assert.rejects(synthesizeSpeech({ text: "x", config: riva() }), /WAV/);
  });

  it("reports a deadline as timed_out and a caller's abort as cancelled", async () => {
    reset(() => ({ body: wav(100), delayMs: 400 }));
    await assert.rejects(synthesizeSpeech({ text: "x", config: riva({ timeoutMs: 50 }) }), (err) => err.trace.status === "timed_out");
    const controller = new AbortController();
    const pending = synthesizeSpeech({ text: "x", config: riva(), abortSignal: controller.signal });
    setTimeout(() => controller.abort(), 30);
    await assert.rejects(pending, (err) => err.trace.status === "cancelled");
  });
});

describe("synthesizeSpeech mock route and receipts", () => {
  it("returns a short valid WAV without any network call", async () => {
    reset();
    const result = await synthesizeSpeech({ text: "x", config: { roles: {}, speech: { route: "mock", voice: "any" } } });
    assert.equal(requests.length, 0);
    assert.equal(Buffer.from(result.audio).toString("latin1", 0, 4), "RIFF");
    assert.ok(result.durationMs > 0);
    assert.equal(result.trace.route, "mock");
  });

  it("emits a receipt with no text, voice or endpoint in it", async () => {
    reset();
    const receipts = [];
    await synthesizeSpeech({ text: "Curry ties it.", config: openai(), env: ENV, onReceipt: (r) => receipts.push(r) });
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].kind, "speech");
    assert.equal(receipts[0].purpose, "speech");
    assert.equal(receipts[0].route, "api");
    assert.equal(receipts[0].status, "completed");
    assert.equal(receipts[0].modelId, "gpt-4o-mini-tts");
    const text = JSON.stringify(receipts[0]);
    for (const secret of ["Curry", "alloy", "127.0.0.1", "test-key"]) assert.ok(!text.includes(secret), secret);
  });

  it("emits a failed receipt when the call fails", async () => {
    reset(() => ({ status: 503, body: "" }));
    const receipts = [];
    await assert.rejects(synthesizeSpeech({ text: "x", config: riva(), onReceipt: (r) => receipts.push(r) }));
    assert.equal(receipts[0].status, "failed");
    assert.equal(receipts[0].errorCode, "provider_error");
  });
});

describe("speechText", () => {
  it("drops markup a voice would read aloud", () => {
    assert.equal(speechText("**Curry** ties it — again… see [the box score](https://x.test/box)."), "Curry ties it, again... see the box score.");
    assert.equal(speechText("`He` _answers_ # early\n> and “pushes” the lead out"), "He answers early and \"pushes\" the lead out");
  });

  it("drops an italic source tag instead of speaking it", () => {
    assert.equal(speechText("Lakers hold on for the win. *Live match feed*"), "Lakers hold on for the win.");
    assert.equal(speechText("He was *really* good."), "He was really good.");
  });
});

describe("package exports", () => {
  it("exports the speech call and its helpers", () => {
    assert.equal(sdk.synthesizeSpeech, synthesizeSpeech);
    assert.equal(sdk.speechText, speechText);
    assert.equal(sdk.SpeechRouteError, SpeechRouteError);
  });
});
