/**
 * Unified Durability Substrate — Test Suite
 *
 * Verifies that:
 *  1. Saving and loading payload data to DurableStateStore works correctly.
 *  2. Expiration (TTL) auto-deletes expired records on access.
 *  3. Namespace listing and filtering operate correctly.
 *  4. Payload deletions are successful.
 */

import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { DurableStateStore } from "../dist/durability.js";

describe("DurableStateStore Substrate", () => {
  let tmpRootDir;
  let store;

  beforeEach(() => {
    tmpRootDir = fs.mkdtempSync(path.join(os.tmpdir(), "durability-test-"));
    store = new DurableStateStore(tmpRootDir);
  });

  afterEach(() => {
    fs.rmSync(tmpRootDir, { recursive: true, force: true });
  });

  it("should save and load payload data correctly", async () => {
    const data = { foo: "bar", baz: 123 };
    const saved = await store.save("sessions", "session_1", data);

    assert.strictEqual(saved.id, "session_1");
    assert.strictEqual(saved.namespace, "sessions");
    assert.deepEqual(saved.data, data);

    const loaded = await store.load("sessions", "session_1");
    assert.deepEqual(loaded, data);
  });

  it("should auto-expire and delete files when TTL has passed", async () => {
    const data = { secret: "ephemeral" };
    // Set an immediate TTL of 5ms
    await store.save("memory", "temp_state", data, { ttlMs: 5 });

    // Verify it is readable immediately
    const loadedImmediate = await store.load("memory", "temp_state");
    assert.deepEqual(loadedImmediate, data);

    // Wait 20ms for expiration to trigger
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Try to load again — should return null and the file should be deleted
    const loadedExpired = await store.load("memory", "temp_state");
    assert.strictEqual(loadedExpired, null, "Expired state should return null");

    // File should no longer exist on disk
    const filePath = path.join(tmpRootDir, "memory", "temp_state.json");
    assert.strictEqual(fs.existsSync(filePath), false, "Expired file must be deleted");
  });

  it("should list and filter namespace entries correctly", async () => {
    const activeTask = { id: "t1", status: "active", title: "Task 1" };
    const completedTask = { id: "t2", status: "completed", title: "Task 2" };

    await store.save("tasks", "t1", activeTask);
    await store.save("tasks", "t2", completedTask);

    // 1. List all tasks
    const allTasks = await store.list("tasks");
    assert.strictEqual(allTasks.length, 2);
    
    const taskIds = allTasks.map(t => t.id).sort();
    assert.deepEqual(taskIds, ["t1", "t2"]);

    // 2. Filter tasks (active only)
    const activeOnly = await store.list("tasks", {
      filter: (task) => task.status === "active"
    });
    assert.strictEqual(activeOnly.length, 1);
    assert.strictEqual(activeOnly[0].id, "t1");
    assert.deepEqual(activeOnly[0].data, activeTask);
  });

  it("should support safe deletions of payload data", async () => {
    await store.save("approvals", "req_1", { approved: false });

    // Delete it
    const deleted = await store.delete("approvals", "req_1");
    assert.strictEqual(deleted, true);

    // Verify loading returns null
    const loaded = await store.load("approvals", "req_1");
    assert.strictEqual(loaded, null);

    // Deleting again should return false (already deleted)
    const deletedAgain = await store.delete("approvals", "req_1");
    assert.strictEqual(deletedAgain, false);
  });

  // ---------------------------------------------------------------------------
  // Backward compatibility: pre-substrate files stored the bare domain object
  // at the same path (no envelope wrapper). load() must read them as the data,
  // not lose them by reading a non-existent `.data` field.
  // ---------------------------------------------------------------------------

  it("reads a legacy pre-substrate file (no envelope) as the data itself", async () => {
    // Simulate a file written by the OLD SessionStore: a raw SessionEntry,
    // not a DurableStatePayload envelope.
    const legacy = {
      messages: [{ role: "user", content: "hello" }],
      updatedAt: "2026-06-01T00:00:00.000Z",
    };
    const dir = path.join(tmpRootDir, "sessions");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "legacy_session.json"), JSON.stringify(legacy));

    const loaded = await store.load("sessions", "legacy_session");
    assert.deepEqual(loaded, legacy, "legacy file must be read as the data, not lost");
  });

  it("does not mistake a legacy object that happens to carry a `data` field for an envelope", async () => {
    // A legacy payload may itself contain a `data` key; only the namespace
    // discriminator distinguishes a real envelope.
    const legacy = { data: { nested: true }, updatedAt: "2026-06-01T00:00:00.000Z" };
    const dir = path.join(tmpRootDir, "tasks");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "legacy_task.json"), JSON.stringify(legacy));

    const loaded = await store.load("tasks", "legacy_task");
    assert.deepEqual(loaded, legacy, "legacy object must be returned whole, not unwrapped");
  });

  it("lists legacy and new-format entries together", async () => {
    // New-format entry via the store
    await store.save("tasks", "new_task", { id: "new_task", status: "active" });
    // Legacy entry written directly
    const dir = path.join(tmpRootDir, "tasks");
    fs.writeFileSync(
      path.join(dir, "old_task.json"),
      JSON.stringify({ id: "old_task", status: "completed" })
    );

    const all = await store.list("tasks");
    const byId = Object.fromEntries(all.map((e) => [e.id, e.data]));
    assert.deepEqual(byId["new_task"], { id: "new_task", status: "active" });
    assert.deepEqual(byId["old_task"], { id: "old_task", status: "completed" });
  });

  it("still round-trips and TTL-expires new-format envelopes after the compat change", async () => {
    await store.save("sessions", "fresh", { messages: ["a"] });
    assert.deepEqual(await store.load("sessions", "fresh"), { messages: ["a"] });

    await store.save("memory", "ttl", { x: 1 }, { ttlMs: 5 });
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(await store.load("memory", "ttl"), null, "envelope TTL must still expire");
  });
});
