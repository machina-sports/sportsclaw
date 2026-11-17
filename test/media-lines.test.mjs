/**
 * Media lines — facts from tool results, drafted lines, and the checks every line must pass.
 */

import assert from "node:assert/strict";
import http from "node:http";
import { describe, it, after } from "node:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const { collectFacts, draftLines, checkLines, jobLineChecker, LinesError } = await import(join(repoRoot, "dist/media/lines.js"));
const { LocalJobRunner } = await import(join(repoRoot, "dist/media/jobs.js"));
const { ArtifactStore } = await import(join(repoRoot, "dist/media/artifacts.js"));
const { bundleSha256, approvedJobKinds, JOB_ALLOWLIST_ENV } = await import(join(repoRoot, "dist/media/bundle.js"));

const tmp = mkdtempSync(join(tmpdir(), "lines-test-"));
// Sealed bundles go to os.tmpdir(); keep ours private (see media-jobs.test.mjs).
const SEAL_TMP = join(tmp, "sealed");
mkdirSync(SEAL_TMP);
process.env.TMPDIR = SEAL_TMP;
after(() => rmSync(tmp, { recursive: true, force: true }));

const EVENTS = [
  { eventId: "ev_1", actionId: "1", period: 1, clockSec: 312, label: "Jokic 3PT jump shot", type: "shot", people: ["Nikola Jokic"], videoSec: 40, startSec: 34, endSec: 44 },
  { eventId: "ev_2", actionId: "2", period: 4, clockSec: 15, label: "Murray driving layup", type: "shot", people: ["Jamal Murray"], videoSec: 900, startSec: 894, endSec: 904 },
];
const FACTS = [{ factId: "fact_1", toolName: "nba_box_score", output: '{"player":"Nikola Jokic","pts":38}' }];

describe("collectFacts", () => {
  it("numbers data-tool results in order and leaves errors out", () => {
    const facts = collectFacts([
      { toolName: "nba_box_score", toolCallId: "a", input: {}, output: '{"pts":38}', isError: false },
      { toolName: "nba_scores", toolCallId: "b", input: {}, output: "timeout", isError: true },
      { toolName: "nba_standings", toolCallId: "c", input: {}, output: "Nuggets 50-20", isError: false },
    ]);
    assert.deepEqual(facts, [
      { factId: "fact_1", toolName: "nba_box_score", output: '{"pts":38}' },
      { factId: "fact_2", toolName: "nba_standings", output: "Nuggets 50-20" },
    ]);
  });
});

describe("checkLines (built-in checks)", () => {
  it("a cite naming no known event or fact -> unknown_cite", async () => {
    const { verdicts, passed } = await checkLines({ lines: [{ text: "Jokic hits from deep.", cites: ["ev_x"] }], events: EVENTS, facts: FACTS });
    assert.deepEqual(verdicts, [{ text: "Jokic hits from deep.", ok: false, reasons: ["unknown_cite"] }]);
    assert.deepEqual(passed, []);
  });

  it("a line with no cites -> no_cite", async () => {
    const { verdicts } = await checkLines({ lines: [{ text: "What a night.", cites: [] }], events: EVENTS, facts: FACTS });
    assert.deepEqual(verdicts, [{ text: "What a night.", ok: false, reasons: ["no_cite"] }]);
  });

  it("a number not in the cited evidence -> unsupported_number; citing a fact that holds it passes", async () => {
    const bad = await checkLines({ lines: [{ text: "Jokic scores 38.", cites: ["ev_1"] }], events: EVENTS, facts: FACTS });
    assert.deepEqual(bad.verdicts, [{ text: "Jokic scores 38.", ok: false, reasons: ["unsupported_number"] }]);
    const good = await checkLines({ lines: [{ text: "Jokic scores 38.", cites: ["ev_1", "fact_1"] }], events: EVENTS, facts: FACTS });
    assert.deepEqual(good.verdicts, [{ text: "Jokic scores 38.", ok: true, reasons: [] }]);
  });

  it("collects every reason of a line", async () => {
    const { verdicts } = await checkLines({ lines: [{ text: "Jokic scores 38.", cites: ["ev_x", "ev_1"] }], events: EVENTS, facts: FACTS });
    assert.deepEqual(verdicts[0].reasons, ["unknown_cite", "unsupported_number"]);
  });

  it("passed holds only passing lines, numbered line_1.. in order", async () => {
    const { verdicts, passed } = await checkLines({
      lines: [
        { text: "Jokic from deep.", cites: ["ev_1"] },
        { text: "Nobody saw it coming.", cites: [] },
        { text: "Murray finishes at the rim.", cites: ["ev_2"] },
      ],
      events: EVENTS,
      facts: FACTS,
    });
    assert.deepEqual(verdicts.map((v) => v.ok), [true, false, true]);
    assert.deepEqual(passed, [
      { text: "Jokic from deep.", cites: ["ev_1"], lineId: "line_1" },
      { text: "Murray finishes at the rim.", cites: ["ev_2"], lineId: "line_2" },
    ]);
  });
});

describe("checkLines (skill checker)", () => {
  const LINES = [
    { text: "Jokic from deep.", cites: ["ev_1"] },
    { text: "The crowd goes wild.", cites: ["ev_2"] },
  ];

  it("a checker verdict ok:false fails a line the built-in checks passed, keeping its reason", async () => {
    let seen;
    const checker = async (lines, evidence) => {
      seen = { lines, evidence };
      return lines.map((l) => ({ text: l.text, ok: !l.text.includes("crowd"), reasons: l.text.includes("crowd") ? ["crowd_not_in_record"] : [] }));
    };
    const { verdicts, passed } = await checkLines({ lines: LINES, events: EVENTS, facts: FACTS, checker });
    assert.deepEqual(seen, { lines: LINES, evidence: { events: EVENTS, facts: FACTS } });
    assert.deepEqual(verdicts, [
      { text: "Jokic from deep.", ok: true, reasons: [] },
      { text: "The crowd goes wild.", ok: false, reasons: ["crowd_not_in_record"] },
    ]);
    assert.deepEqual(passed.map((l) => l.lineId), ["line_1"]);
  });

  it("the checker runs on lines the built-in checks failed; reasons are built-in then checker", async () => {
    const checker = async (lines) => lines.map((l) => ({ text: l.text, ok: false, reasons: ["nope"] }));
    const { verdicts } = await checkLines({ lines: [{ text: "x", cites: [] }], events: EVENTS, facts: FACTS, checker });
    assert.deepEqual(verdicts, [{ text: "x", ok: false, reasons: ["no_cite", "nope"] }]);
  });

  it("a checker that throws or answers the wrong length fails every line with checker_failed", async () => {
    for (const checker of [async () => { throw new Error("boom"); }, async () => [{ text: "Jokic from deep.", ok: true, reasons: [] }]]) {
      const { verdicts, passed } = await checkLines({ lines: LINES, events: EVENTS, facts: FACTS, checker });
      assert.deepEqual(verdicts.map((v) => v.reasons), [["checker_failed"], ["checker_failed"]]);
      assert.deepEqual(passed, []);
    }
  });
});

describe("jobLineChecker", () => {
  const SKILL = "pack-lines";
  const pack = join(tmp, "packs", SKILL);
  cpSync(join(repoRoot, "test/fixtures/media/pack-lines"), pack, { recursive: true });

  let n = 0;
  async function setup() {
    const sha = await bundleSha256(pack);
    const env = { [JOB_ALLOWLIST_ENV]: JSON.stringify([{ skill: SKILL, kind: "check-lines", bundleSha256: sha }]) };
    const decls = await approvedJobKinds([{ id: SKILL, name: SKILL, description: "", body: "", dir: pack }], env);
    const workspaceDir = join(tmp, `ws-${n++}`);
    mkdirSync(workspaceDir, { recursive: true });
    const runner = new LocalJobRunner({ store: new ArtifactStore({ workspaceDir, runId: "run_1" }), config: { workspaceDir } });
    return { runner, skill: { skillDir: pack, bundleSha256: sha, decls } };
  }

  it("runs the check-lines job and its verdicts fail a line", async () => {
    const { runner, skill } = await setup();
    const { verdicts, passed } = await checkLines({
      lines: [{ text: "Jokic from deep.", cites: ["ev_1"] }, { text: "The crowd goes wild.", cites: ["ev_2"] }],
      events: EVENTS,
      facts: FACTS,
      checker: jobLineChecker({ runner, skill }),
    });
    assert.deepEqual(verdicts, [
      { text: "Jokic from deep.", ok: true, reasons: [] },
      { text: "The crowd goes wild.", ok: false, reasons: ["crowd_not_in_record"] },
    ]);
    assert.deepEqual(passed.map((l) => l.text), ["Jokic from deep."]);
  });

  it("fails closed: a failed job, a short verdict list, or an unapproved kind fails every line", async () => {
    const { runner, skill } = await setup();
    for (const [first, kind] of [["crash", undefined], ["short", undefined], ["Jokic from deep.", "no-such-kind"]]) {
      const lines = [{ text: first, cites: ["ev_1"] }, { text: "Murray at the rim.", cites: ["ev_2"] }];
      const verdicts = await jobLineChecker({ runner, skill, kind })(lines, { events: EVENTS, facts: FACTS });
      assert.deepEqual(verdicts, lines.map((l) => ({ text: l.text, ok: false, reasons: ["checker_failed"] })), `${first} / ${kind}`);
    }
  });
});

/** Runs `fn(baseUrl, prompts)` against a chat server that answers every request with `reply`. */
async function withModel(reply, fn) {
  const prompts = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      prompts.push(JSON.parse(body).messages.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n"));
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        id: "c1", object: "chat.completion", created: 1, model: "writer",
        choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}/v1`, prompts);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
const writerAt = (baseUrl) => ({ roles: { writer: { route: "nim", model: "writer", baseUrl } } });

describe("draftLines", () => {
  const LINES = [{ text: "Jokic from deep.", cites: ["ev_1"] }, { text: "Murray at the rim.", cites: ["ev_2"] }];

  it("returns the writer's JSON array of lines, and the prompt carries brief, events, facts and maxLines", async () => {
    await withModel(JSON.stringify(LINES), async (baseUrl, prompts) => {
      const lines = await draftLines({ inference: writerAt(baseUrl), brief: "A Nuggets recap.", events: EVENTS, facts: FACTS, maxLines: 4 });
      assert.deepEqual(lines, LINES);
      assert.equal(prompts.length, 1);
      for (const s of ["A Nuggets recap.", "ev_1", "Jokic 3PT jump shot", "Nikola Jokic", "fact_1", '"pts":38', "4"]) {
        assert.ok(prompts[0].includes(s), `prompt lacks ${s}`);
      }
    });
  });

  it("accepts a single ```json fence and keeps only the first maxLines", async () => {
    await withModel("```json\n" + JSON.stringify(LINES) + "\n```", async (baseUrl) => {
      const lines = await draftLines({ inference: writerAt(baseUrl), brief: "b", events: EVENTS, facts: FACTS, maxLines: 1 });
      assert.deepEqual(lines, [LINES[0]]);
    });
  });

  it("throws draft_unusable on prose, a wrong shape, or the mock route's echo", async () => {
    const isUnusable = (err) => err instanceof LinesError && err.code === "draft_unusable";
    for (const reply of ["Here are your lines: Jokic from deep.", '[{"text":"","cites":[]}]', '[{"text":"x","cites":"ev_1"}]', '{"text":"x"}']) {
      await withModel(reply, async (baseUrl) => {
        await assert.rejects(draftLines({ inference: writerAt(baseUrl), brief: "b", events: EVENTS, facts: FACTS, maxLines: 3 }), isUnusable, reply);
      });
    }
    await assert.rejects(
      draftLines({ inference: { roles: { writer: { route: "mock", model: "m" } } }, brief: "b", events: EVENTS, facts: FACTS, maxLines: 3 }),
      isUnusable,
    );
  });
});
