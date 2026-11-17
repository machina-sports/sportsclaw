/**
 * Media story tools: the agent runs every step, and the engine enforces the order.
 * Real job runner, real artifact store, a fixture pack (test/fixtures/media/pack-story),
 * a local chat server as the writer, the mock speech route and a tiny generated mp4.
 */

import assert from "node:assert/strict";
import http from "node:http";
import { after, describe, it } from "node:test";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
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
  roles: { writer: { route: "nim", model: "writer", baseUrl: `http://127.0.0.1:${writer.address().port}/v1` } },
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
    config: { workspaceDir, ...over.config },
    guides: GUIDES,
    inference: "inference" in over ? over.inference : INFERENCE,
    runId,
    getToolResults: () => over.results ?? RESULTS,
    env: { ...process.env, ...allow(over.kinds ?? APPROVED) },
    isDataTool: over.isDataTool ?? ((name) => name === "stats_get_player"),
    ...(over.pythonPath ? { pythonPath: over.pythonPath } : {}),
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
  const src = ok(await call("media_source_open", { path: "media/game.mp4", rights: RIGHTS }));
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
    const { media, call, workspaceDir, runId } = await make();
    const { src, job, indexId } = await openAndIndex(call);
    assert.ok(Math.abs(src.durationSec - 12) < 0.5, `duration ${src.durationSec}`);

    const found = ok(await call("media_find_events", { indexArtifactId: indexId, people: ["Ann Smith"] }));
    assert.deepEqual(found.events, [{ eventId: "ev_1", period: 1, clock: "0:30", label: "Smith 3PT jump shot", people: ["Ann Smith"] }]);

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

    assert.deepEqual(media.steps, [
      { tool: "media_source_open", artifactIds: [src.sourceArtifactId] },
      { tool: "media_job_start", artifactIds: [], jobId: job.jobId },
      { tool: "media_job_status", artifactIds: [indexId], jobId: job.jobId },
      { tool: "media_find_events", artifactIds: [] },
      { tool: "story_facts_collect", artifactIds: [facts.factsArtifactId] },
      { tool: "story_draft_lines", artifactIds: [] },
      { tool: "story_check_lines", artifactIds: [checked.linesArtifactId] },
      { tool: "speech_synthesize", artifactIds: voices },
      { tool: "story_timeline_build", artifactIds: [built.timelineArtifactId] },
      { tool: "story_render", artifactIds: [video.videoArtifactId] },
    ]);
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

  it("a renderer that is not approved, or does not produce video, is refused", { skip: NO_FFMPEG }, async () => {
    const { call } = await make();
    const p = await prepared(call);
    const built = ok(await call("story_timeline_build", { timeline: timelineOf(p) }));
    refused(await call("story_render", { timelineArtifactId: built.timelineArtifactId, renderer: `${SKILL}/secret-kind` }), "unknown_kind");
    refused(await call("story_render", { timelineArtifactId: built.timelineArtifactId, renderer: `${SKILL}/hand-off` }), "renderer_invalid");
  });

  it("the plain renderer needs cleared rights unless the operator turned the check off", { skip: NO_FFMPEG }, async () => {
    const { call } = await make({ kinds: [] });
    const src = ok(await call("media_source_open", { path: "media/game.mp4" }));
    const t = { version: 1, sourceArtifactId: src.sourceArtifactId, segments: [{ kind: "clip", startSec: 1, endSec: 3 }] };
    const built = ok(await call("story_timeline_build", { timeline: t }));
    refused(await call("story_render", { timelineArtifactId: built.timelineArtifactId }), "rights_required");

    const off = await make({ kinds: [], config: { rightsCheck: "off" } });
    const src2 = ok(await off.call("media_source_open", { path: "media/game.mp4" }));
    const built2 = ok(await off.call("story_timeline_build", { timeline: { ...t, sourceArtifactId: src2.sourceArtifactId } }));
    const video = ok(await off.call("story_render", { timelineArtifactId: built2.timelineArtifactId }));
    assert.equal(video.rightsCheck, "off (operator)");
  });
});

describe("media story tools: timelines", () => {
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
    const src = ok(await call("media_source_open", { path: "media/notes.mp4", rights: RIGHTS }));
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
    assert.deepEqual(result.trace.mediaSteps, [{ tool: "story_facts_collect", artifactIds: [factsOut.factsArtifactId] }]);
    const prompt = systemText(model.doGenerateCalls[0]);
    assert.match(prompt, /story_facts_collect/);
    assert.match(prompt, /SKILL\.md/);

    const listed = storyEngine({ media: { workspaceDir, factTools: ["host_scores"] } });
    const r2 = await listed.engine.runDetailed("Make the story.", { historyMode: "caller" });
    const f2 = JSON.parse(r2.toolResults.find((r) => r.toolName === "story_facts_collect").output);
    assert.deepEqual(f2.facts, [{ factId: "fact_1", toolName: "host_scores" }]);
  });

  it("without config.media the prompt has no media section", async () => {
    const { model, engine } = storyEngine({});
    await engine.runDetailed("Make the story.", { historyMode: "caller" });
    assert.doesNotMatch(systemText(model.doGenerateCalls[0]), /media_source_open|## Media stories/);
  });
});
