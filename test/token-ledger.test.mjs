/**
 * token-ledger — per-UTC-day token tally on disk. Accounting must be
 * accumulative, corruption-tolerant, and never throw.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { recordTokens, tokensUsedToday } from "../dist/token-ledger.js";

let dir;
let ledger;

describe("token-ledger", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sc-ledger-"));
    ledger = join(dir, "token-ledger.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("starts at zero", () => {
    assert.equal(tokensUsedToday(ledger), 0);
  });

  it("accumulates across calls", () => {
    recordTokens(1000, ledger);
    recordTokens(500, ledger);
    assert.equal(tokensUsedToday(ledger), 1500);
  });

  it("ignores non-positive and non-finite values", () => {
    recordTokens(0, ledger);
    recordTokens(-50, ledger);
    recordTokens(NaN, ledger);
    assert.equal(tokensUsedToday(ledger), 0);
  });

  it("recovers from a corrupt ledger file", () => {
    writeFileSync(ledger, "{corrupt", "utf-8");
    assert.equal(tokensUsedToday(ledger), 0);
    recordTokens(200, ledger);
    assert.equal(tokensUsedToday(ledger), 200);
  });

  it("keys by UTC date", () => {
    recordTokens(100, ledger);
    const data = JSON.parse(readFileSync(ledger, "utf-8"));
    const today = new Date().toISOString().slice(0, 10);
    assert.equal(data[today], 100);
  });
});
