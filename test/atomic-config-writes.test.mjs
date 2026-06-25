/**
 * Atomic config writes — test suite
 *
 * writeEnvVar writes to a same-dir temp file then renames over the target, so a
 * crash mid-write can't tear the file. These tests pin the round-trip contract,
 * that no .tmp residue is left behind, and that the secrets file is owner-only.
 * (saveMcpConfigs shares the identical idiom but writes to a fixed ~/.sportsclaw
 * path, so it is not exercised here — covered by inspection / the shared idiom.)
 */

import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { mkdtempSync, rmSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeEnvVar } from "../dist/config.js";

let dir;
let envPath;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "sportsclaw-env-"));
  envPath = join(dir, ".env");
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("writeEnvVar (atomic)", () => {
  it("writes a key and reads it back", () => {
    writeEnvVar(envPath, "SPORTSCLAW_MCP_TOKEN_A", "tok_a");
    assert.match(readFileSync(envPath, "utf-8"), /^SPORTSCLAW_MCP_TOKEN_A=tok_a$/m);
  });

  it("appends a second key without clobbering the first", () => {
    writeEnvVar(envPath, "SPORTSCLAW_MCP_TOKEN_B", "tok_b");
    const body = readFileSync(envPath, "utf-8");
    assert.match(body, /^SPORTSCLAW_MCP_TOKEN_A=tok_a$/m);
    assert.match(body, /^SPORTSCLAW_MCP_TOKEN_B=tok_b$/m);
  });

  it("replaces an existing key in place", () => {
    writeEnvVar(envPath, "SPORTSCLAW_MCP_TOKEN_A", "tok_a2");
    const body = readFileSync(envPath, "utf-8");
    assert.match(body, /^SPORTSCLAW_MCP_TOKEN_A=tok_a2$/m);
    assert.doesNotMatch(body, /tok_a$/m);
  });

  it("leaves no .tmp residue in the directory", () => {
    const leftover = readdirSync(dir).filter((f) => f.endsWith(".tmp"));
    assert.deepEqual(leftover, [], `unexpected temp files: ${leftover.join(", ")}`);
  });

  it("restricts the .env to owner-only (0600) since it holds tokens", { skip: process.platform === "win32" }, () => {
    assert.equal(statSync(envPath).mode & 0o077, 0, "group/other bits must be clear");
  });
});
