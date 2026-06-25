/**
 * Atomic config writes — test suite
 *
 * writeEnvVar (and saveMcpConfigs, same idiom) write to a same-dir temp file
 * then rename over the target, so a crash mid-write can't tear the file. These
 * tests pin the round-trip contract and that no .tmp residue is left behind.
 */

import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
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
});
