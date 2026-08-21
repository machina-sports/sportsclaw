/**
 * HindsightMemoryStorage — driver behavior + provider-selection tests.
 *
 * These run against a fake in-memory Hindsight server (an injected fetchImpl
 * modeling bank create / memory retain / memory recall / reflect with verbatim
 * storage). They verify the driver round-trips memory faithfully (so SOUL.md
 * header parsing and thread.json survive), serializes concurrent appends,
 * isolates memory per user (one bank per user), tags by source surface, and
 * that createMemoryStorage selects the right driver from the environment.
 */

import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";

import {
  HindsightMemoryStorage,
  MemoryManager,
  createMemoryStorage,
} from "../dist/memory.js";

// ---------------------------------------------------------------------------
// Fake Hindsight server (injected fetchImpl)
// ---------------------------------------------------------------------------

/**
 * Models the subset of the Hindsight HTTP API the driver uses:
 *   POST /v1/{ns}/banks/{bank}                 → create/update bank
 *   POST /v1/{ns}/banks/{bank}/memory/retain   → upsert items by document_id
 *   POST /v1/{ns}/banks/{bank}/memory/recall   → tag-filtered retrieval
 *   POST /v1/{ns}/banks/{bank}/reflect          → synthesized text
 *
 * In verbatim mode each item's `content` is stored exactly and returned as
 * `text` on recall. An optional delay widens the read→write window so the
 * concurrent-append regression is deterministic.
 */
function makeFakeHindsight({ delayMs = 0 } = {}) {
  const banks = new Map(); // bankId -> Map<document_id, { content, tags, metadata }>
  const calls = [];

  const ensureBank = (bank) => {
    if (!banks.has(bank)) banks.set(bank, new Map());
    return banks.get(bank);
  };

  const tagsMatchAll = (memTags, wanted) => wanted.every((t) => memTags.includes(t));
  const tagsMatchAny = (memTags, wanted) => wanted.some((t) => memTags.includes(t));

  const fetchImpl = async (url, init = {}) => {
    const { pathname } = new URL(url);
    const parts = pathname.split("/"); // ["", "v1", ns, "banks", bank, ...rest]
    const bank = decodeURIComponent(parts[4] ?? "");
    const suffix = parts.slice(5).join("/");
    const body = init.body ? JSON.parse(init.body) : {};
    calls.push({ method: init.method, pathname, suffix, body });

    const ok = (payload) => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(payload),
      json: async () => payload,
    });

    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));

    // Create / update bank
    if (suffix === "") {
      ensureBank(bank);
      return ok({ ok: true, bank_id: bank });
    }

    // Retain (upsert by document_id)
    if (suffix === "memory/retain") {
      const store = ensureBank(bank);
      const items = Array.isArray(body.items) ? body.items : [];
      for (const item of items) {
        store.set(item.document_id, {
          content: item.content,
          tags: item.tags ?? [],
          metadata: item.metadata ?? {},
        });
      }
      return ok({ success: true, bank_id: bank, items_count: items.length });
    }

    // Recall (hard tag filter, mirrors documented tags_match semantics)
    if (suffix === "memory/recall") {
      const store = ensureBank(bank);
      const wanted = Array.isArray(body.tags) ? body.tags : [];
      const mode = body.tags_match ?? "any";
      const results = [];
      for (const [documentId, mem] of store.entries()) {
        const pass =
          wanted.length === 0
            ? true
            : mode === "all"
              ? tagsMatchAll(mem.tags, wanted)
              : tagsMatchAny(mem.tags, wanted);
        if (pass) {
          results.push({
            id: documentId,
            document_id: documentId,
            text: mem.content,
            type: "world",
            tags: mem.tags,
          });
        }
      }
      return ok({ results, source_facts: {}, chunks: {}, entities: {} });
    }

    // Reflect (naive synthesis = join stored texts)
    if (suffix === "reflect") {
      const store = ensureBank(bank);
      const text = [...store.values()].map((m) => m.content).join("\n");
      return ok({ text, based_on: { memories: [] } });
    }

    return { ok: false, status: 404, text: async () => "", json: async () => ({}) };
  };

  return { fetchImpl, banks, calls };
}

function newStorage(fetchImpl, overrides = {}) {
  return new HindsightMemoryStorage({
    baseUrl: "http://hindsight.test",
    namespace: "default",
    bankPrefix: "sportsclaw",
    apiKey: undefined,
    extractionMode: "verbatim",
    recallBudget: "mid",
    recallMaxTokens: 32_768,
    timeoutMs: 5_000,
    fetchImpl,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Driver behavior
// ---------------------------------------------------------------------------

describe("HindsightMemoryStorage", () => {
  it("round-trips write → read verbatim", async () => {
    const { fetchImpl } = makeFakeHindsight();
    const s = newStorage(fetchImpl);
    const content = "# Soul\nBorn: 2026-06-25\nExchanges: 3\n\n## Notes\nLikes the underdog.";
    await s.write("user-1", "SOUL.md", content);
    assert.equal(await s.read("user-1", "SOUL.md"), content);
  });

  it("returns empty string for an unknown slot", async () => {
    const { fetchImpl } = makeFakeHindsight();
    const s = newStorage(fetchImpl);
    assert.equal(await s.read("user-1", "FAN_PROFILE.md"), "");
  });

  it("appends with a newline separator and preserves order", async () => {
    const { fetchImpl } = makeFakeHindsight();
    const s = newStorage(fetchImpl);
    await s.append("user-1", "REFLECTIONS.md", "first lesson");
    await s.append("user-1", "REFLECTIONS.md", "second lesson");
    assert.equal(await s.read("user-1", "REFLECTIONS.md"), "first lesson\nsecond lesson");
  });

  it("does not lose entries under concurrent appends", async () => {
    // Delay widens the read→write window; without the per-(user,slot) chain the
    // second write would clobber the first.
    const { fetchImpl } = makeFakeHindsight({ delayMs: 5 });
    const s = newStorage(fetchImpl);
    await Promise.all([
      s.append("user-1", "REFLECTIONS.md", "alpha"),
      s.append("user-1", "REFLECTIONS.md", "bravo"),
    ]);
    const out = await s.read("user-1", "REFLECTIONS.md");
    assert.ok(out.includes("alpha"), `expected alpha in: ${out}`);
    assert.ok(out.includes("bravo"), `expected bravo in: ${out}`);
    assert.equal(out.split("\n").length, 2, `both entries should land exactly once: ${out}`);
  });

  it("clears a slot on remove", async () => {
    const { fetchImpl } = makeFakeHindsight();
    const s = newStorage(fetchImpl);
    await s.write("user-1", "CONTEXT.md", "ephemeral state");
    await s.remove("user-1", "CONTEXT.md");
    assert.equal(await s.read("user-1", "CONTEXT.md"), "");
  });

  it("isolates memory by userId via separate banks", async () => {
    const { fetchImpl, banks } = makeFakeHindsight();
    const s = newStorage(fetchImpl);
    await s.write("alice", "SOUL.md", "ALICE-SOUL");
    await s.write("bob", "SOUL.md", "BOB-SOUL");

    assert.equal(await s.read("alice", "SOUL.md"), "ALICE-SOUL");
    assert.equal(await s.read("bob", "SOUL.md"), "BOB-SOUL");

    // Two distinct, user-scoped banks were created.
    assert.ok(banks.has("sportsclaw-alice"));
    assert.ok(banks.has("sportsclaw-bob"));
    assert.notEqual("sportsclaw-alice", "sportsclaw-bob");
  });

  it("tags each memory with its source surface and user scope", async () => {
    const { fetchImpl, banks } = makeFakeHindsight();
    const s = newStorage(fetchImpl);
    await s.write("u1", "STRATEGY.md", "be bold");
    const mem = banks.get("sportsclaw-u1").get("strategy");
    assert.ok(mem.tags.includes("sportsclaw"));
    assert.ok(mem.tags.includes("user:u1"));
    assert.ok(mem.tags.includes("surface:strategy"));
    assert.equal(mem.metadata.surface, "strategy");
    assert.equal(mem.metadata.file, "STRATEGY.md");
  });

  it("tags daily logs with the date surface", async () => {
    const { fetchImpl, banks } = makeFakeHindsight();
    const s = newStorage(fetchImpl);
    await s.write("u1", "2026-06-25.md", "today's chatter");
    const mem = banks.get("sportsclaw-u1").get("daily:2026-06-25");
    assert.ok(mem.tags.includes("surface:daily"));
    assert.ok(mem.tags.includes("date:2026-06-25"));
  });

  it("creates the bank with verbatim extraction exactly once", async () => {
    const { fetchImpl, calls } = makeFakeHindsight();
    const s = newStorage(fetchImpl);
    await s.write("u1", "SOUL.md", "a");
    await s.write("u1", "FAN_PROFILE.md", "b");
    const bankCreates = calls.filter(
      (c) => c.method === "POST" && c.suffix === "" && c.pathname.endsWith("/sportsclaw-u1")
    );
    assert.equal(bankCreates.length, 1, "ensureBank should be cached per process");
    assert.equal(bankCreates[0].body.retain_extraction_mode, "verbatim");
  });

  it("sends a bearer token only when an API key is configured", async () => {
    const { fetchImpl } = makeFakeHindsight();
    let seenAuth;
    const wrapped = async (url, init) => {
      seenAuth = init.headers?.authorization;
      return fetchImpl(url, init);
    };
    const s = newStorage(wrapped, { apiKey: "secret-token" });
    await s.write("u1", "SOUL.md", "x");
    assert.equal(seenAuth, "Bearer secret-token");
  });
});

// ---------------------------------------------------------------------------
// Integration with MemoryManager (the consumer of the driver)
// ---------------------------------------------------------------------------

describe("HindsightMemoryStorage with MemoryManager", () => {
  it("increments the soul exchange counter across round-trips", async () => {
    const { fetchImpl } = makeFakeHindsight();
    const mm = new MemoryManager("user-soul", newStorage(fetchImpl));
    await mm.incrementSoulExchanges();
    await mm.incrementSoulExchanges();
    const data = mm.parseSoulHeader(await mm.readSoul());
    assert.equal(data.exchanges, 2);
  });

  it("round-trips the conversation thread as JSON", async () => {
    const { fetchImpl } = makeFakeHindsight();
    const mm = new MemoryManager("user-thread", newStorage(fetchImpl));
    await mm.appendToThread("who plays tonight?", "Flamengo vs Palmeiras");
    const thread = await mm.readThread();
    assert.equal(thread.length, 2);
    assert.equal(thread[0].role, "user");
    assert.equal(thread[0].content, "who plays tonight?");
    assert.equal(thread[1].role, "assistant");
    assert.equal(thread[1].content, "Flamengo vs Palmeiras");
  });

  it("surfaces today's daily log via listDailyLogs and buildMemoryBlock", async () => {
    const { fetchImpl } = makeFakeHindsight();
    const mm = new MemoryManager("user-daily", newStorage(fetchImpl));
    await mm.appendExchange("morning lines?", "here are the spreads");
    const logs = await mm.listDailyLogs();
    assert.equal(logs.length, 1);
    assert.match(logs[0], /^\d{4}-\d{2}-\d{2}\.md$/);
    const block = await mm.buildMemoryBlock();
    assert.match(block, /Today's Conversation Log/);
    assert.match(block, /morning lines\?/);
  });
});

// ---------------------------------------------------------------------------
// Semantic pipelines (extra capabilities)
// ---------------------------------------------------------------------------

describe("HindsightMemoryStorage semantic pipelines", () => {
  it("recall returns stored memories", async () => {
    const { fetchImpl } = makeFakeHindsight();
    const s = newStorage(fetchImpl);
    await s.write("u1", "SOUL.md", "loyal to underdogs");
    await s.write("u1", "FAN_PROFILE.md", "follows Serie A");
    const results = await s.recall("u1", "what does this fan like?");
    const texts = results.map((r) => r.text);
    assert.ok(texts.includes("loyal to underdogs"));
    assert.ok(texts.includes("follows Serie A"));
  });

  it("reflect synthesizes text from stored memories", async () => {
    const { fetchImpl } = makeFakeHindsight();
    const s = newStorage(fetchImpl);
    await s.write("u1", "REFLECTIONS.md", "tool X times out on long ranges");
    const text = await s.reflect("u1", "what have we learned?");
    assert.match(text, /tool X times out/);
  });

  it("degrades gracefully when the server is unreachable", async () => {
    const failing = async () => {
      throw new Error("ECONNREFUSED");
    };
    const s = newStorage(failing);
    // Writes never throw; reads return empty rather than crashing the turn.
    await s.write("u1", "SOUL.md", "x");
    assert.equal(await s.read("u1", "SOUL.md"), "");
  });
});

// ---------------------------------------------------------------------------
// Provider selection
// ---------------------------------------------------------------------------

describe("createMemoryStorage provider selection", () => {
  const ENV_KEYS = ["SPORTSCLAW_MEMORY_PROVIDER", "SPORTSCLAW_MEMORY_BACKEND"];
  let saved;

  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("selects hindsight when SPORTSCLAW_MEMORY_PROVIDER=hindsight", () => {
    process.env.SPORTSCLAW_MEMORY_PROVIDER = "hindsight";
    const sel = createMemoryStorage({});
    assert.equal(sel.provider, "hindsight");
    assert.ok(sel.storage instanceof HindsightMemoryStorage);
    assert.match(sel.logLine, /selected=hindsight/);
  });

  it("defaults to file (no storage override) when nothing is set", () => {
    const sel = createMemoryStorage({});
    assert.equal(sel.provider, "file");
    assert.equal(sel.storage, undefined);
  });

  it("honors the legacy SPORTSCLAW_MEMORY_BACKEND=file alias", () => {
    process.env.SPORTSCLAW_MEMORY_BACKEND = "file";
    const sel = createMemoryStorage({});
    assert.equal(sel.provider, "file");
    assert.equal(sel.storage, undefined);
  });

  it("lets SPORTSCLAW_MEMORY_PROVIDER override the legacy backend var", () => {
    process.env.SPORTSCLAW_MEMORY_BACKEND = "file";
    process.env.SPORTSCLAW_MEMORY_PROVIDER = "hindsight";
    const sel = createMemoryStorage({});
    assert.equal(sel.provider, "hindsight");
  });

  it("throws on an invalid provider value", () => {
    process.env.SPORTSCLAW_MEMORY_PROVIDER = "bogus";
    assert.throws(() => createMemoryStorage({}), /Invalid SPORTSCLAW_MEMORY_PROVIDER/);
  });

  it("requires a connected Machina server for pod mode", () => {
    process.env.SPORTSCLAW_MEMORY_PROVIDER = "pod";
    assert.throws(() => createMemoryStorage({}), /requires a connected Machina MCP server/);
  });

  it("selects pod when a Machina server is available", () => {
    process.env.SPORTSCLAW_MEMORY_PROVIDER = "pod";
    const mcpManager = { getMachinaServerName: () => "machina-test" };
    const sel = createMemoryStorage({ mcpManager });
    assert.equal(sel.provider, "pod");
    assert.ok(sel.storage);
    assert.equal(sel.server, "machina-test");
  });
});
