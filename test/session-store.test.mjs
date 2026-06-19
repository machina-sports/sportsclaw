/**
 * SessionStore disk persistence — sessions must survive a process restart
 * (simulated here by constructing a second store over the same directory),
 * honor TTL on load, and treat corrupt files as empty sessions.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionStore } from "../dist/engine.js";

const MESSAGES = [
  { role: "user", content: "who won the lakers game?" },
  { role: "assistant", content: [{ type: "text", text: "Lakers won 112-104." }] },
];

let dir;

describe("SessionStore persistence", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sc-sessions-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips a session across store instances", async () => {
    const a = new SessionStore(dir);
    await a.save("discord:123", MESSAGES);

    const b = new SessionStore(dir);
    const loaded = await b.load("discord:123");
    assert.deepEqual(loaded, MESSAGES);
  });

  it("load() prefers the in-memory copy", async () => {
    const store = new SessionStore(dir);
    await store.save("s1", MESSAGES);
    const loaded = await store.load("s1");
    assert.deepEqual(loaded, MESSAGES);
  });

  it("returns empty for unknown sessions", async () => {
    const store = new SessionStore(dir);
    assert.deepEqual(await store.load("nope"), []);
  });

  it("expired sessions on disk are dropped and their file deleted", async () => {
    const a = new SessionStore(dir);
    await a.save("old", MESSAGES);
    const sessionsDir = join(dir, "sessions");
    const file = readdirSync(sessionsDir).find((f) => f.endsWith(".json"));
    assert.ok(file, "session file written");
    // Rewrite with an updatedAt older than the 2h TTL.
    const filePath = join(sessionsDir, file);
    const raw = readFileSync(filePath, "utf-8");
    const payload = JSON.parse(raw);
    payload.expiresAt = new Date(Date.now() - 1000).toISOString(); // Expired right now
    payload.updatedAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    writeFileSync(filePath, JSON.stringify(payload), "utf-8");

    const b = new SessionStore(dir);
    assert.deepEqual(await b.load("old"), []);
    // unlink is fire-and-forget; give it a tick.
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(
      readdirSync(sessionsDir).filter((f) => f.endsWith(".json")).length, 0,
      "expired file removed"
    );
  });

  it("corrupt session files are treated as empty", async () => {
    const a = new SessionStore(dir);
    await a.save("bad", MESSAGES);
    const sessionsDir = join(dir, "sessions");
    const file = readdirSync(sessionsDir).find((f) => f.endsWith(".json"));
    writeFileSync(join(sessionsDir, file), "{not json", "utf-8");

    const b = new SessionStore(dir);
    assert.deepEqual(await b.load("bad"), []);
  });

  it("sanitizes hostile session ids into safe filenames", async () => {
    const store = new SessionStore(dir);
    await store.save("../../etc/passwd", MESSAGES);
    const sessionsDir = join(dir, "sessions");
    for (const f of readdirSync(sessionsDir)) {
      assert.ok(!f.includes(".."), `unsafe filename: ${f}`);
      assert.ok(!f.includes("/"), `unsafe filename: ${f}`);
    }
  });

  it("persistDir null disables disk persistence", async () => {
    const store = new SessionStore(null);
    await store.save("mem-only", MESSAGES);
    assert.deepEqual(store.get("mem-only"), MESSAGES);
    assert.equal(readdirSync(dir).length, 0, "nothing written to unrelated dir");
  });

  it("clear() removes the session file", async () => {
    const store = new SessionStore(dir);
    await store.save("gone", MESSAGES);
    store.clear("gone");
    // Unlink is fire-and-forget; give it a tick.
    await new Promise((r) => setTimeout(r, 50));
    const b = new SessionStore(dir);
    assert.deepEqual(await b.load("gone"), []);
  });
});
