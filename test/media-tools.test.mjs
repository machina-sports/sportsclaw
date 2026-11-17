/**
 * Media story tools: the agent runs every step, and the engine enforces the order.
 * Real job runner, real artifact store, a fixture pack (test/fixtures/media/pack-story),
 * a local chat server as the writer, the mock speech route and a tiny generated mp4.
 */

import assert from "node:assert/strict";
import http from "node:http";
import { after, describe, it } from "node:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, appendFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = mkdtempSync(join(tmpdir(), "media-tools-test-"));
// Sealed bundles go to os.tmpdir(); keep ours private so tests that watch the shared tmpdir are not disturbed.
mkdirSync(join(tmp, "sealed"));
process.env.TMPDIR = join(tmp, "sealed");

// Engine state lives under the temp HOME (as in run-detailed.test.mjs).
for (const dir of ["memory", "schemas", "agents", "sessions"]) mkdirSync(join(tmp, "home", dir), { recursive: true });
Object.assign(process.env, {
  HOME: join(tmp, "home"),
  SPORTSCLAW_MEMORY_DIR: join(tmp, "home", "memory"),
  sportsclaw_SCHEMA_DIR: join(tmp, "home", "schemas"),
  SPORTSCLAW_AGENTS_DIR: join(tmp, "home", "agents"),
  SPORTSCLAW_SESSION_DIR: join(tmp, "home", "sessions"),
  SPORTSCLAW_MEMORY_PROVIDER: "file",
});
for (const key of ["SPORTSCLAW_SKILLS", "sportsclaw_SKILLS", "SPORTSCLAW_MEMORY_BACKEND", "HINDSIGHT_BASE_URL", "SPORTSCLAW_MEDIA_RIGHTS_CHECK"]) {
  delete process.env[key];
}
globalThis.AI_SDK_LOG_WARNINGS = false;

const { createMediaTools, MEDIA_TOOL_NAMES } = await import(join(repoRoot, "dist/media/tools.js"));
const { ArtifactStore } = await import(join(repoRoot, "dist/media/artifacts.js"));
const { bundleSha256, JOB_ALLOWLIST_ENV } = await import(join(repoRoot, "dist/media/bundle.js"));
const { buildRunManifest } = await import(join(repoRoot, "dist/run-manifest.js"));
const { MediaPrep } = await import(join(repoRoot, "dist/media/prep.js")).catch(() => ({}));
const { MockLanguageModelV3 } = await import("ai/test");
const { sportsclawEngine } = await import(join(repoRoot, "dist/engine.js"));

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const HAVE_FFMPEG = spawnSync(FFMPEG, ["-version"]).status === 0;
const HAVE_DRAWTEXT = HAVE_FFMPEG &&
  /drawtext/.test(spawnSync(FFMPEG, ["-hide_banner", "-filters"], { encoding: "utf-8" }).stdout ?? "");
const NO_FFMPEG = !HAVE_FFMPEG && "FFmpeg not available";

const SKILL = "pack-story";
const pack = join(tmp, "packs", SKILL);
cpSync(join(repoRoot, "test/fixtures/media/pack-story"), pack, { recursive: true });
const SHA = await bundleSha256(pack);
const GUIDES = [{ id: SKILL, name: SKILL, description: "", body: "", dir: pack }];
const APPROVED = ["make-index", "check-lines", "hand-off", "render-video"];
const allow = (kinds) => ({ [JOB_ALLOWLIST_ENV]: JSON.stringify(kinds.map((kind) => ({ skill: SKILL, kind, bundleSha256: SHA }))) });
const RIGHTS = { rightsHolder: "League", licenseRef: "L-1", clearedForClipping: true };

// A 12-second source (or plain bytes when FFmpeg is missing; then only tests that need no probe run).
const SOURCE = join(tmp, "source.mp4");
if (HAVE_FFMPEG) {
  const gen = spawnSync(FFMPEG, ["-y", "-f", "lavfi", "-i", "testsrc=duration=12:size=160x90:rate=10",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=12", "-c:v", "mpeg4", "-q:v", "5", "-g", "10",
    "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", SOURCE], { encoding: "utf-8" });
  assert.equal(gen.status, 0, gen.stderr);
} else {
  writeFileSync(SOURCE, "not a video");
}
const SOURCE_SHA = createHash("sha256").update(readFileSync(SOURCE)).digest("hex");
/** The operator's clearance for the test source (every workspace holds a copy of the same bytes). */
const CLEARED = [{ ...RIGHTS, sourceSha256: SOURCE_SHA }];

const EVENTS = [
  { eventId: "ev_1", actionId: "1", period: 1, clockSec: 30, label: "Smith 3PT jump shot", type: "3pt", people: ["Ann Smith"], videoSec: 3, startSec: 1, endSec: 5 },
  { eventId: "ev_2", actionId: "2", period: 1, clockSec: 50, label: "Jones layup", type: "2pt", people: ["Bea Jones"], videoSec: 8, startSec: 6, endSec: 10 },
];
const WRITER_LINES = [
  { text: "Smith hits from deep.", cites: ["ev_1"] },
  { text: "The crowd roars for Jones.", cites: ["ev_2"] },
  { text: "Smith finished with 38 points.", cites: ["fact_1"] },
];
const RESULTS = [{ toolName: "stats_get_player", toolCallId: "c1", input: {}, output: '{"player":"Ann Smith","pts":38}', isError: false }];

// The writer role: a chat server answering every request with WRITER_LINES.
const writer = http.createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      id: "c1", object: "chat.completion", created: 1, model: "writer",
      choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(WRITER_LINES) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    }));
  });
});
await new Promise((resolve) => writer.listen(0, "127.0.0.1", resolve));
const INFERENCE = {
  roles: {
    writer: { route: "nim", model: "writer", baseUrl: `http://127.0.0.1:${writer.address().port}/v1` },
    // Jobs call this one through the role proxy (scripts/ask_proxy.py).
    eyes: { route: "nim", model: "eyes-model", baseUrl: `http://127.0.0.1:${writer.address().port}/v1` },
  },
  speech: { route: "mock", voice: "v1" },
};

const disposers = [];
after(async () => {
  for (const d of disposers) await d().catch(() => undefined);
  await new Promise((resolve) => writer.close(resolve));
  rmSync(tmp, { recursive: true, force: true });
});

let n = 0;
function newWorkspace() {
  const ws = join(tmp, `ws-${n++}`);
  mkdirSync(join(ws, "media"), { recursive: true });
  cpSync(SOURCE, join(ws, "media", "game.mp4"));
  return ws;
}

async function make(over = {}) {
  const workspaceDir = over.workspaceDir ?? newWorkspace();
  const runId = over.runId ?? `run_${n++}`;
  const media = await createMediaTools({
    config: { workspaceDir, clearances: CLEARED, ...over.config },
    guides: GUIDES,
    inference: "inference" in over ? over.inference : INFERENCE,
    runId,
    getToolResults: () => over.results ?? RESULTS,
    env: { ...process.env, ...allow(over.kinds ?? APPROVED) },
    isDataTool: over.isDataTool ?? ((name) => name === "stats_get_player"),
    ...(over.pythonPath ? { pythonPath: over.pythonPath } : {}),
    ...(over.onReceipt ? { onReceipt: over.onReceipt } : {}),
    ...(over.clearances ? { clearances: over.clearances } : {}),
    ...(over.prep ? { prep: over.prep } : {}),
  });
  disposers.push(media.dispose);
  const call = (name, input = {}) => media.tools[name].execute(input, {});
  return { workspaceDir, runId, media, call };
}

function ok(result) {
  assert.equal(result.error_code, undefined, `${result.error_code}: ${result.message}`);
  return result;
}

function refused(result, code) {
  assert.equal(result.error_code, code, JSON.stringify(result));
  assert.equal(typeof result.message, "string");
}

/** Open the source, run make-index, wait for it. */
async function openAndIndex(call, mode) {
  const src = ok(await call("media_source_open", { path: "media/game.mp4" }));
  const job = ok(await call("media_job_start", {
    skill: SKILL, kind: "make-index", input: { events: EVENTS, ...(mode ? { mode } : {}) }, sourceArtifactId: src.sourceArtifactId,
  }));
  const st = ok(await call("media_job_status", { jobId: job.jobId, waitSec: 30 }));
  assert.equal(st.state, "succeeded", st.error);
  const indexId = st.artifacts.find((a) => a.kind === "event-index").artifactId;
  return { src, job, st, indexId };
}

/** Everything up to spoken lines: index, facts, a checked set of lines, two voices. */
async function prepared(call) {
  const { src, indexId } = await openAndIndex(call);
  const facts = ok(await call("story_facts_collect"));
  const checked = ok(await call("story_check_lines", { indexArtifactId: indexId, factsArtifactId: facts.factsArtifactId, lines: WRITER_LINES }));
  const voice = ok(await call("speech_synthesize", { linesArtifactId: checked.linesArtifactId, lineIds: ["line_1", "line_2"] }));
  return { src, indexId, facts, checked, voices: voice.voices.map((v) => v.voiceArtifactId) };
}

const timelineOf = (p, extra = {}) => ({
  version: 1,
  sourceArtifactId: p.src.sourceArtifactId,
  linesArtifactId: p.checked.linesArtifactId,
  segments: [
    { kind: "clip", eventId: "ev_1", startSec: 1, endSec: 5, voiceArtifactId: p.voices[0], ...extra },
    { kind: "card", cardSeconds: 1, voiceArtifactId: p.voices[1] },
  ],
});

describe("media story tools: the whole chain", () => {
  it("open -> index job -> find -> facts -> draft -> check -> speak -> timeline -> render plain gives a video, every step recorded", { skip: NO_FFMPEG }, async () => {
    const receipts = [];
    const { media, call, workspaceDir, runId } = await make({ onReceipt: (r) => receipts.push(r) });
    const { src, job, indexId } = await openAndIndex(call);
    assert.ok(Math.abs(src.durationSec - 12) < 0.5, `duration ${src.durationSec}`);

    const found = ok(await call("media_find_events", { indexArtifactId: indexId, people: ["Ann Smith"] }));
    assert.deepEqual(found.events, [{
      eventId: "ev_1", period: 1, clock: "0:30", label: "Smith 3PT jump shot", people: ["Ann Smith"], type: "3pt", videoSec: 3, startSec: 1, endSec: 5,
    }]);

    const facts = ok(await call("story_facts_collect"));
    assert.deepEqual(facts.facts, [{ factId: "fact_1", toolName: "stats_get_player" }]);

    const draft = ok(await call("story_draft_lines", {
      indexArtifactId: indexId, eventIds: ["ev_1", "ev_2"], factsArtifactId: facts.factsArtifactId, brief: "Smith's night.",
    }));
    assert.deepEqual(draft.lines, WRITER_LINES);

    const checked = ok(await call("story_check_lines", { indexArtifactId: indexId, factsArtifactId: facts.factsArtifactId, lines: draft.lines }));
    assert.deepEqual(checked.verdicts.map((v) => [v.ok, v.reasons]), [[true, []], [false, ["crowd_not_in_record"]], [true, []]]);
    assert.deepEqual(checked.passed, [
      { lineId: "line_1", text: "Smith hits from deep." },
      { lineId: "line_2", text: "Smith finished with 38 points." },
    ]);
    assert.equal(checked.rewritesLeft, 2);

    const spoken = ok(await call("speech_synthesize", { linesArtifactId: checked.linesArtifactId, lineIds: ["line_1", "line_2"] }));
    const voices = spoken.voices.map((v) => v.voiceArtifactId);
    assert.equal(voices.length, 2);

    const p = { src, checked, voices };
    const built = ok(await call("story_timeline_build", { timeline: timelineOf(p, HAVE_DRAWTEXT ? { lineId: "line_1" } : {}) }));
    const video = ok(await call("story_render", { timelineArtifactId: built.timelineArtifactId }));
    assert.ok(Math.abs(video.durationSec - 5) < 0.5, `rendered ${video.durationSec}`);
    const store = new ArtifactStore({ workspaceDir, runId });
    await store.require(video.videoArtifactId, "video");

    assert.deepEqual(media.steps.map(({ input, ...step }) => step), [
      { tool: "media_source_open", artifactIds: [src.sourceArtifactId] },
      { tool: "media_job_start", artifactIds: [], jobId: job.jobId },
      { tool: "media_job_status", artifactIds: [indexId], jobId: job.jobId },
      { tool: "media_find_events", artifactIds: [] },
      { tool: "story_facts_collect", artifactIds: [facts.factsArtifactId] },
      { tool: "story_draft_lines", artifactIds: [] },
      { tool: "story_check_lines", artifactIds: [checked.linesArtifactId], checker: `${SKILL}/check-lines` },
      { tool: "speech_synthesize", artifactIds: voices },
      { tool: "story_timeline_build", artifactIds: [built.timelineArtifactId] },
      { tool: "story_render", artifactIds: [video.videoArtifactId] },
    ]);
    // Each step records its input, so the manifest shows ids chaining step to step.
    assert.deepEqual(media.steps[1].input.sourceArtifactId, src.sourceArtifactId);
    assert.deepEqual(media.steps[3].input, { indexArtifactId: indexId, people: ["Ann Smith"] });
    assert.deepEqual(media.steps[7].input, { linesArtifactId: checked.linesArtifactId, lineIds: ["line_1", "line_2"] });
    assert.equal(media.steps[9].input.timelineArtifactId, built.timelineArtifactId);

    const manifest = buildRunManifest({
      sportsclawVersion: "test", provider: "openai", model: "m", sampling: {}, maxOutputTokens: 1, maxTurns: 1, thinkingBudget: 0,
      env: {},
      trace: { offeredTools: [], toolSurfaceSha256: "x", providerWarnings: [], parallelAgents: false, mediaSteps: media.steps, mediaReceipts: receipts },
    });
    assert.deepEqual(manifest.run.media_steps, JSON.parse(JSON.stringify(media.steps)));
    const kinds = manifest.run.media_receipts.map((r) => `${r.kind}:${r.modelId ?? ""}:${r.status}`);
    assert.ok(kinds.includes("generate:eyes-model:completed"), `role-proxy receipt from the index job: ${kinds}`);
    assert.ok(kinds.includes("generate:writer:completed"), `writer receipt: ${kinds}`);
    assert.equal(kinds.filter((k) => k.startsWith("speech:")).length, 2, `speech receipts: ${kinds}`);
    for (const r of manifest.run.media_receipts) assert.ok(!JSON.stringify(r).includes("Smith"), "receipts carry no text");
  });

  it("a step's input keeps its shape with every string capped at 200 characters", async () => {
    const { media, call } = await make();
    const long = "x".repeat(300);
    refused(await call("media_find_events", { indexArtifactId: long }), "artifact_unknown");
    ok(await call("story_facts_collect", { note: long, nested: { list: [long, 7] } }));
    assert.deepEqual(media.steps.map((s) => s.input), [{ note: "x".repeat(200), nested: { list: ["x".repeat(200), 7] } }]);
  });
});

describe("media story tools: order is enforced", () => {
  it("a line that failed the check cannot be spoken (unknown_line)", async () => {
    const { call } = await make();
    const p = await prepared(call);
    refused(await call("speech_synthesize", { linesArtifactId: p.checked.linesArtifactId, lineIds: ["line_1", "line_3"] }), "unknown_line");
  });

  it("a timeline naming lines-checked from another run -> artifact_wrong_run", { skip: NO_FFMPEG }, async () => {
    const { call, workspaceDir } = await make();
    const p = await prepared(call);
    const file = join(workspaceDir, "other-lines.json");
    writeFileSync(file, JSON.stringify({ version: 1, indexArtifactId: p.indexId, lines: [{ lineId: "line_1", text: "x", cites: ["ev_1"] }] }));
    const other = await new ArtifactStore({ workspaceDir, runId: "another_run" }).register({ kind: "lines-checked", path: file });
    const t = { ...timelineOf(p), linesArtifactId: other.id };
    refused(await call("story_timeline_build", { timeline: t }), "artifact_wrong_run");
  });

  it("story_render given an event-index id -> artifact_wrong_kind", async () => {
    const { call } = await make();
    const { indexId } = await openAndIndex(call);
    refused(await call("story_render", { timelineArtifactId: indexId }), "artifact_wrong_kind");
  });

  it("the 4th story_check_lines call -> rewrite_limit", async () => {
    const { call } = await make();
    const { indexId } = await openAndIndex(call);
    const lines = [{ text: "Smith hits from deep.", cites: ["ev_1"] }];
    const left = [];
    for (let i = 0; i < 3; i++) left.push(ok(await call("story_check_lines", { indexArtifactId: indexId, lines })).rewritesLeft);
    assert.deepEqual(left, [2, 1, 0]);
    refused(await call("story_check_lines", { indexArtifactId: indexId, lines }), "rewrite_limit");
  });
});

describe("media story tools: what the model is offered", () => {
  it("a kind whose bundle is not allowlisted -> unknown_kind, and no trace of it in the tool list", async () => {
    const { media, call } = await make();
    refused(await call("media_job_start", { skill: SKILL, kind: "secret-kind", input: {} }), "unknown_kind");
    const surface = JSON.stringify(Object.entries(media.tools).map(([name, t]) => ({ name, d: t.description, s: t.inputSchema })));
    assert.ok(!surface.includes("secret-kind"), "unapproved kind leaked into the tool list");
    assert.ok(surface.includes("make-index"), "approved kinds are listed");
    assert.deepEqual(Object.keys(media.tools).sort(), [...MEDIA_TOOL_NAMES].sort());
  });

  it("a kind declaring a tool-made artifact kind (lines-checked) is dropped even when allowlisted", async () => {
    const { media, call } = await make({ kinds: [...APPROVED, "fake-lines"] });
    refused(await call("media_job_start", { skill: SKILL, kind: "fake-lines", input: {} }), "unknown_kind");
    assert.ok(!JSON.stringify(Object.values(media.tools).map((t) => t.description)).includes("fake-lines"));
  });

  it("no tool's JSON Schema has a property named rightsCheck, interpreter or allowlist", async () => {
    const { media } = await make();
    const names = [];
    const walk = (schema) => {
      if (!schema || typeof schema !== "object") return;
      if (schema.properties && typeof schema.properties === "object") {
        for (const [k, v] of Object.entries(schema.properties)) {
          names.push(k);
          walk(v);
        }
      }
      if (schema.items) walk(schema.items);
    };
    for (const t of Object.values(media.tools)) walk(t.inputSchema);
    assert.ok(names.length > 10);
    for (const banned of ["rightsCheck", "interpreter", "interpreters", "allowlist"]) assert.ok(!names.includes(banned), banned);
  });

  it("`sportsclaw media bundle-hash <dir>` prints the bundle hash the allowlist needs", () => {
    const run = spawnSync(process.execPath, [join(repoRoot, "dist/index.js"), "media", "bundle-hash", pack], { encoding: "utf-8", env: process.env });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim(), SHA);
  });

  it("no file under src/media/ names a sport, a model or a look", () => {
    const dir = join(repoRoot, "src/media");
    for (const f of readdirSync(dir)) {
      const text = readFileSync(join(dir, f), "utf8");
      assert.ok(!/basketball|nba|jersey|nemotron|magpie/i.test(text), `${f} names a sport, model or look`);
    }
  });
});

describe("media story tools: artifact hand-off to jobs", () => {
  it("x-artifact-kind ids (a string and an array) are checked and handed to the job in input.json's artifacts", async () => {
    const { call, workspaceDir, runId } = await make();
    const p = await prepared(call);
    const job = ok(await call("media_job_start", { skill: SKILL, kind: "hand-off", input: { lines: p.checked.linesArtifactId, voices: p.voices } }));
    const st = ok(await call("media_job_status", { jobId: job.jobId, waitSec: 30 }));
    assert.equal(st.state, "succeeded", st.error);
    const store = new ArtifactStore({ workspaceDir, runId });
    const expected = {};
    for (const [id, kind] of [[p.checked.linesArtifactId, "lines-checked"], ...p.voices.map((v) => [v, "voice"])]) {
      const a = await store.require(id, kind);
      expected[id] = { kind, path: a.path, sha256: a.sha256 };
    }
    assert.deepEqual(st.facts.artifacts, expected);
  });

  it("a wrong kind, another run's artifact, or a changed file is refused before the job starts", async () => {
    const { call, workspaceDir } = await make();
    const p = await prepared(call);
    refused(await call("media_job_start", { skill: SKILL, kind: "hand-off", input: { lines: p.indexId } }), "artifact_wrong_kind");
    const file = join(workspaceDir, "voice.wav");
    writeFileSync(file, "RIFF");
    const other = await new ArtifactStore({ workspaceDir, runId: "another_run" }).register({ kind: "voice", path: file });
    refused(await call("media_job_start", { skill: SKILL, kind: "hand-off", input: { voices: [p.voices[0], other.id] } }), "artifact_wrong_run");
    const voicePath = JSON.parse(readFileSync(join(workspaceDir, "artifacts", `${p.voices[1]}.json`), "utf8")).artifact.path;
    appendFileSync(voicePath, "tampered");
    refused(await call("media_job_start", { skill: SKILL, kind: "hand-off", input: { voices: [p.voices[1]] } }), "artifact_changed");
  });
});

describe("media story tools: only the tools make facts, checked lines, voice and timelines", () => {
  /** Registers `doc` as `kind` straight in the store (as a job or another process could), outside the tools. */
  async function planted(workspaceDir, runId, kind, doc, extra = {}) {
    const file = join(workspaceDir, `planted-${n++}.json`);
    writeFileSync(file, typeof doc === "string" ? doc : JSON.stringify(doc));
    return (await new ArtifactStore({ workspaceDir, runId }).register({ kind, path: file, ...extra })).id;
  }
  const LINES_DOC = (indexId) => ({ version: 1, indexArtifactId: indexId, lines: [{ lineId: "line_1", text: "Smith scores 99.", cites: ["ev_1"] }] });

  it("facts registered outside the tools -> artifact_not_minted at story_draft_lines and story_check_lines", async () => {
    const { call, workspaceDir, runId } = await make();
    const { indexId } = await openAndIndex(call);
    const factsId = await planted(workspaceDir, runId, "facts", { version: 1, facts: [{ factId: "fact_1", toolName: "x", output: "99" }] });
    refused(await call("story_draft_lines", { indexArtifactId: indexId, eventIds: ["ev_1"], factsArtifactId: factsId, brief: "b" }), "artifact_not_minted");
    refused(await call("story_check_lines", { indexArtifactId: indexId, factsArtifactId: factsId, lines: [{ text: "Smith scores 99.", cites: ["fact_1"] }] }), "artifact_not_minted");
  });

  it("lines-checked registered outside the tools, in this run or shared from an earlier one -> artifact_not_minted at speech and timeline", async () => {
    const { call, workspaceDir, runId } = await make();
    const { src, indexId } = await openAndIndex(call);
    const here = await planted(workspaceDir, runId, "lines-checked", LINES_DOC(indexId));
    const shared = await planted(workspaceDir, "an_earlier_run", "lines-checked", LINES_DOC(indexId), { sourceSha256: src.sha256, shared: true });
    for (const id of [here, shared]) {
      refused(await call("speech_synthesize", { linesArtifactId: id, lineIds: ["line_1"] }), "artifact_not_minted");
      const t = { version: 1, sourceArtifactId: src.sourceArtifactId, linesArtifactId: id, segments: [{ kind: "card", cardSeconds: 2, lineId: "line_1" }] };
      refused(await call("story_timeline_build", { timeline: t }), "artifact_not_minted");
    }
  });

  it("a voice or timeline registered outside the tools -> artifact_not_minted at story_timeline_build and story_render", { skip: NO_FFMPEG }, async () => {
    const { call, workspaceDir, runId } = await make();
    const p = await prepared(call);
    const voice = await planted(workspaceDir, runId, "voice", "RIFF");
    refused(await call("story_timeline_build", { timeline: timelineOf({ ...p, voices: [voice, p.voices[1]] }) }), "artifact_not_minted");
    const built = ok(await call("story_timeline_build", { timeline: timelineOf(p) }));
    const doc = readFileSync(JSON.parse(readFileSync(join(workspaceDir, "artifacts", `${built.timelineArtifactId}.json`), "utf8")).artifact.path, "utf8");
    const timeline = await planted(workspaceDir, runId, "timeline", doc);
    refused(await call("story_render", { timelineArtifactId: timeline }), "artifact_not_minted");
  });
});

describe("media story tools: renderers", () => {
  it("an approved <skill>/<kind> renderer gets { timeline } with captions and every artifact the timeline names", { skip: NO_FFMPEG }, async () => {
    const { call } = await make();
    const p = await prepared(call);
    const built = ok(await call("story_timeline_build", { timeline: timelineOf(p, { lineId: "line_1" }) }));
    const video = ok(await call("story_render", { timelineArtifactId: built.timelineArtifactId, renderer: `${SKILL}/render-video` }));
    assert.match(video.videoArtifactId, /^art_/);
    assert.ok(Math.abs(video.durationSec - 12) < 0.5, `${video.durationSec}`);
    const st = ok(await call("media_job_status", { jobId: video.jobId }));
    assert.deepEqual(st.facts.captions, ["Smith hits from deep.", null]);
    assert.deepEqual(Object.keys(st.facts.artifacts).sort(), [p.src.sourceArtifactId, p.checked.linesArtifactId, ...p.voices].sort());
  });

  it("story_render passes a renderer its own input beside the timeline, checked against its schema and the one-source rule", { skip: NO_FFMPEG }, async () => {
    const { call, workspaceDir } = await make();
    const p = await prepared(call);
    const built = ok(await call("story_timeline_build", { timeline: timelineOf(p, { lineId: "line_1" }) }));
    const render = (input) => call("story_render", { timelineArtifactId: built.timelineArtifactId, renderer: `${SKILL}/render-video`, input });

    const video = ok(await render({ espnEventId: "401", alt: p.src.sourceArtifactId }));
    const st = ok(await call("media_job_status", { jobId: video.jobId }));
    assert.deepEqual(st.facts.input, { espnEventId: "401", alt: p.src.sourceArtifactId });
    assert.deepEqual(st.facts.captions, ["Smith hits from deep.", null]);
    assert.ok(Object.keys(st.facts.artifacts).includes(p.src.sourceArtifactId));

    refused(await render({ timeline: { captions: ["UNCHECKED"] } }), "invalid_input");
    refused(await render({ espnEventId: 401 }), "invalid_input");
    refused(await render({ colour: "red" }), "invalid_input");
    refused(await render("401"), "invalid_input");
    refused(await render({ alt: p.checked.linesArtifactId }), "artifact_wrong_kind");
    writeFileSync(join(workspaceDir, "media", "other.mp4"), "other bytes");
    const other = ok(await call("media_source_open", { path: "media/other.mp4" }));
    refused(await render({ alt: other.sourceArtifactId }), "source_mismatch");
    refused(await call("story_render", { timelineArtifactId: built.timelineArtifactId, input: { espnEventId: "401" } }), "invalid_input");
  });

  it("media_job_start refuses a renderer kind (renderer_only): captions nobody checked never reach a renderer", async () => {
    const { call, workspaceDir } = await make();
    const src = ok(await call("media_source_open", { path: "media/game.mp4" }));
    refused(await call("media_job_start", {
      skill: SKILL, kind: "render-video", input: { timeline: { captions: ["UNCHECKED"] } }, sourceArtifactId: src.sourceArtifactId,
    }), "renderer_only");
    assert.equal(existsSync(join(workspaceDir, "jobs")), false, "no job may start");
  });

  it("a renderer that is not approved, or does not produce video, is refused", { skip: NO_FFMPEG }, async () => {
    const { call } = await make();
    const p = await prepared(call);
    const built = ok(await call("story_timeline_build", { timeline: timelineOf(p) }));
    refused(await call("story_render", { timelineArtifactId: built.timelineArtifactId, renderer: `${SKILL}/secret-kind` }), "unknown_kind");
    refused(await call("story_render", { timelineArtifactId: built.timelineArtifactId, renderer: `${SKILL}/hand-off` }), "renderer_invalid");
  });

  it("the plain renderer needs a clearance unless the operator turned the check off", { skip: NO_FFMPEG }, async () => {
    const { call } = await make({ kinds: [], config: { clearances: [] } });
    const src = ok(await call("media_source_open", { path: "media/game.mp4" }));
    const t = { version: 1, sourceArtifactId: src.sourceArtifactId, segments: [{ kind: "clip", startSec: 1, endSec: 3 }] };
    const built = ok(await call("story_timeline_build", { timeline: t }));
    refused(await call("story_render", { timelineArtifactId: built.timelineArtifactId }), "rights_required");

    const off = await make({ kinds: [], config: { rightsCheck: "off", clearances: [] } });
    const src2 = ok(await off.call("media_source_open", { path: "media/game.mp4" }));
    const built2 = ok(await off.call("story_timeline_build", { timeline: { ...t, sourceArtifactId: src2.sourceArtifactId } }));
    const video = ok(await off.call("story_render", { timelineArtifactId: built2.timelineArtifactId }));
    assert.equal(video.rightsCheck, "off (operator)");
  });
});

describe("media story tools: footage clearance comes from the operator or the app, never the model", () => {
  const indexJob = (call, sourceArtifactId) => call("media_job_start", { skill: SKILL, kind: "make-index", input: { events: EVENTS }, sourceArtifactId });

  it("rights in media_source_open's input are refused, and its schema has no rights property", async () => {
    const { media, call } = await make({ config: { clearances: [] } });
    refused(await call("media_source_open", { path: "media/game.mp4", rights: RIGHTS }), "unknown_field");
    assert.deepEqual(Object.keys(media.tools.media_source_open.inputSchema.properties), ["path"]);
    assert.equal(media.tools.media_source_open.inputSchema.additionalProperties, false);
  });

  it("require + an operator clearance for the source's sha256: the job runs and its record carries the authorization", async () => {
    const { call } = await make();
    const src = ok(await call("media_source_open", { path: "media/game.mp4" }));
    const job = ok(await indexJob(call, src.sourceArtifactId));
    const st = ok(await call("media_job_status", { jobId: job.jobId, waitSec: 30 }));
    assert.equal(st.state, "succeeded", st.error);
    assert.deepEqual(st.rights, { rightsHolder: "League", licenseRef: "L-1" });
    assert.equal(st.rightsCheck, undefined);
  });

  it("require + a clearance for another sha256 -> rights_required naming the operator", async () => {
    const { call } = await make({ config: { clearances: [{ ...RIGHTS, sourceSha256: "a".repeat(64) }, { ...RIGHTS, clearedForClipping: false, sourceSha256: SOURCE_SHA }] } });
    const src = ok(await call("media_source_open", { path: "media/game.mp4" }));
    const r = await indexJob(call, src.sourceArtifactId);
    refused(r, "rights_required");
    assert.match(r.message, /operator config/);
    assert.match(r.message, /not from the model/);
  });

  it("a source annotation must name the job's own source (source_mismatch), under require and off", async () => {
    for (const rightsCheck of ["require", "off"]) {
      const { call, workspaceDir } = await make({ kinds: [...APPROVED, "source-hand-off"], config: { rightsCheck } });
      writeFileSync(join(workspaceDir, "media", "other.mp4"), "other uncleared bytes");
      const x = ok(await call("media_source_open", { path: "media/game.mp4" }));
      const y = ok(await call("media_source_open", { path: "media/other.mp4" }));
      const start = (input, sourceArtifactId) => call("media_job_start", { skill: SKILL, kind: "source-hand-off", input, ...(sourceArtifactId ? { sourceArtifactId } : {}) });
      const r = await start({ clip: y.sourceArtifactId }, x.sourceArtifactId);
      refused(r, "source_mismatch");
      refused(await start({ clip: x.sourceArtifactId }), "source_mismatch");
      assert.equal(existsSync(join(workspaceDir, "jobs")), false, `no job may start (${rightsCheck})`);
      const job = ok(await start({ clip: x.sourceArtifactId }, x.sourceArtifactId));
      const st = ok(await call("media_job_status", { jobId: job.jobId, waitSec: 30 }));
      assert.equal(st.state, "succeeded", st.error);
      assert.deepEqual(Object.keys(st.facts.artifacts), [x.sourceArtifactId]);
    }
  });

  it("under require, a video or subject-tracks shared from an earlier run needs a clearance for its source (rights_required)", async () => {
    for (const [kind, key] of [["subject-tracks", "tracks"], ["video", "video"]]) {
      const workspaceDir = newWorkspace();
      const file = join(workspaceDir, `earlier-${kind}`);
      writeFileSync(file, "pixels of the game");
      const earlier = await new ArtifactStore({ workspaceDir, runId: "an_earlier_run" }).register({ kind, path: file, sourceSha256: SOURCE_SHA, shared: true });
      const use = async (over) => {
        const { call } = await make({ workspaceDir, ...over });
        ok(await call("media_source_open", { path: "media/game.mp4" }));
        return call("media_job_start", { skill: SKILL, kind: "hand-off", input: { [key]: earlier.id } });
      };
      refused(await use({ config: { clearances: [] } }), "rights_required");
      ok(await use({}));
      ok(await use({ config: { rightsCheck: "off", clearances: [] } }));
    }
  });

  it("off: no clearance is needed and the record says off (operator)", async () => {
    const { call } = await make({ config: { rightsCheck: "off", clearances: [] } });
    const src = ok(await call("media_source_open", { path: "media/game.mp4" }));
    const st = ok(await call("media_job_status", { jobId: ok(await indexJob(call, src.sourceArtifactId)).jobId, waitSec: 30 }));
    assert.equal(st.state, "succeeded", st.error);
    assert.equal(st.rightsCheck, "off (operator)");
    assert.equal(st.rights, undefined);
  });

  it("malformed clearances are a configuration error, not a silent pass", async () => {
    await assert.rejects(make({ config: { clearances: [{ ...RIGHTS, sourceSha256: "ABC" }] } }), /sourceSha256/);
    await assert.rejects(make({ clearances: [{ ...RIGHTS, sourceSha256: SOURCE_SHA, extra: 1 }] }), /unknown field/);
    assert.throws(() => new sportsclawEngine({ thinkingBudget: 0, media: { workspaceDir: newWorkspace(), clearances: [{ sourceSha256: SOURCE_SHA }] } }), /rightsHolder/);
  });
});

describe("media story tools: timelines", () => {
  it("media_find_events rows carry the play's type and where it is in the video", async () => {
    const { call } = await make();
    const { indexId } = await openAndIndex(call);
    const found = ok(await call("media_find_events", { indexArtifactId: indexId, type: "2PT" }));
    assert.deepEqual(found.events, [{
      eventId: "ev_2", period: 1, clock: "0:50", label: "Jones layup", people: ["Bea Jones"], type: "2pt", videoSec: 8, startSec: 6, endSec: 10,
    }]);
  });

  it("a clip may name only its eventId: the window comes from the index its lines were checked against, and the renderer gets it", { skip: NO_FFMPEG }, async () => {
    const { call, workspaceDir } = await make();
    const p = await prepared(call);
    const t = {
      version: 1, sourceArtifactId: p.src.sourceArtifactId, linesArtifactId: p.checked.linesArtifactId,
      segments: [{ kind: "clip", eventId: "ev_2", lineId: "line_1" }, { kind: "clip", eventId: "ev_1", startSec: 0, endSec: 4 }],
    };
    const built = ok(await call("story_timeline_build", { timeline: t }));
    const doc = JSON.parse(readFileSync(JSON.parse(readFileSync(join(workspaceDir, "artifacts", `${built.timelineArtifactId}.json`), "utf8")).artifact.path, "utf8"));
    assert.deepEqual(doc.segments.map((s) => [s.eventId, s.startSec, s.endSec]), [["ev_2", 6, 10], ["ev_1", 0, 4]]);
    const video = ok(await call("story_render", { timelineArtifactId: built.timelineArtifactId, renderer: `${SKILL}/render-video` }));
    const st = ok(await call("media_job_status", { jobId: video.jobId }));
    assert.deepEqual(st.facts.segments.map((s) => [s.eventId, s.startSec, s.endSec]), [["ev_2", 6, 10], ["ev_1", 0, 4]]);
  });

  it("a clip window away from its event -> clip_not_event; an event not in the index -> unknown_event", { skip: NO_FFMPEG }, async () => {
    const { call } = await make();
    const p = await prepared(call);
    const t = (seg) => ({ version: 1, sourceArtifactId: p.src.sourceArtifactId, linesArtifactId: p.checked.linesArtifactId, segments: [seg] });
    refused(await call("story_timeline_build", { timeline: t({ kind: "clip", eventId: "ev_1", startSec: 8, endSec: 11 }) }), "clip_not_event");
    refused(await call("story_timeline_build", { timeline: t({ kind: "clip", eventId: "ev_404" }) }), "unknown_event");
  });

  it("captions come from the exact lines-checked artifact the timeline names", { skip: NO_FFMPEG }, async () => {
    const { call } = await make();
    const { src, indexId } = await openAndIndex(call);
    const a = ok(await call("story_check_lines", { indexArtifactId: indexId, lines: [WRITER_LINES[0]] }));
    const b = ok(await call("story_check_lines", { indexArtifactId: indexId, lines: [WRITER_LINES[0], { text: "Jones scores.", cites: ["ev_2"] }] }));
    assert.equal(b.passed.length, 2);
    const t = { version: 1, sourceArtifactId: src.sourceArtifactId, linesArtifactId: a.linesArtifactId, segments: [{ kind: "clip", startSec: 1, endSec: 3, lineId: "line_2" }] };
    refused(await call("story_timeline_build", { timeline: t }), "unknown_line");
  });

  it("a source whose duration cannot be probed cannot be timed (source_duration_unknown)", async () => {
    const { call, workspaceDir } = await make();
    writeFileSync(join(workspaceDir, "media", "notes.mp4"), "plain text");
    const src = ok(await call("media_source_open", { path: "media/notes.mp4" }));
    assert.equal(src.durationSec, null);
    const t = { version: 1, sourceArtifactId: src.sourceArtifactId, segments: [{ kind: "card", cardSeconds: 2 }] };
    refused(await call("story_timeline_build", { timeline: t }), "source_duration_unknown");
  });
});

describe("media story tools: event index", () => {
  it("an index for another source, or with fields the index shape does not have -> bad_index", async () => {
    for (const mode of ["bad-sha", "extra-field"]) {
      const { call } = await make();
      const { indexId } = await openAndIndex(call, mode);
      refused(await call("media_find_events", { indexArtifactId: indexId }), "bad_index");
    }
  });
});

describe("media story tools: facts and checks", () => {
  it("only data tools and media.factTools count as facts; host and MCP tools do not", async () => {
    const results = [
      { toolName: "stats_get_player", toolCallId: "c1", input: {}, output: "38", isError: false },
      { toolName: "host_scores", toolCallId: "c2", input: {}, output: "41", isError: false },
      { toolName: "mcp__pod__stats", toolCallId: "c3", input: {}, output: "44", isError: false },
    ];
    const plain = await make({ results });
    assert.deepEqual(ok(await plain.call("story_facts_collect")).facts.map((f) => f.toolName), ["stats_get_player"]);
    const listed = await make({ results, config: { factTools: ["host_scores"] } });
    assert.deepEqual(ok(await listed.call("story_facts_collect")).facts.map((f) => f.toolName), ["stats_get_player", "host_scores"]);
  });

  it("without an approved check-lines kind for the index's skill, only the built-in checks run", async () => {
    const { call } = await make({ kinds: ["make-index"] });
    const { indexId } = await openAndIndex(call);
    const checked = ok(await call("story_check_lines", { indexArtifactId: indexId, lines: [WRITER_LINES[1]] }));
    assert.deepEqual(checked.verdicts, [{ text: WRITER_LINES[1].text, ok: true, reasons: [] }]);
  });

  it("the check result and its step record which checker ran: the skill's kind or built-in", async () => {
    const withSkill = await make();
    const a = await openAndIndex(withSkill.call);
    const r1 = ok(await withSkill.call("story_check_lines", { indexArtifactId: a.indexId, lines: [WRITER_LINES[0]] }));
    assert.equal(r1.checker, `${SKILL}/check-lines`);
    assert.equal(withSkill.media.steps.at(-1).checker, `${SKILL}/check-lines`);

    const builtIn = await make({ kinds: ["make-index"] });
    const b = await openAndIndex(builtIn.call);
    const r2 = ok(await builtIn.call("story_check_lines", { indexArtifactId: b.indexId, lines: [WRITER_LINES[0]] }));
    assert.equal(r2.checker, "built-in");
    assert.equal(builtIn.media.steps.at(-1).checker, "built-in");
  });
});

describe("media story tools: errors the model sees", () => {
  const KEY = "sk-live-0123456789abcdefSECRET";
  /** A provider that fails every call and echoes a key in its error body. */
  async function leakyServer() {
    const server = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: `Incorrect API key provided: ${KEY}` } }));
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    disposers.push(() => new Promise((resolve) => server.close(resolve)));
    return `http://127.0.0.1:${server.address().port}/v1`;
  }

  it("a failed writer call -> model_call_failed with the router's code, never the provider's text", async () => {
    const baseUrl = await leakyServer();
    const { call } = await make({ inference: { roles: { writer: { route: "nim", model: "writer", baseUrl } } } });
    const { indexId } = await openAndIndex(call);
    const r = await call("story_draft_lines", { indexArtifactId: indexId, eventIds: ["ev_1"], brief: "b" });
    refused(r, "model_call_failed");
    assert.equal(r.code, "auth");
    assert.ok(!JSON.stringify(r).includes("sk-live"), JSON.stringify(r));
    assert.ok(!JSON.stringify(r).includes("127.0.0.1"), JSON.stringify(r));
  });

  it("a failed speech call -> speech_failed with its code only", async () => {
    const baseUrl = await leakyServer();
    const { call } = await make({ inference: { ...INFERENCE, speech: { route: "nim", format: "openai", model: "tts", voice: "v", baseUrl } } });
    const p = await openAndIndex(call);
    const checked = ok(await call("story_check_lines", { indexArtifactId: p.indexId, lines: [WRITER_LINES[0]] }));
    const r = await call("speech_synthesize", { linesArtifactId: checked.linesArtifactId, lineIds: ["line_1"] });
    refused(r, "speech_failed");
    assert.ok(!JSON.stringify(r).includes("sk-live"), JSON.stringify(r));
  });

  it("any other error -> failed with a generic message: no absolute path reaches the model", async () => {
    const { call, workspaceDir } = await make();
    writeFileSync(join(workspaceDir, "story"), "a file where the tools' directory should be");
    const r = await call("story_facts_collect");
    refused(r, "failed");
    assert.ok(!r.message.includes(workspaceDir) && !r.message.includes(tmp), r.message);
  });

  it("a job's error and facts reach the model capped (2 KiB, 8 KiB) with truncated: true, and without absolute paths", async () => {
    const { call } = await make();
    const big = ok(await call("media_job_start", { skill: SKILL, kind: "hand-off", input: { pad: 20000 } }));
    const st = ok(await call("media_job_status", { jobId: big.jobId, waitSec: 30 }));
    assert.equal(st.state, "succeeded", st.error);
    assert.equal(st.truncated, true);
    // Over the cap, facts become the first 8 KiB of their JSON.
    assert.equal(typeof st.facts, "string");
    assert.equal(st.facts.length, 8 * 1024);

    const failing = ok(await call("media_job_start", { skill: SKILL, kind: "hand-off", input: { fail: 5000 } }));
    const st2 = ok(await call("media_job_status", { jobId: failing.jobId, waitSec: 30 }));
    assert.equal(st2.state, "failed");
    assert.equal(st2.truncated, true);
    assert.ok(st2.error.length <= 2 * 1024, `${st2.error.length}`);
    assert.ok(!st2.error.includes("/Users/someone"), st2.error);

    const small = ok(await call("media_job_status", { jobId: ok(await call("media_job_start", { skill: SKILL, kind: "hand-off", input: {} })).jobId, waitSec: 30 }));
    assert.equal(small.truncated, undefined);
  });
});

describe("media story tools: jobs and sources", () => {
  it("media_job_status caps waitSec at 60 s, and a negative wait returns at once", async () => {
    const { call } = await make();
    const job = ok(await call("media_job_start", { skill: SKILL, kind: "hand-off", input: { sleep: 1 } }));
    assert.equal(ok(await call("media_job_status", { jobId: job.jobId, waitSec: -5 })).state, "running");
    const warnings = [];
    const onWarning = (w) => warnings.push(w.name);
    process.on("warning", onWarning);
    try {
      const st = ok(await call("media_job_status", { jobId: job.jobId, waitSec: 1e10 }));
      assert.equal(st.state, "succeeded", st.error);
    } finally {
      process.off("warning", onWarning);
    }
    assert.ok(!warnings.includes("TimeoutOverflowWarning"));
  });

  it("operator pythonPath is the default interpreter unless media.interpreters names one", async () => {
    const missing = join(tmp, "no-such-python");
    const a = await make({ pythonPath: missing });
    const jobA = ok(await a.call("media_job_start", { skill: SKILL, kind: "hand-off", input: {} }));
    const stA = ok(await a.call("media_job_status", { jobId: jobA.jobId, waitSec: 30 }));
    assert.equal(stA.state, "failed");
    assert.match(stA.error, /spawn_failed/);
    assert.ok(!stA.error.includes(missing), `no absolute path in what the model sees: ${stA.error}`);

    const b = await make({ pythonPath: missing, config: { interpreters: { default: ["python3"] } } });
    const jobB = ok(await b.call("media_job_start", { skill: SKILL, kind: "hand-off", input: {} }));
    assert.equal(ok(await b.call("media_job_status", { jobId: jobB.jobId, waitSec: 30 })).state, "succeeded");
  });

  it("media_source_open refuses a path outside the workspace, also through a symlink, and lists shared artifacts", async () => {
    const { call, workspaceDir } = await make();
    writeFileSync(join(tmp, "outside.mp4"), "outside");
    refused(await call("media_source_open", { path: join(tmp, "outside.mp4") }), "source_outside");
    refused(await call("media_source_open", { path: "../outside.mp4" }), "source_outside");
    symlinkSync(join(tmp, "outside.mp4"), join(workspaceDir, "media", "link.mp4"));
    refused(await call("media_source_open", { path: "media/link.mp4" }), "source_outside");

    const { src, indexId } = await openAndIndex(call);
    assert.deepEqual(src.shared, []);
    const later = await make({ workspaceDir });
    const again = ok(await later.call("media_source_open", { path: "media/game.mp4" }));
    assert.equal(again.sha256, src.sha256);
    assert.deepEqual(again.shared.map((a) => [a.artifactId, a.kind]), [[indexId, "event-index"]]);
    // The shared index is usable from the later run, for this source.
    ok(await later.call("media_find_events", { indexArtifactId: indexId }));
  });
});

describe("media story tools: role proxy", () => {
  it("a job gets a loopback role proxy when inference is configured; dispose closes it", async () => {
    const { call, media } = await make();
    const job = ok(await call("media_job_start", { skill: SKILL, kind: "hand-off", input: {} }));
    const st = ok(await call("media_job_status", { jobId: job.jobId, waitSec: 30 }));
    assert.match(st.facts.proxyUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
    await media.dispose();
    await assert.rejects(fetch(`${st.facts.proxyUrl}/role/writer`, { method: "POST" }));

    const none = await make({ inference: undefined });
    const job2 = ok(await none.call("media_job_start", { skill: SKILL, kind: "hand-off", input: {} }));
    assert.equal(ok(await none.call("media_job_status", { jobId: job2.jobId, waitSec: 30 })).facts.proxyUrl, null);
  });
});

describe("media story tools: prep jobs outlive the run", () => {
  const PREP_KINDS = [...APPROVED, "prep-index"];
  function newPrep(workspaceDir) {
    const prep = new MediaPrep({ config: { workspaceDir }, inference: INFERENCE, env: process.env });
    disposers.push(() => prep.close());
    return prep;
  }
  const prepIndex = (call, sourceArtifactId, input = {}) =>
    call("media_job_start", { skill: SKILL, kind: "prep-index", input: { events: EVENTS, ...input }, sourceArtifactId });

  it("a prep job keeps running after its run ends, succeeds, is shared, and a later run reads its status; non-prep jobs are cancelled", async () => {
    const workspaceDir = newWorkspace();
    const prep = newPrep(workspaceDir);
    const run1 = await make({ workspaceDir, prep, kinds: PREP_KINDS });
    const src = ok(await run1.call("media_source_open", { path: "media/game.mp4" }));
    const p = ok(await prepIndex(run1.call, src.sourceArtifactId, { sleep: 1, mode: "unshared" }));
    const h = ok(await run1.call("media_job_start", { skill: SKILL, kind: "hand-off", input: { sleep: 30 } }));
    await run1.media.dispose();
    assert.equal(ok(await run1.call("media_job_status", { jobId: h.jobId })).state, "canceled");

    const run2 = await make({ workspaceDir, prep, kinds: PREP_KINDS });
    const st = ok(await run2.call("media_job_status", { jobId: p.jobId, waitSec: 30 }));
    assert.equal(st.state, "succeeded", st.error);
    const indexId = st.artifacts[0].artifactId;
    // The job did not mark it shared; a prep job's artifacts are shared on success.
    const again = ok(await run2.call("media_source_open", { path: "media/game.mp4" }));
    assert.deepEqual(again.shared.map((a) => [a.artifactId, a.kind]), [[indexId, "event-index"]]);
    ok(await run2.call("media_find_events", { indexArtifactId: indexId }));
    // A job of another run that is not a prep job stays unknown.
    refused(await run2.call("media_job_status", { jobId: h.jobId }), "unknown_job");
  });

  it("closing the prep jobs cancels a running one", async () => {
    const workspaceDir = newWorkspace();
    const prep = newPrep(workspaceDir);
    const { call } = await make({ workspaceDir, prep, kinds: PREP_KINDS });
    const src = ok(await call("media_source_open", { path: "media/game.mp4" }));
    const p = ok(await prepIndex(call, src.sourceArtifactId, { sleep: 30 }));
    assert.equal(ok(await call("media_job_status", { jobId: p.jobId })).state, "running");
    await prep.close();
    assert.equal(ok(await call("media_job_status", { jobId: p.jobId })).state, "canceled");
  });

  it("a prep job's role-proxy token is refused once the job has ended", async () => {
    const workspaceDir = newWorkspace();
    const prep = newPrep(workspaceDir);
    const { call } = await make({ workspaceDir, prep, kinds: PREP_KINDS });
    const src = ok(await call("media_source_open", { path: "media/game.mp4" }));
    const p = ok(await prepIndex(call, src.sourceArtifactId, { mode: "leak-token" }));
    const st = ok(await call("media_job_status", { jobId: p.jobId, waitSec: 30 }));
    assert.equal(st.state, "succeeded", st.error);
    const { url, token } = st.facts;
    assert.match(token, /^[0-9a-f]{64}$/);
    const post = (bearer) => new Promise((resolve, reject) => {
      const req = http.request(`${url}/role/eyes`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` } },
        (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
      req.on("error", reject);
      req.end(JSON.stringify({ input: "x" }));
    });
    // Revocation is chained on the job's end; give that microtask-scale step a moment.
    for (let i = 0; i < 50 && (await post(token)) !== 401; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(await post(token), 401);
    // A job started after it still gets a working token.
    const p2 = ok(await prepIndex(call, src.sourceArtifactId, { mode: "leak-token", sleep: 1 }));
    const st2 = ok(await call("media_job_status", { jobId: p2.jobId, waitSec: 30 }));
    assert.notEqual(st2.facts.token, token);
  });

  it("a host that ran a prep job exits by itself, without closeMedia()", async () => {
    const workspaceDir = newWorkspace();
    const decl = { skill: SKILL, ...JSON.parse(readFileSync(join(pack, "jobs.json"), "utf8")).jobs.find((j) => j.kind === "prep-index") };
    const script = join(tmp, `host-${n++}.mjs`);
    writeFileSync(script, `
import { MediaPrep } from ${JSON.stringify(join(repoRoot, "dist/media/prep.js"))};
const o = JSON.parse(process.argv[2]);
const prep = new MediaPrep({ config: { workspaceDir: o.workspaceDir }, inference: o.inference, env: process.env });
const rec = await prep.start({ skillDir: o.skillDir, bundleSha256: o.sha, decl: o.decl, input: { events: o.events },
  source: { path: o.workspaceDir + "/media/game.mp4", sha256: o.sourceSha, rights: o.rights } }, { ended: false });
const st = await prep.status(rec.jobId, { waitSec: 30 });
console.log("state:" + st.state);
`);
    const arg = JSON.stringify({ workspaceDir, inference: INFERENCE, skillDir: pack, sha: SHA, decl, events: EVENTS, sourceSha: SOURCE_SHA, rights: RIGHTS });
    // Async spawn: this process also serves the mock model the job calls.
    const out = await new Promise((resolve) => {
      const child = spawn(process.execPath, [script, arg], { env: { ...process.env, ...allow(PREP_KINDS) } });
      let stdout = "";
      child.stdout.on("data", (c) => (stdout += c));
      child.stderr.on("data", (c) => (stdout += c));
      const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
      child.on("exit", (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout }); });
    });
    assert.deepEqual([out.code, out.signal], [0, null], `host did not exit by itself: ${out.stdout}`);
    assert.match(out.stdout, /state:succeeded/);
  });

  it("at most 4 prep jobs run at once (prep_busy)", async () => {
    const workspaceDir = newWorkspace();
    const prep = newPrep(workspaceDir);
    const { call } = await make({ workspaceDir, prep, kinds: PREP_KINDS });
    const src = ok(await call("media_source_open", { path: "media/game.mp4" }));
    for (let i = 0; i < 4; i++) ok(await prepIndex(call, src.sourceArtifactId, { sleep: 30 }));
    refused(await prepIndex(call, src.sourceArtifactId, { sleep: 30 }), "prep_busy");
    await prep.close();
  });

  it("without an engine's prep jobs the tools keep their own, closed with the tools", async () => {
    const { call, media } = await make({ kinds: PREP_KINDS });
    const src = ok(await call("media_source_open", { path: "media/game.mp4" }));
    const p = ok(await prepIndex(call, src.sourceArtifactId, { sleep: 30 }));
    await media.dispose();
    assert.equal(ok(await call("media_job_status", { jobId: p.jobId })).state, "canceled");
  });

  it("a prep declaration whose produces is not all per-game kinds (video) is dropped", async () => {
    const { media, call } = await make({ kinds: [...PREP_KINDS, "prep-video"] });
    refused(await call("media_job_start", { skill: SKILL, kind: "prep-video", input: {} }), "unknown_kind");
    assert.ok(!JSON.stringify(Object.values(media.tools).map((t) => t.description)).includes("prep-video"));
  });
});

// ---------------------------------------------------------------------------
// Engine wiring
// ---------------------------------------------------------------------------

const USAGE = { inputTokens: { total: 4, noCache: 4 }, outputTokens: { total: 2, text: 2 } };
const generated = (content) => ({
  content,
  finishReason: { unified: content.some((p) => p.type === "tool-call") ? "tool-calls" : "stop", raw: undefined },
  usage: USAGE,
  warnings: [],
});
const systemText = (call) => call.prompt.filter((m) => m.role === "system").map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
const isVerdictCall = (call) => /JSON verdict|fact-checker/.test(systemText(call));

function storyEngine(config) {
  const model = new MockLanguageModelV3({
    doGenerate: async (call) => {
      if (isVerdictCall(call)) return generated([{ type: "text", text: JSON.stringify({ isValid: true, discrepancies: [] }) }]);
      const toolMsgs = call.prompt.filter((m) => m.role === "tool").length;
      if (toolMsgs === 0) return generated([{ type: "tool-call", toolCallId: "t1", toolName: "host_scores", input: "{}" }]);
      if (toolMsgs === 1) return generated([{ type: "tool-call", toolCallId: "t2", toolName: "story_facts_collect", input: "{}" }]);
      return generated([{ type: "text", text: "Done." }]);
    },
  });
  const engine = new sportsclawEngine({
    thinkingBudget: 0,
    hostTools: { host_scores: { description: "scores", inputSchema: { type: "object", properties: {} }, execute: () => "Final 101-99" } },
    ...config,
  });
  engine.mainModel = model;
  engine.registry = { getInstalledSkills: () => [], getAllToolSpecs: () => [], getSkillName: () => undefined };
  engine.setToolAllowlist(["host_scores", "story_facts_collect"]);
  return { engine, model };
}

describe("engine wiring", () => {
  it("with config.media unset the engine offers none of the media tools", () => {
    const engine = new sportsclawEngine({ thinkingBudget: 0 });
    const names = engine.listToolNames();
    for (const name of MEDIA_TOOL_NAMES) assert.ok(!names.includes(name), name);
  });

  it("with config.media set the names are listed, and a host tool may not reuse one", () => {
    const workspaceDir = newWorkspace();
    const names = new sportsclawEngine({ thinkingBudget: 0, media: { workspaceDir } }).listToolNames();
    for (const name of MEDIA_TOOL_NAMES) assert.ok(names.includes(name), name);
    const clash = new sportsclawEngine({
      thinkingBudget: 0, media: { workspaceDir },
      hostTools: { story_render: { description: "x", inputSchema: { type: "object" }, execute: () => "x" } },
    });
    assert.throws(() => clash.listToolNames(), /collides with an engine tool/);
  });

  it("a run records mediaSteps on its trace, facts leave out host tools unless listed, and the prompt names the tools", async () => {
    const workspaceDir = newWorkspace();
    const { engine, model } = storyEngine({ media: { workspaceDir } });
    const result = await engine.runDetailed("Make the story.", { historyMode: "caller" });
    const factsOut = JSON.parse(result.toolResults.find((r) => r.toolName === "story_facts_collect").output);
    assert.deepEqual(factsOut.facts, []);
    assert.deepEqual(result.trace.mediaSteps, [{ tool: "story_facts_collect", artifactIds: [factsOut.factsArtifactId], input: {} }]);
    assert.deepEqual(result.trace.mediaReceipts, []);
    const prompt = systemText(model.doGenerateCalls[0]);
    assert.match(prompt, /story_facts_collect/);
    assert.match(prompt, /SKILL\.md/);

    const listed = storyEngine({ media: { workspaceDir, factTools: ["host_scores"] } });
    const r2 = await listed.engine.runDetailed("Make the story.", { historyMode: "caller" });
    const f2 = JSON.parse(r2.toolResults.find((r) => r.toolName === "story_facts_collect").output);
    assert.deepEqual(f2.facts, [{ factId: "fact_1", toolName: "host_scores" }]);
  });

  it("without config.media the prompt has no media section and the trace no media fields", async () => {
    const { model, engine } = storyEngine({});
    const result = await engine.runDetailed("Make the story.", { historyMode: "caller" });
    assert.doesNotMatch(systemText(model.doGenerateCalls[0]), /media_source_open|## Media stories/);
    assert.equal(result.trace.mediaSteps, undefined);
    assert.equal(result.trace.mediaReceipts, undefined);
  });

  it("a clearance passed in run options clears that run only", async () => {
    const model = new MockLanguageModelV3({
      doGenerate: async (call) => {
        if (isVerdictCall(call)) return generated([{ type: "text", text: JSON.stringify({ isValid: true, discrepancies: [] }) }]);
        const tools = call.prompt.filter((m) => m.role === "tool");
        const text = JSON.stringify(tools.slice(-1));
        const source = /art_[0-9a-f]{16}/.exec(JSON.stringify(tools))?.[0];
        if (tools.length === 0) return generated([{ type: "tool-call", toolCallId: "o1", toolName: "media_source_open", input: JSON.stringify({ path: "media/game.mp4" }) }]);
        if (/job_[0-9a-f]{16}|error_code/.test(text)) return generated([{ type: "text", text: "Done." }]);
        return generated([{ type: "tool-call", toolCallId: "s1", toolName: "media_job_start", input: JSON.stringify({ skill: SKILL, kind: "make-index", input: { events: EVENTS }, sourceArtifactId: source }) }]);
      },
    });
    const engine = new sportsclawEngine({ thinkingBudget: 0, media: { workspaceDir: newWorkspace() } });
    engine.mainModel = model;
    engine.registry = { getInstalledSkills: () => [], getAllToolSpecs: () => [], getSkillName: () => undefined };
    engine.skillGuides = GUIDES;
    engine.setToolAllowlist(["media_source_open", "media_job_start"]);
    process.env[JOB_ALLOWLIST_ENV] = allow(APPROVED)[JOB_ALLOWLIST_ENV];
    const started = (result) => JSON.parse(result.toolResults.find((r) => r.toolName === "media_job_start").output);
    try {
      const first = await engine.runDetailed("Index the game.", { historyMode: "caller", mediaClearances: CLEARED });
      assert.match(started(first).jobId ?? "", /^job_/, JSON.stringify(started(first)));
      const second = await engine.runDetailed("Index the game.", { historyMode: "caller" });
      assert.equal(started(second).error_code, "rights_required");
    } finally {
      delete process.env[JOB_ALLOWLIST_ENV];
    }
  });

  it("a job's role-proxy call leaves its receipt on the run trace", async () => {
    const model = new MockLanguageModelV3({
      doGenerate: async (call) => {
        if (isVerdictCall(call)) return generated([{ type: "text", text: JSON.stringify({ isValid: true, discrepancies: [] }) }]);
        const toolText = JSON.stringify(call.prompt.filter((m) => m.role === "tool"));
        const jobId = /job_[0-9a-f]{16}/.exec(toolText)?.[0];
        if (!jobId) {
          return generated([{ type: "tool-call", toolCallId: "t1", toolName: "media_job_start", input: JSON.stringify({ skill: SKILL, kind: "hand-off", input: { callProxy: true } }) }]);
        }
        if (!toolText.includes("succeeded")) {
          return generated([{ type: "tool-call", toolCallId: "t2", toolName: "media_job_status", input: JSON.stringify({ jobId, waitSec: 30 }) }]);
        }
        return generated([{ type: "text", text: "Done." }]);
      },
    });
    const engine = new sportsclawEngine({ thinkingBudget: 0, media: { workspaceDir: newWorkspace() }, inference: { roles: { eyes: INFERENCE.roles.eyes } } });
    engine.mainModel = model;
    engine.registry = { getInstalledSkills: () => [], getAllToolSpecs: () => [], getSkillName: () => undefined };
    engine.skillGuides = GUIDES;
    engine.setToolAllowlist(["media_job_start", "media_job_status"]);
    process.env[JOB_ALLOWLIST_ENV] = allow(APPROVED)[JOB_ALLOWLIST_ENV];
    try {
      const result = await engine.runDetailed("Run the job.", { historyMode: "caller" });
      assert.deepEqual(result.trace.mediaSteps.map((s) => s.tool), ["media_job_start", "media_job_status"]);
      const status = JSON.parse(result.toolResults.find((r) => r.toolName === "media_job_status").output);
      assert.equal(status.facts.proxyStatus, 200);
      assert.deepEqual(result.trace.mediaReceipts.map((r) => [r.kind, r.modelId, r.status]), [["generate", "eyes-model", "completed"]]);
    } finally {
      delete process.env[JOB_ALLOWLIST_ENV];
    }
  });

  /** An engine whose model makes the tool calls in `steps` (one per turn), then answers "Done.". */
  function scriptedEngine(config) {
    let steps = [];
    const model = new MockLanguageModelV3({
      doGenerate: async (call) => {
        if (isVerdictCall(call)) return generated([{ type: "text", text: JSON.stringify({ isValid: true, discrepancies: [] }) }]);
        const tools = call.prompt.filter((m) => m.role === "tool");
        const next = steps[tools.length];
        if (!next) return generated([{ type: "text", text: "Done." }]);
        const input = typeof next[1] === "function" ? next[1](JSON.stringify(tools)) : next[1];
        return generated([{ type: "tool-call", toolCallId: `c${tools.length}`, toolName: next[0], input: JSON.stringify(input) }]);
      },
    });
    const engine = new sportsclawEngine({ thinkingBudget: 0, ...config });
    engine.mainModel = model;
    engine.registry = { getInstalledSkills: () => [], getAllToolSpecs: () => [], getSkillName: () => undefined };
    engine.skillGuides = GUIDES;
    engine.setToolAllowlist([...MEDIA_TOOL_NAMES]);
    const run = async (s) => {
      steps = s;
      return engine.runDetailed("Go.", { historyMode: "caller" });
    };
    const out = (result, tool) => JSON.parse(result.toolResults.filter((r) => r.toolName === tool).at(-1).output);
    return { engine, run, out };
  }

  it("a prep job outlives its run: a later run reads it and sees its artifact shared; its late receipt goes to mediaPrepReceipts; closeMedia cancels", async () => {
    const workspaceDir = newWorkspace();
    const { engine, run, out } = scriptedEngine({
      media: { workspaceDir, clearances: CLEARED }, inference: { roles: { eyes: INFERENCE.roles.eyes } },
    });
    process.env[JOB_ALLOWLIST_ENV] = allow([...APPROVED, "prep-index"])[JOB_ALLOWLIST_ENV];
    const startPrep = (sleep) => (tools) => ({
      skill: SKILL, kind: "prep-index", input: { events: EVENTS, sleep }, sourceArtifactId: /art_[0-9a-f]{16}/.exec(tools)[0],
    });
    try {
      const first = await run([["media_source_open", { path: "media/game.mp4" }], ["media_job_start", startPrep(2)]]);
      const { jobId } = out(first, "media_job_start");
      assert.match(jobId ?? "", /^job_/, JSON.stringify(out(first, "media_job_start")));
      assert.deepEqual(first.trace.mediaReceipts, [], "the job's model call comes after its run ended");

      const second = await run([["media_job_status", { jobId, waitSec: 30 }], ["media_source_open", { path: "media/game.mp4" }]]);
      const st = out(second, "media_job_status");
      assert.equal(st.state, "succeeded", st.error);
      assert.deepEqual(out(second, "media_source_open").shared.map((a) => a.artifactId), [st.artifacts[0].artifactId]);
      assert.deepEqual(second.trace.mediaReceipts, []);
      assert.deepEqual(engine.mediaPrepReceipts().map((r) => [r.kind, r.modelId, r.status]), [["generate", "eyes-model", "completed"]]);
      assert.deepEqual(engine.mediaPrepReceipts(), [], "drained");

      const third = await run([["media_source_open", { path: "media/game.mp4" }], ["media_job_start", startPrep(30)]]);
      const slow = out(third, "media_job_start").jobId;
      await engine.closeMedia();
      const fourth = await run([["media_job_status", { jobId: slow }]]);
      assert.equal(out(fourth, "media_job_status").state, "canceled");
    } finally {
      delete process.env[JOB_ALLOWLIST_ENV];
      await engine.closeMedia();
    }
  });

  it("a run that fails before its turn leaves no trace, not the last run's trace with its steps", async () => {
    const { engine, run } = scriptedEngine({ media: { workspaceDir: newWorkspace() } });
    const first = await run([["story_facts_collect", {}]]);
    assert.equal(first.trace.mediaSteps.length, 1);
    await assert.rejects(engine.runDetailed("Go.", { historyMode: "caller", media: [{ kind: "nope" }] }));
    assert.equal(engine.lastRunTrace, null);
  });

  it("tool results are kept for story_facts_collect only when the run has media tools", async () => {
    const { engine } = storyEngine({});
    await engine.runDetailed("Make the story.", { historyMode: "caller" });
    assert.deepEqual(engine._runToolResults, []);
  });
});
