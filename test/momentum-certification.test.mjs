/**
 * Momentum seven-sport certification artifact — honesty checks.
 *
 * This suite guards a claim, not a code path. The certification artifact says
 * what evidence we actually hold for each of the seven momentum sports, and
 * these tests exist to stop that artifact from quietly upgrading historical or
 * synthetic evidence into a live certification we cannot produce receipts for.
 *
 * Pure file reads — no LLM, no network, no build output required.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const jsonPath = join(repoRoot, "docs/sports-data/momentum-certification.json");
const mdPath = join(repoRoot, "docs/sports-data/momentum-certification.md");
const demoReadmePath = join(repoRoot, "demo/vault_data/README.md");

const rawJson = readFileSync(jsonPath, "utf8");
const cert = JSON.parse(rawJson);
const markdown = readFileSync(mdPath, "utf8");
const demoReadme = readFileSync(demoReadmePath, "utf8");

const EXPECTED_SPORTS = ["nfl", "mlb", "nba", "nhl", "wnba", "cfb", "cbb"];
const LIVE_REPORTED_SPORTS = ["mlb", "wnba"];
const REVALIDATION_AT = "2026-08-08T14:29:13Z";

const rows = cert.sports;
const bySport = new Map(rows.map((row) => [row.sport, row]));

describe("certification roster", () => {
  it("covers exactly the seven momentum sports with no duplicates", () => {
    const sports = rows.map((row) => row.sport);
    assert.equal(sports.length, 7);
    assert.equal(new Set(sports).size, 7);
    assert.deepEqual([...sports].sort(), [...EXPECTED_SPORTS].sort());
  });

  it("stamps the artifact with the generation timestamp", () => {
    assert.equal(cert.generatedAt, REVALIDATION_AT);
  });

  it("states up front that synthetic proves mechanics and no row is live-certified", () => {
    assert.match(cert.statement, /synthetic/i);
    assert.match(cert.statement, /mechanic/i);
    assert.match(cert.statement, /historical/i);
    assert.match(cert.statement, /no row is currently live-certified/i);
  });
});

describe("no row claims live certification", () => {
  it("uses only the two honest evidence types", () => {
    for (const row of rows) {
      assert.ok(
        ["live-reported", "synthetic"].includes(row.evidenceType),
        `${row.sport}: unexpected evidenceType ${row.evidenceType}`,
      );
      assert.notEqual(row.evidenceType, "live-certified");
    }
  });

  it("uses only pending certification statuses", () => {
    for (const row of rows) {
      assert.ok(
        ["pending-live-revalidation", "pending-live"].includes(row.certificationStatus),
        `${row.sport}: unexpected certificationStatus ${row.certificationStatus}`,
      );
      assert.notEqual(row.certificationStatus, "live-certified");
    }
  });

  it("never emits live-certified as a bare value anywhere in the artifact", () => {
    assert.equal(/:\s*"live-certified"/.test(rawJson), false);
    assert.equal(/"live-certified"\s*[,\]]/.test(rawJson), false);
  });

  it("marks every one of the seven sports as pending live", () => {
    for (const row of rows) {
      assert.equal(row.pendingLive, true, `${row.sport}: pendingLive must be true`);
    }
  });

  it("gives every row the full receipt shape", () => {
    for (const row of rows) {
      for (const field of [
        "evidenceRecordedAt",
        "espnEventId",
        "marketResolution",
        "outputVerdict",
        "evaluatorVerdict",
        "latencyMs",
        "fixturePath",
        "receiptSources",
        "pendingLive",
        "notes",
      ]) {
        assert.ok(field in row, `${row.sport}: missing field ${field}`);
      }
      assert.ok(Array.isArray(row.receiptSources), `${row.sport}: receiptSources must be an array`);
      assert.ok(row.notes.length > 0, `${row.sport}: notes must be non-empty`);
    }
  });
});

describe("live-reported rows (mlb, wnba)", () => {
  it("are exactly mlb and wnba", () => {
    const live = rows.filter((row) => row.evidenceType === "live-reported").map((row) => row.sport);
    assert.deepEqual([...live].sort(), [...LIVE_REPORTED_SPORTS].sort());
  });

  for (const sport of LIVE_REPORTED_SPORTS) {
    it(`${sport} carries an ESPN event id, market resolution and a receipt source`, () => {
      const row = bySport.get(sport);
      assert.ok(row.espnEventId, `${sport}: espnEventId is required for live-reported evidence`);
      assert.ok(row.marketResolution, `${sport}: marketResolution is required`);
      assert.ok(row.marketResolution.ticker, `${sport}: marketResolution.ticker is required`);
      assert.ok(row.receiptSources.length > 0, `${sport}: at least one receipt source is required`);
      assert.match(row.receiptSources.join(" "), /github\.com\/machina-sports\/sportsclaw\/pull\/135/);
    });

    it(`${sport} stays pending-live-revalidation even though latency was not retained`, () => {
      const row = bySport.get(sport);
      assert.equal(row.certificationStatus, "pending-live-revalidation");
      // Latency receipts were not retained; null is allowed, a number is not invented.
      assert.ok(
        row.latencyMs === null || typeof row.latencyMs === "number",
        `${sport}: latencyMs must be null or a number`,
      );
      assert.equal(row.fixturePath, null, `${sport}: live-reported rows have no fixture`);
    });
  }

  it("wnba records the originally reported ticker and the recording commit", () => {
    const row = bySport.get("wnba");
    assert.equal(row.espnEventId, "401857073");
    assert.equal(row.marketResolution.ticker, "KXWNBAGAME-26JUL17SEAIND-IND");
    assert.equal(row.evidenceRecordedAt, "2026-07-18T15:44:32Z");
    assert.match(row.receiptSources.join(" "), /21ec5b8854150e067146262df7f0dae1e878e9fe/);
  });

  it("mlb does not invent output or evaluator counts that were never retained", () => {
    const row = bySport.get("mlb");
    assert.equal(row.espnEventId, "401872178");
    assert.equal(row.marketResolution.ticker, "KXMLBGAME-26JUL171335TBBOSG1-BOS");
    assert.equal(row.outputVerdict, "not-retained");
    assert.equal(row.evaluatorVerdict, "not-retained");
    assert.equal(row.latencyMs, null);
  });
});

describe("synthetic rows", () => {
  const syntheticSports = ["nfl", "nba", "nhl", "cfb", "cbb"];

  it("are exactly the five fixture-backed sports", () => {
    const synthetic = rows.filter((row) => row.evidenceType === "synthetic").map((row) => row.sport);
    assert.deepEqual([...synthetic].sort(), [...syntheticSports].sort());
  });

  for (const sport of syntheticSports) {
    it(`${sport} points at a fixture that exists on disk and stays pending-live`, () => {
      const row = bySport.get(sport);
      assert.ok(row.fixturePath, `${sport}: fixturePath is required for synthetic evidence`);
      assert.ok(
        existsSync(join(repoRoot, row.fixturePath)),
        `${sport}: fixture ${row.fixturePath} does not exist`,
      );
      assert.equal(row.certificationStatus, "pending-live");
      assert.equal(row.marketResolution, null, `${sport}: synthetic rows resolve no live market`);
      assert.equal(row.espnEventId, null, `${sport}: synthetic rows have no ESPN event`);
    });
  }

  it("uses the NFL demo fixture for nfl and the per-sport fixtures elsewhere", () => {
    assert.equal(bySport.get("nfl").fixturePath, "demo/vault_data/mock_game.json");
    for (const sport of ["nba", "nhl", "cfb", "cbb"]) {
      assert.equal(bySport.get(sport).fixturePath, `demo/vault_data/mock_game_${sport}.json`);
    }
  });

  it("records accepted cards only for nfl, nba, cfb and cbb", () => {
    for (const sport of ["nfl", "nba", "cfb", "cbb"]) {
      assert.equal(bySport.get(sport).evaluatorVerdict, "accepted", `${sport}: expected accepted card`);
    }
  });
});

describe("nhl never becomes an accepted card", () => {
  it("stays on the held / evaluator-rejection path", () => {
    const row = bySport.get("nhl");
    assert.notEqual(row.evaluatorVerdict, "accepted");
    assert.ok(
      ["held", "rejected"].includes(row.evaluatorVerdict),
      `nhl: evaluatorVerdict must be held or rejected, got ${row.evaluatorVerdict}`,
    );
    assert.match(row.notes, /held|reject/i);
  });
});

describe("2026-08-08 revalidation is blocked, not passing", () => {
  it("only mlb and wnba carry a fresh revalidation attempt", () => {
    const withRevalidation = rows.filter((row) => row.revalidation).map((row) => row.sport);
    assert.deepEqual([...withRevalidation].sort(), [...LIVE_REPORTED_SPORTS].sort());
  });

  for (const sport of LIVE_REPORTED_SPORTS) {
    it(`${sport} revalidation is recorded as blocked`, () => {
      const { revalidation } = bySport.get(sport);
      assert.equal(revalidation.recordedAt, REVALIDATION_AT);
      assert.equal(revalidation.status, "blocked");
      assert.match(revalidation.command, /momentum-replay\.js/);
      assert.ok(revalidation.observedResult.length > 0);
    });

    it(`${sport} revalidation claims no success`, () => {
      const { revalidation } = bySport.get(sport);
      const text = `${revalidation.status} ${revalidation.observedResult}`;
      assert.equal(
        /\b(passed|success(ful)?|verified|certified|confirmed)\b/i.test(text),
        false,
        `${sport}: blocked revalidation must not read as a pass`,
      );
    });

    it(`${sport} revalidation embeds no HTML body or secret payload`, () => {
      const { revalidation } = bySport.get(sport);
      const text = revalidation.observedResult;
      assert.equal(/<[a-z!/]/i.test(text), false, `${sport}: no HTML markup in observedResult`);
      assert.equal(/akamai|reference\s*#/i.test(text), false, `${sport}: no CDN reference in observedResult`);
      assert.equal(
        /(api[-_ ]?key|bearer\s|authorization:|secret|token)/i.test(text),
        false,
        `${sport}: no credential material in observedResult`,
      );
      assert.ok(text.length <= 400, `${sport}: observedResult must stay concise`);
    });
  }

  it("wnba revalidation records the ticker drift and the empty price series", () => {
    const { revalidation } = bySport.get("wnba");
    assert.match(revalidation.command, /wnba 401857073/);
    assert.match(revalidation.observedResult, /KXWNBAGAME-26JUL28INDSEA-IND/);
    assert.match(revalidation.observedResult, /0 price points/i);
  });

  it("mlb revalidation records the unresolved market and the ESPN 403", () => {
    const { revalidation } = bySport.get("mlb");
    assert.match(revalidation.command, /mlb 401872178/);
    assert.match(revalidation.observedResult, /no Kalshi winner market/i);
    assert.match(revalidation.observedResult, /403/);
  });
});

describe("markdown companion", () => {
  it("has a row for each of the seven sports", () => {
    for (const sport of EXPECTED_SPORTS) {
      assert.match(
        markdown,
        new RegExp(`\\|\\s*${sport}\\s*\\|`, "i"),
        `markdown is missing a table row for ${sport}`,
      );
    }
  });

  it("says plainly that no sport is currently live-certified", () => {
    assert.match(markdown, /no sport[^.]{0,60}live-certified/i);
  });

  it("names both evidence types and the blocked revalidation", () => {
    assert.match(markdown, /live-reported/);
    assert.match(markdown, /synthetic/);
    assert.match(markdown, /blocked/i);
    assert.match(markdown, new RegExp(REVALIDATION_AT));
  });

  it("never asserts a live-certified row", () => {
    assert.equal(/\bis live-certified\b/i.test(markdown), false);
  });
});

describe("demo vault README cross-link", () => {
  it("links the certification JSON and Markdown", () => {
    assert.match(demoReadme, /docs\/sports-data\/momentum-certification\.json/);
    assert.match(demoReadme, /docs\/sports-data\/momentum-certification\.md/);
  });
});
