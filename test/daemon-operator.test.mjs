/**
 * Daemon driver — operator-platform-aware routing tests.
 *
 * Tests the *pure* parts of the routing: scriptArgsFor, logPaths,
 * platformRequiresJobId, isValidPlatform. The actual driver methods
 * (launchctl / systemctl / schtasks) can't run in CI; those are
 * exercised manually per the PR test plan.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  isValidPlatform,
  platformRequiresJobId,
  scriptArgsFor,
  logPaths,
} from "../dist/daemon.js";

// ---------------------------------------------------------------------------
// Platform recognition
// ---------------------------------------------------------------------------

describe("isValidPlatform", () => {
  it("accepts the four supported platforms", () => {
    for (const p of ["discord", "telegram", "watch", "operator"]) {
      assert.strictEqual(isValidPlatform(p), true, p);
    }
  });

  it("rejects anything else", () => {
    for (const p of ["", "slack", "DISCORD", "operator-jobs", "foo"]) {
      assert.strictEqual(isValidPlatform(p), false, p);
    }
  });
});

describe("platformRequiresJobId", () => {
  it("is true only for operator", () => {
    assert.strictEqual(platformRequiresJobId("operator"), true);
    for (const p of ["discord", "telegram", "watch"]) {
      assert.strictEqual(platformRequiresJobId(p), false, p);
    }
  });
});

// ---------------------------------------------------------------------------
// scriptArgsFor
// ---------------------------------------------------------------------------

describe("scriptArgsFor", () => {
  it("returns `listen <platform>` for simple chat platforms", () => {
    assert.deepStrictEqual(scriptArgsFor("discord"), ["listen", "discord"]);
    assert.deepStrictEqual(scriptArgsFor("telegram"), ["listen", "telegram"]);
  });

  it("returns `watch --config=<path>` for watch", () => {
    const args = scriptArgsFor("watch");
    assert.strictEqual(args[0], "watch");
    assert.ok(args[1].startsWith("--config="));
  });

  it("returns `operate --job <id>` for operator", () => {
    assert.deepStrictEqual(scriptArgsFor("operator", "tv-operator"), [
      "operate",
      "--job",
      "tv-operator",
    ]);
  });

  it("throws when operator is missing jobId", () => {
    assert.throws(() => scriptArgsFor("operator"), /requires a jobId/);
  });

  it("throws when operator jobId has unsafe chars", () => {
    for (const bad of ["../escape", "with spaces", "a/b"]) {
      assert.throws(
        () => scriptArgsFor("operator", bad),
        /requires a jobId/,
        `jobId=${bad}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// logPaths
// ---------------------------------------------------------------------------

describe("logPaths", () => {
  const logsDir = join(homedir(), ".sportsclaw", "logs");

  it("returns plain platform paths for simple platforms", () => {
    const { out, err } = logPaths("discord");
    assert.strictEqual(out, join(logsDir, "discord-out.log"));
    assert.strictEqual(err, join(logsDir, "discord-err.log"));
  });

  it("namespaces operator paths by jobId", () => {
    const { out, err } = logPaths("operator", "tv-operator");
    assert.strictEqual(out, join(logsDir, "operator-tv-operator-out.log"));
    assert.strictEqual(err, join(logsDir, "operator-tv-operator-err.log"));
  });

  it("different jobIds → different log files", () => {
    const a = logPaths("operator", "job-a");
    const b = logPaths("operator", "job-b");
    assert.notStrictEqual(a.out, b.out);
    assert.notStrictEqual(a.err, b.err);
  });
});
