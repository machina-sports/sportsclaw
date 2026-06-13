/**
 * FileMemoryStorage.write — atomic temp-file + rename semantics.
 * After any write completes, the target file must contain exactly one
 * complete payload (never a torn mix), and no temp files may linger.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FileMemoryStorage } from "../dist/memory.js";

let dir;

describe("FileMemoryStorage atomic write", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sc-memory-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips content", async () => {
    const storage = new FileMemoryStorage(dir);
    await storage.write("user1", "FAN_PROFILE.md", "# Fan\nteam: Lakers\n");
    assert.equal(await storage.read("user1", "FAN_PROFILE.md"), "# Fan\nteam: Lakers\n");
  });

  it("leaves no temp files behind", async () => {
    const storage = new FileMemoryStorage(dir);
    await storage.write("user1", "CONTEXT.md", "hello");
    const files = readdirSync(storage.getUserDir("user1"));
    assert.deepEqual(files, ["CONTEXT.md"]);
  });

  it("concurrent writes settle on one complete payload", async () => {
    const storage = new FileMemoryStorage(dir);
    const a = "A".repeat(64 * 1024);
    const b = "B".repeat(64 * 1024);
    await Promise.all([
      storage.write("user1", "STRATEGY.md", a),
      storage.write("user1", "STRATEGY.md", b),
    ]);
    const final = await storage.read("user1", "STRATEGY.md");
    assert.ok(
      final === a || final === b,
      "file must be exactly one of the two complete payloads, not a torn mix"
    );
  });
});
