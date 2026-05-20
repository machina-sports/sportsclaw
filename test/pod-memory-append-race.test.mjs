/**
 * PodMemoryStorage.append — concurrent-write race regression test.
 *
 * Without per-userId serialization, two concurrent appends on the same
 * (userId, file) read pre-mutation state and the second flush overwrites
 * the first, silently losing one entry. This test fires two appends in
 * parallel and asserts both contents land in the persisted doc.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PodMemoryStorage } from "../dist/memory.js";

/**
 * Minimal McpManager stub. Maintains a single in-memory doc keyed by
 * `name` (e.g. "memory-<userId>") and applies search/create/update calls
 * the way Machina pods would, with an artificial async delay so the race
 * window in the SUT is wide enough to be deterministic.
 */
function makeMcpStub({ writeDelayMs = 5 } = {}) {
  const store = new Map(); // name -> { _id, value }
  let nextId = 1;
  const calls = [];

  const callToolDirect = async (_serverName, toolName, args) => {
    calls.push({ toolName, args });

    if (toolName === "search_documents") {
      const name = args.filters?.name;
      const hit = store.get(name);
      const data = hit ? [{ _id: hit._id, value: hit.value, updated: Date.now() }] : [];
      return {
        isError: false,
        content: JSON.stringify({ data: { data, status: "ok", total_documents: data.length } }),
      };
    }

    if (toolName === "create_document") {
      const id = `doc-${nextId++}`;
      const value = args.content?.value ?? {};
      // Simulate network latency around the write so concurrent flushes can race.
      await new Promise((r) => setTimeout(r, writeDelayMs));
      store.set(args.name, { _id: id, value });
      return {
        isError: false,
        content: JSON.stringify({ data: { data: { _id: id } } }),
      };
    }

    if (toolName === "update_document") {
      const id = args.item_id;
      const value = args.content?.value ?? {};
      await new Promise((r) => setTimeout(r, writeDelayMs));
      // Find and replace by _id
      for (const [name, doc] of store.entries()) {
        if (doc._id === id) {
          store.set(name, { _id: id, value });
          break;
        }
      }
      return { isError: false, content: JSON.stringify({ data: { data: { _id: id } } }) };
    }

    if (toolName === "delete_document") {
      // Used only by migration; not exercised here.
      return { isError: false, content: "{}" };
    }

    return { isError: false, content: "{}" };
  };

  return {
    mcpManager: { callToolDirect },
    store,
    calls,
  };
}

describe("PodMemoryStorage.append — concurrent-write safety", () => {
  it("preserves both entries when two appends run in parallel for the same user", async () => {
    const { mcpManager, store } = makeMcpStub({ writeDelayMs: 8 });
    const storage = new PodMemoryStorage(mcpManager, "machina-test");
    const userId = "race-test-user";

    // Fire two appends in parallel. Without the per-userId chain, they would
    // both read the empty doc and the second flush would overwrite the first.
    await Promise.all([
      storage.append(userId, "REFLECTIONS.md", "first"),
      storage.append(userId, "REFLECTIONS.md", "second"),
    ]);

    const finalDoc = store.get(`memory-${userId}`);
    assert.ok(finalDoc, "expected memory doc to exist after appends");

    const reflections = finalDoc.value.reflections ?? "";
    assert.match(
      reflections,
      /first/,
      `expected 'first' to be present in final reflections; got: ${JSON.stringify(reflections)}`
    );
    assert.match(
      reflections,
      /second/,
      `expected 'second' to be present in final reflections; got: ${JSON.stringify(reflections)}`
    );
  });

  it("preserves order within a single chain (each append sees the previous one's content)", async () => {
    const { mcpManager, store } = makeMcpStub({ writeDelayMs: 4 });
    const storage = new PodMemoryStorage(mcpManager, "machina-test");
    const userId = "ordered-test-user";

    // Sequential awaits — each must see the prior content.
    await storage.append(userId, "REFLECTIONS.md", "a");
    await storage.append(userId, "REFLECTIONS.md", "b");
    await storage.append(userId, "REFLECTIONS.md", "c");

    const finalDoc = store.get(`memory-${userId}`);
    const reflections = finalDoc?.value?.reflections ?? "";
    assert.equal(
      reflections,
      "a\nb\nc",
      `expected 'a\\nb\\nc'; got: ${JSON.stringify(reflections)}`
    );
  });

  it("does not create an empty consolidated doc when a read finds no existing or legacy memory", async () => {
    const { mcpManager, calls } = makeMcpStub({ writeDelayMs: 1 });
    const storage = new PodMemoryStorage(mcpManager, "machina-test");

    const value = await storage.read("empty-user", "SOUL.md");

    assert.equal(value, "");
    assert.equal(
      calls.filter((c) => c.toolName === "create_document").length,
      0,
      "read-only access with no legacy content must not create zombie empty memory docs"
    );
  });
});
