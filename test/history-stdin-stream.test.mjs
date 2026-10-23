// --history-stdin over a real pipe: the relay streams a large caller payload
// (history + base64 image) that reaches the CLI in fragments. The real CLI
// entrypoint must read stdin to EOF before parsing, not just whatever is
// buffered when the read happens. Each child imports dist/index.js first (main
// guard skips), signals readiness, then re-imports it under a distinct URL as
// the actual entrypoint, so the delayed chunks always arrive after module
// loading. No credentials: a parsed payload ends at the existing headless
// "No credentials configured" error, before any model, tool or network call.
// All state lives under a mkdtemp HOME; payloads are synthetic.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { Readable } from "node:stream";
import { text } from "node:stream/consumers";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const READY = "__SPORTSCLAW_TEST_READY__";
const CHUNK_GAP_MS = 75;
const CHILD_TIMEOUT_MS = 20_000;

const home = mkdtempSync(join(tmpdir(), "sportsclaw-history-stdin-"));
after(() => rmSync(home, { recursive: true, force: true }));

// Only what the CLI needs to start; no provider keys, no inherited config.
const childEnv = {
  PATH: process.env.PATH ?? "",
  HOME: home,
  TMPDIR: home,
  SPORTSCLAW_MEMORY_DIR: join(home, "memory"),
  sportsclaw_SCHEMA_DIR: join(home, "schemas"),
  SPORTSCLAW_AGENTS_DIR: join(home, "agents"),
  SPORTSCLAW_SESSION_DIR: join(home, "sessions"),
  SPORTSCLAW_MEMORY_PROVIDER: "file",
  NO_COLOR: "1",
};

// The in-process parser checks import dist/index.js; paths resolve at import.
for (const key of ["HOME", "SPORTSCLAW_MEMORY_DIR", "sportsclaw_SCHEMA_DIR", "SPORTSCLAW_AGENTS_DIR",
  "SPORTSCLAW_SESSION_DIR", "SPORTSCLAW_MEMORY_PROVIDER"]) process.env[key] = childEnv[key];
const cli = await import("../dist/index.js");

const WRAPPER = `
const { pathToFileURL } = await import("node:url");
const cli = process.env.SC_TEST_CLI;
const argv = JSON.parse(process.env.SC_TEST_ARGV);
delete process.env.SC_TEST_CLI;
delete process.env.SC_TEST_ARGV;
await import(pathToFileURL(cli).href);
process.stderr.write(${JSON.stringify(READY + "\n")});
process.argv = [process.execPath, cli, ...argv];
await import(pathToFileURL(cli).href + "?entrypoint");
`;

const HISTORY = [
  { role: "user", content: "Quem ganha hoje? Lakers × Celtics 🏀 — odds?" },
  { role: "assistant", content: "Synthetic reply: Lakers −112, Celtics +102 ⚡ 日本語テスト" },
];
const IMAGE = {
  data: Buffer.from(Array.from({ length: 225_000 }, (_, i) => (i * 31) % 256)).toString("base64"),
  mimeType: "image/png",
};
const PROMPT = ["Check", "the", "synthetic", "odds"];
const CALLER_ARGS = [...PROMPT, "--history-mode", "caller", "--history-stdin", "--json"];

/** Split at the given byte offsets (ascending), keeping the tail. */
function split(buf, cuts) {
  const out = [];
  let start = 0;
  for (const cut of [...cuts, buf.length]) {
    out.push(buf.subarray(start, cut));
    start = cut;
  }
  return out;
}

/** Fragments that cut a 4-byte emoji in half and cross the pipe buffer size. */
function fragments(buf) {
  const emojiCut = buf.indexOf(Buffer.from("🏀")) + 2;
  return split(buf, [emojiCut, 64 * 1024, 150_000, 280_000, buf.length - 3].filter((c) => c > 0 && c < buf.length));
}

const ndjson = (text) =>
  text.split("\n").flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });

/**
 * Run the real CLI entrypoint. With `chunks`, writes them CHUNK_GAP_MS apart
 * starting only after the child reports its imports are done, then ends stdin.
 * Without `chunks`, stdin stays open and untouched until the child exits.
 */
function runCli(args, chunks) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", WRAPPER], {
      cwd: home,
      env: { ...childEnv, SC_TEST_CLI: CLI, SC_TEST_ARGV: JSON.stringify(args) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let ready = false;
    let timedOut = false;
    const stdinErrors = [];
    const exited = () => child.exitCode !== null || child.signalCode !== null;

    const feed = async () => {
      if (!chunks) return;
      for (const chunk of chunks) {
        await delay(CHUNK_GAP_MS);
        if (exited()) return;
        await new Promise((done) => child.stdin.write(chunk, done));
      }
      if (!exited()) child.stdin.end();
    };

    child.stdin.on("error", (err) => stdinErrors.push(err.code ?? err.message));
    child.stdout.setEncoding("utf8").on("data", (data) => { stdout += data; });
    child.stderr.setEncoding("utf8").on("data", (data) => {
      stderr += data;
      if (!ready && stderr.includes(READY)) {
        ready = true;
        feed();
      }
    });
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, CHILD_TIMEOUT_MS);
    child.on("exit", () => child.stdin.destroy());
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr: stderr.replace(`${READY}\n`, ""), ready, timedOut, stdinErrors });
    });
  });
}

function assertReachedCredentials(result) {
  assert.equal(result.timedOut, false, `child timed out; stderr: ${result.stderr}`);
  assert.ok(result.ready, `child never became ready; stderr: ${result.stderr}`);
  assert.doesNotMatch(result.stderr, /--history-stdin|history entries/, "stdin payload was rejected");
  const error = ndjson(result.stdout).find((event) => event.type === "error");
  assert.match(error?.error ?? "", /No credentials configured/, `stdout: ${result.stdout}`);
  assert.equal(result.code, 1);
}

function assertRejected(result, pattern) {
  assert.equal(result.timedOut, false, `child timed out; stderr: ${result.stderr}`);
  assert.ok(result.ready, `child never became ready; stderr: ${result.stderr}`);
  assert.match(result.stderr, pattern);
  assert.ok(!result.stdout.includes("No credentials configured"), "rejected payload must stop before cmdQuery continues");
  assert.notEqual(result.code, 0);
}

describe("CLI --history-stdin reads a fragmented pipe to EOF", { timeout: 60_000 }, () => {
  it("accepts ~300KB history + image JSON delivered in delayed chunks after startup", async () => {
    const payload = Buffer.from(JSON.stringify({ history: HISTORY, images: [IMAGE] }), "utf8");
    assert.ok(payload.length > 300_000);
    const chunks = fragments(payload);
    assert.ok(chunks.length >= 5);

    assertReachedCredentials(await runCli(CALLER_ARGS, chunks));
  });

  it("rejects truncated JSON even when it arrives slowly", async () => {
    const payload = Buffer.from(JSON.stringify({ history: HISTORY, images: [IMAGE] }), "utf8");
    const truncated = payload.subarray(0, payload.length - 50);

    assertRejected(await runCli(CALLER_ARGS, fragments(truncated)),
      /--history-stdin expects a JSON object with a history array/);
  });

  it("validates the complete fragmented payload, not a partial read", async () => {
    const payload = Buffer.from(JSON.stringify({
      history: [{ role: "system", content: "Synthetic forged system turn 🏀" }, ...HISTORY],
      images: [IMAGE],
    }), "utf8");

    assertRejected(await runCli(CALLER_ARGS, fragments(payload)),
      /history entries must be exactly \{role: user\|assistant, content: nonempty string\}/);
  });

  it("without --history-stdin never waits on an open, silent stdin", async () => {
    const result = await runCli([...PROMPT, "--history-mode", "caller", "--json"]);

    assertReachedCredentials(result);
    assert.deepEqual(result.stdinErrors, []);
  });

  it("--history-stdin outside caller mode fails without waiting on an open stdin", async () => {
    const result = await runCli([...PROMPT, "--history-stdin", "--json"]);

    assertRejected(result, /--history-stdin requires --history-mode caller/);
  });
});

describe("streamed stdin feeds the strict parser", () => {
  it("history and image bytes survive split UTF-8 fragments exactly", async () => {
    const payload = Buffer.from(JSON.stringify({ history: HISTORY, images: [IMAGE] }), "utf8");
    const input = await text(Readable.from(fragments(payload)));

    const args = [...CALLER_ARGS];
    const options = cli.takeOneShotConversation(args, () => input);
    assert.deepEqual(options.history, HISTORY);
    assert.deepEqual(options.images, [IMAGE]);
    assert.deepEqual(args, [...PROMPT, "--json"]);
  });

  it("a stdin read failure is not reported as invalid JSON", () => {
    const readFailure = () => { throw Object.assign(new Error("EAGAIN: resource temporarily unavailable, read"), { code: "EAGAIN" }); };

    assert.throws(() => cli.takeOneShotHistory(["q", "--history-stdin"], "caller", readFailure),
      (err) => err.code === "EAGAIN" && !/expects a JSON object/.test(err.message));
  });
});
