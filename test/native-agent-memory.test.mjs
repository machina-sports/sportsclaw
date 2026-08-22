import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { FileMemoryStorage, MemoryManager, PodMemoryStorage } from "../dist/memory.js";

let dir;

describe("native agent memory namespace", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sc-agent-memory-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("isolates soul and thread under userId/agents/agentId", async () => {
    const storage = new FileMemoryStorage(dir);
    const analyst = new MemoryManager("user-1", storage, "analyst");
    const newsdesk = new MemoryManager("user-1", storage, "newsdesk");

    await analyst.writeSoul("analyst soul");
    await analyst.appendToThread("question", "analyst answer");

    assert.equal(await analyst.readSoul(), "analyst soul");
    assert.equal(await newsdesk.readSoul(), "");
    assert.deepEqual(await newsdesk.readThread(), []);
    assert.equal(existsSync(join(dir, "user-1", "agents", "analyst", "SOUL.md")), true);
    assert.equal(existsSync(join(dir, "user-1", "agents", "analyst", "thread.json")), true);
    assert.equal(existsSync(join(dir, "user-1", "SOUL.md")), false);
  });

  it("uses separate pod documents for each native agent", async () => {
    const documents = new Map();
    let nextId = 0;
    const mcp = {
      callToolDirect: async (_server, toolName, args) => {
        if (toolName === "search_documents") {
          const doc = documents.get(args.filters.name);
          const data = doc ? [{ _id: doc.id, value: doc.value }] : [];
          return { isError: false, content: JSON.stringify({ data: { data } }) };
        }
        if (toolName === "create_document") {
          const id = `doc-${++nextId}`;
          documents.set(args.name, { id, value: args.content.value });
          return { isError: false, content: JSON.stringify({ data: { data: { _id: id } } }) };
        }
        if (toolName === "update_document") {
          for (const [name, doc] of documents) {
            if (doc.id === args.item_id) documents.set(name, { ...doc, value: args.content.value });
          }
          return { isError: false, content: "{}" };
        }
        return { isError: false, content: JSON.stringify({ data: { data: [] } }) };
      },
    };
    const storage = new PodMemoryStorage(mcp, "pod");

    await storage.write("user-1", "SOUL.md", "analyst", "analyst");
    await storage.write("user-1", "SOUL.md", "newsdesk", "newsdesk");

    const userHash = createHash("sha256").update("user-1").digest("hex").slice(0, 32);
    assert.equal(documents.get(`memory-agent-${userHash}-analyst`).value.soul, "analyst");
    assert.equal(documents.get(`memory-agent-${userHash}-newsdesk`).value.soul, "newsdesk");
    assert.equal(documents.has("memory-user-1"), false);
  });
});
