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
});
