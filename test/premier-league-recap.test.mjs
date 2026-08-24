import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  createPremierLeagueRecap,
  extractScheduleFixtures,
  selectTargetMatchweek,
} from "../dist/premier-league-recap.js";

const roots = [];

function outputRoot() {
  const root = join("test", `.tmp-premier-league-recap-${randomUUID()}`);
  roots.push(root);
  return root;
}

function fixture(matchweek, index, overrides = {}) {
  return {
    event_id: `mw${matchweek}-${index}`,
    matchweek,
    status: "closed",
    date: `2026-08-${String(15 + index).padStart(2, "0")}T15:00:00.000Z`,
    home_team: { name: `Home ${index}` },
    away_team: { name: `Away ${index}` },
    home_score: index % 4,
    away_score: index % 3,
    ...overrides,
  };
}

function schedule(count = 10) {
  return {
    data: {
      events: Array.from({ length: count }, (_, index) => fixture(1, index + 1)),
    },
  };
}

function dependencies(callLog = []) {
  return {
    async fetch(command, args) {
      callLog.push({ command, args });
      if (command === "get_season_schedule") return schedule();
      if (command === "get_season_standings") return { table: [{ position: 1, team: "Alpha" }] };
      if (command === "get_season_leaders") {
        return { leaders: [{ name: "One", fpl_id: 30 }, { name: "Two", fpl_id: 10 }] };
      }
      if (command === "get_player_profile") return { player: { fpl_id: args.fpl_id, available: true } };
      throw new Error(`Unexpected command ${command}`);
    },
    async runProvider() {
      throw new Error("provider must not run in dry-run mode");
    },
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Premier League Monday recap review package", () => {
  it("parses the native sports-skills envelope, round_name and qualifier fields", () => {
    const parsed = extractScheduleFixtures({
      status: true,
      data: {
        schedules: [
          {
            id: "evt-1",
            status: "closed",
            start_time: "2026-08-21T19:00:00Z",
            round_name: "Matchday 1",
            competitors: [
              { qualifier: "home", team: { name: "Arsenal" }, score: 3 },
              { qualifier: "away", team: { name: "Coventry" }, score: 0 },
            ],
          },
        ],
      },
    });
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].matchweek, 1);
    assert.equal(parsed[0].homeTeam, "Arsenal");
    assert.equal(parsed[0].awayTeam, "Coventry");
    assert.equal(parsed[0].homeScore, "3");
    assert.equal(parsed[0].awayScore, "0");
  });

  it("refuses an incomplete matchweek before fetching context or writing files", async () => {
    const root = outputRoot();
    const calls = [];
    const deps = dependencies(calls);
    deps.fetch = async (command, args) => {
      calls.push({ command, args });
      if (command === "get_season_schedule") return schedule(9);
      throw new Error("gate should stop before this call");
    };

    await assert.rejects(
      createPremierLeagueRecap(
        { outputRoot: root, seasonId: "premier-league-2026", matchweek: 1, asOf: new Date("2026-08-24T09:00:00Z") },
        deps,
      ),
      /Refusing Premier League matchweek 1 recap: expected exactly 10 fixtures, found 9/,
    );
    assert.deepEqual(calls.map((call) => call.command), ["get_season_schedule"]);
    await assert.rejects(readdir(root), /ENOENT/);
  });

  it("refuses missing event IDs and open fixtures before generation", async () => {
    for (const [override, expected] of [
      [{ event_id: "" }, /empty event IDs/],
      [{ status: "scheduled" }, /not closed/],
    ]) {
      const root = outputRoot();
      let providerCalls = 0;
      const deps = dependencies();
      deps.fetch = async (command) => {
        if (command !== "get_season_schedule") throw new Error("gate should stop before this call");
        const data = schedule();
        Object.assign(data.data.events[0], override);
        return data;
      };
      deps.runProvider = async () => {
        providerCalls++;
        return { exitCode: 0, stdout: "", stderr: "" };
      };

      await assert.rejects(
        createPremierLeagueRecap(
          {
            outputRoot: root,
            seasonId: "premier-league-2026",
            matchweek: 1,
            asOf: new Date("2026-08-24T09:00:00Z"),
            generate: true,
            imageCommand: ["provider"],
          },
          deps,
        ),
        expected,
      );
      assert.equal(providerCalls, 0);
      await assert.rejects(readdir(root), /ENOENT/);
    }
  });

  it("deduplicates an identical evidence package by its hash", async () => {
    const root = outputRoot();
    await mkdir(root, { recursive: true });
    const options = {
      outputRoot: root,
      seasonId: "premier-league-2026",
      matchweek: 1,
      asOf: new Date("2026-08-24T09:00:00Z"),
    };

    const first = await createPremierLeagueRecap(options, dependencies());
    const before = await readFile(join(first.outputDir, "evidence.json"), "utf-8");
    const second = await createPremierLeagueRecap(options, dependencies());
    const after = await readFile(join(second.outputDir, "evidence.json"), "utf-8");

    assert.equal(first.deduped, false);
    assert.equal(second.deduped, true);
    assert.equal(second.outputDir, first.outputDir);
    assert.equal(second.evidenceHash, first.evidenceHash);
    assert.equal(after, before);
    assert.deepEqual((await readdir(first.outputDir)).sort(), [
      "RESULTS.md",
      "concept.md",
      "evidence.json",
      "overlays.json",
      "qa.json",
      "receipts.jsonl",
      "scenes.json",
      "style.json",
    ]);
  });

  it("makes every scene fact and overlay traceable to evidence", async () => {
    const result = await createPremierLeagueRecap(
      {
        outputRoot: outputRoot(),
        seasonId: "premier-league-2026",
        matchweek: 1,
        asOf: new Date("2026-08-24T09:00:00Z"),
      },
      dependencies(),
    );
    const evidence = JSON.parse(await readFile(join(result.outputDir, "evidence.json"), "utf-8"));
    const scenes = JSON.parse(await readFile(join(result.outputDir, "scenes.json"), "utf-8"));
    const overlays = JSON.parse(await readFile(join(result.outputDir, "overlays.json"), "utf-8"));
    const qa = JSON.parse(await readFile(join(result.outputDir, "qa.json"), "utf-8"));
    const refs = new Set(evidence.evidenceItems.map((item) => item.ref));
    const claims = [
      ...scenes.scenes.flatMap((scene) => scene.facts),
      ...overlays.overlays,
    ];

    assert.ok(claims.length > 0);
    for (const claim of claims) {
      assert.ok(claim.evidenceRefs.length > 0, `missing references for ${claim.text}`);
      assert.ok(claim.evidenceRefs.every((ref) => refs.has(ref)), `unknown reference for ${claim.text}`);
    }
    assert.equal(qa.passed, true);
    assert.equal(qa.checks.everyFactTraceable, true);
    assert.equal(qa.checks.generationRequested, false);
    assert.equal(qa.checks.publishingEnabled, false);
  });

  it("selects the same latest started matchweek regardless of schedule order", () => {
    const raw = {
      schedule: [
        ...Array.from({ length: 10 }, (_, index) => fixture(4, index + 1, { date: `2026-08-${String(8 + index).padStart(2, "0")}T15:00:00Z` })),
        ...Array.from({ length: 10 }, (_, index) => fixture(5, index + 1, { date: `2026-08-${String(15 + index).padStart(2, "0")}T15:00:00Z` })),
        ...Array.from({ length: 10 }, (_, index) => fixture(6, index + 1, { date: `2026-09-${String(5 + index).padStart(2, "0")}T15:00:00Z`, status: "scheduled" })),
      ],
    };
    const fixtures = extractScheduleFixtures(raw);
    const reversed = extractScheduleFixtures({ schedule: [...raw.schedule].reverse() });
    const asOf = new Date("2026-08-25T23:00:00Z");

    assert.equal(selectTargetMatchweek(fixtures, asOf), 5);
    assert.equal(selectTargetMatchweek(reversed, asOf), 5);
  });
});

describe("Premier League recap option validation", () => {
  it("rejects an invalid --as-of date without blaming --season-id", async () => {
    let fetchCalls = 0;
    await assert.rejects(
      () =>
        createPremierLeagueRecap(
          { asOf: new Date("not-a-date"), outputRoot: outputRoot() },
          {
            fetch: async () => {
              fetchCalls++;
              return {};
            },
          },
        ),
      (error) => {
        assert.match(error.message, /as-of/i, "error must name --as-of");
        assert.doesNotMatch(error.message, /season-id/i, "must not blame --season-id");
        return true;
      },
    );
    assert.equal(fetchCalls, 0, "must fail before fetching the schedule");
  });
});
