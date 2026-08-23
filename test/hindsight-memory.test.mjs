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
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, beforeEach, afterEach } from "node:test";
import { MockLanguageModelV3 } from "ai/test";

import { sportsclawEngine } from "../dist/index.js";
import {
  HindsightMemoryStorage,
  MemoryManager,
  createMemoryStorage,
  hindsightConfigFromEnv,
} from "../dist/memory.js";

// ---------------------------------------------------------------------------
// Fake Hindsight server (injected fetchImpl)
// ---------------------------------------------------------------------------

/**
 * Models the subset of the Hindsight HTTP API the driver uses:
 *   PUT    /v1/default/banks/{bank}                         → create/update bank
 *   POST   /v1/default/banks/{bank}/memories                → retain documents
 *   POST   /v1/default/banks/{bank}/memories/recall         → semantic recall
 *   GET    /v1/default/banks/{bank}/documents/{document_id} → exact document read
 *   DELETE /v1/default/banks/{bank}/documents/{document_id} → document removal
 *
 * In verbatim mode each item's `content` is stored exactly and returned as
 * `text` on recall. An optional delay widens the read→write window so the
 * concurrent-append regression is deterministic.
 */
function makeFakeHindsight({ delayMs = 0 } = {}) {
  const banks = new Map(); // bankId -> Map<document_id, { content, tags, metadata }>
  const calls = [];
  const failures = [];

  const ensureBank = (bank) => {
    if (!banks.has(bank)) banks.set(bank, new Map());
    return banks.get(bank);
  };

  const tagsMatchAll = (memTags, wanted) => wanted.every((t) => memTags.includes(t));
  const tagsMatchAny = (memTags, wanted) => wanted.some((t) => memTags.includes(t));

  const failNext = (method, suffix, failure = { status: 503 }) => {
    failures.push({ method, suffix, failure });
  };

  const fetchImpl = async (url, init = {}) => {
    const { pathname } = new URL(url);
    const parts = pathname.split("/");
    const apiIndex = parts.indexOf("v1");
    const bank = decodeURIComponent(parts[apiIndex + 3] ?? "");
    const suffix = parts.slice(apiIndex + 4).join("/");
    const body = init.body ? JSON.parse(init.body) : {};
    calls.push({ method: init.method, pathname, suffix, body });

    const response = (status, payload) => ({
      ok: status >= 200 && status < 300,
      status,
      text: async () => payload === undefined ? "" : JSON.stringify(payload),
      json: async () => payload,
    });
    const ok = (payload) => response(200, payload);

    const failureIndex = failures.findIndex((f) => f.method === init.method && f.suffix === suffix);
    if (failureIndex >= 0) {
      const [{ failure }] = failures.splice(failureIndex, 1);
      if (failure.throw) throw failure.throw;
      return response(failure.status, failure.body ?? { detail: "injected failure" });
    }

    if (
      apiIndex < 0 ||
      parts[apiIndex + 1] !== "default" ||
      parts[apiIndex + 2] !== "banks" ||
      !bank
    ) {
      return response(404, { detail: "wrong API path" });
    }

    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));

    // Create / update bank
    if (init.method === "PUT" && suffix === "") {
      ensureBank(bank);
      return ok({
        bank_id: bank,
        name: bank,
        mission: "",
        disposition: { skepticism: 3, literalism: 3, empathy: 3 },
      });
    }

    // Retain (upsert by document_id)
    if (init.method === "POST" && suffix === "memories") {
      if (!banks.has(bank)) return response(404, { detail: "bank not found" });
      const items = Array.isArray(body.items) ? body.items : [];
      if (items.some((item) => typeof item.content !== "string" || item.content.length === 0)) {
        return response(422, { detail: "content must not be empty" });
      }
      const store = banks.get(bank);
      for (const item of items) {
        const existing = store.get(item.document_id);
        let content = item.content;
        if (item.update_mode === "append" && existing) {
          try {
            const previousArray = JSON.parse(existing.content);
            const appendedArray = JSON.parse(item.content);
            content = Array.isArray(previousArray) && Array.isArray(appendedArray)
              ? JSON.stringify([...previousArray, ...appendedArray])
              : `${existing.content}\n${item.content}`;
          } catch {
            content = `${existing.content}\n${item.content}`;
          }
        }
        store.set(item.document_id, {
          content,
          tags: item.tags ?? [],
          metadata: item.metadata ?? {},
        });
      }
      return ok({ success: true, bank_id: bank, items_count: items.length, async: false });
    }

    // Exact document read
    if (init.method === "GET" && suffix.startsWith("documents/")) {
      const documentId = decodeURIComponent(suffix.slice("documents/".length));
      const doc = banks.get(bank)?.get(documentId);
      if (!doc) return response(404, { detail: "document not found" });
      return ok({
        id: documentId,
        bank_id: bank,
        original_text: doc.content,
        content_hash: null,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        memory_unit_count: 1,
        tags: doc.tags,
        metadata: doc.metadata,
      });
    }

    if (init.method === "DELETE" && suffix.startsWith("documents/")) {
      const documentId = decodeURIComponent(suffix.slice("documents/".length));
      const deleted = banks.get(bank)?.delete(documentId) ?? false;
      if (!deleted) return response(404, { detail: "document not found" });
      return ok({
        success: true,
        message: "deleted",
        document_id: documentId,
        memory_units_deleted: 1,
      });
    }

    // Recall (hard tag filter, mirrors documented tags_match semantics)
    if (init.method === "POST" && suffix === "memories/recall") {
      if (!banks.has(bank)) return response(404, { detail: "bank not found" });
      const store = banks.get(bank);
      const wanted = Array.isArray(body.tags) ? body.tags : [];
      const mode = body.tags_match ?? "any";
      const results = [];
      for (const [documentId, mem] of store.entries()) {
        const pass =
          wanted.length === 0
            ? true
            : mode === "all" || mode === "all_strict"
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

    if (init.method === "POST" && suffix === "reflect") {
      if (!banks.has(bank)) return response(404, { detail: "bank not found" });
      const text = [...banks.get(bank).values()].map((m) => m.content).join("\n");
      return ok({ text, based_on: { memories: [] } });
    }

    return response(404, { detail: "unsupported endpoint" });
  };

  return { fetchImpl, banks, calls, failNext };
}

function newStorage(fetchImpl, overrides = {}) {
  return new HindsightMemoryStorage({
    baseUrl: "http://hindsight.test",
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

async function startFakeHindsightHttpServer(options = {}) {
  const fake = makeFakeHindsight(options);
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const response = await fake.fetchImpl(
      `http://127.0.0.1${req.url}`,
      {
        method: req.method,
        headers: req.headers,
        body: chunks.length > 0 ? Buffer.concat(chunks).toString("utf8") : undefined,
      }
    );
    res.statusCode = response.status;
    const payload = await response.text();
    res.end(payload);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    ...fake,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve())),
  };
}

function appendFromChild(baseUrl, value) {
  const script = `
    import { HindsightMemoryStorage } from "./dist/memory.js";
    const storage = new HindsightMemoryStorage({
      baseUrl: process.env.TEST_HINDSIGHT_URL,
      bankPrefix: "sportsclaw",
      extractionMode: "verbatim",
      recallBudget: "mid",
      recallMaxTokens: 2048,
      timeoutMs: 5000
    });
    await storage.append("multi-process-user", "REFLECTIONS.md", process.env.TEST_APPEND_VALUE);
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        TEST_HINDSIGHT_URL: baseUrl,
        TEST_APPEND_VALUE: value,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`append child exited ${code}: ${stderr}`));
    });
  });
}

// ---------------------------------------------------------------------------
// Driver behavior
// ---------------------------------------------------------------------------

describe("HindsightMemoryStorage", () => {
  it("round-trips write → read verbatim", async () => {
    const { fetchImpl, calls } = makeFakeHindsight();
    const s = newStorage(fetchImpl);
    const content = "# Soul\nBorn: 2026-06-25\nExchanges: 3\n\n## Notes\nLikes the underdog.";
    await s.write("user-1", "SOUL.md", content);
    assert.equal(await s.read("user-1", "SOUL.md"), content);
    assert.ok(calls.some((call) => call.method === "GET" && call.suffix === "documents/soul"));
    assert.ok(!calls.some((call) => call.suffix === "memories/recall"));
  });

  it("returns empty string for an unknown slot", async () => {
    const { fetchImpl } = makeFakeHindsight();
    const s = newStorage(fetchImpl);
    assert.equal(await s.read("user-1", "FAN_PROFILE.md"), "");
  });

  it("appends with a newline separator and preserves order", async () => {
    const { fetchImpl, calls } = makeFakeHindsight();
    const s = newStorage(fetchImpl);
    await s.append("user-1", "REFLECTIONS.md", "first lesson");
    await s.append("user-1", "REFLECTIONS.md", "second lesson");
    assert.equal(await s.read("user-1", "REFLECTIONS.md"), "first lesson\nsecond lesson");
    const retains = calls.filter((call) => call.method === "POST" && call.suffix === "memories");
    assert.ok(retains.every((call) => call.body.items[0].update_mode === "append"));
    assert.equal(
      calls.filter((call) => call.method === "GET" && call.suffix === "documents/reflections").length,
      1,
      "only the final assertion should read; append itself must not read-modify-write"
    );
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

  it("serializes concurrent appends across storage instances", async () => {
    const { fetchImpl } = makeFakeHindsight({ delayMs: 5 });
    const first = newStorage(fetchImpl);
    const second = newStorage(fetchImpl);
    await Promise.all([
      first.append("user-1", "REFLECTIONS.md", "alpha"),
      second.append("user-1", "REFLECTIONS.md", "bravo"),
    ]);

    const out = await first.read("user-1", "REFLECTIONS.md");
    assert.deepEqual(out.split("\n").sort(), ["alpha", "bravo"]);
  });

  it("preserves concurrent appends from separate processes via server-side append", async () => {
    const server = await startFakeHindsightHttpServer({ delayMs: 15 });
    try {
      await Promise.all([
        appendFromChild(server.baseUrl, "child-alpha"),
        appendFromChild(server.baseUrl, "child-bravo"),
      ]);

      const storage = newStorage(globalThis.fetch, { baseUrl: server.baseUrl });
      const out = await storage.read("multi-process-user", "REFLECTIONS.md");
      assert.deepEqual(out.split("\n").sort(), ["child-alpha", "child-bravo"]);
      const retains = server.calls.filter(
        (call) => call.method === "POST" && call.suffix === "memories"
      );
      assert.equal(retains.length, 2);
      assert.ok(retains.every((call) => call.body.items[0].update_mode === "append"));
      assert.equal(
        server.calls.filter((call) => call.method === "GET").length,
        1,
        "child processes must delegate append correctness to Hindsight instead of reading first"
      );
    } finally {
      await server.close();
    }
  });

  it("clears a slot on remove", async () => {
    const { fetchImpl } = makeFakeHindsight();
    const s = newStorage(fetchImpl);
    await s.write("user-1", "CONTEXT.md", "ephemeral state");
    await s.remove("user-1", "CONTEXT.md");
    assert.equal(await s.read("user-1", "CONTEXT.md"), "");
  });

  it("isolates arbitrary user IDs via cryptographic bank scopes", async () => {
    const { fetchImpl, banks } = makeFakeHindsight();
    const s = newStorage(fetchImpl);
    // These values collide under the old sanitizeId + 32-bit hash implementation.
    await s.write("!~", "SOUL.md", "FIRST-SOUL");
    await s.write('"_', "SOUL.md", "SECOND-SOUL");

    assert.equal(await s.read("!~", "SOUL.md"), "FIRST-SOUL");
    assert.equal(await s.read('"_', "SOUL.md"), "SECOND-SOUL");

    const bankIds = [...banks.keys()];
    assert.equal(bankIds.length, 2);
    assert.ok(bankIds.every((id) => /^sportsclaw-[a-f0-9]{64}$/.test(id)));
    assert.notEqual(bankIds[0], bankIds[1]);
  });

  it("preserves agent isolation through every MemoryStorage method", async () => {
    const { fetchImpl, banks } = makeFakeHindsight();
    const s = newStorage(fetchImpl);
    const today = new Date().toISOString().slice(0, 10);
    await s.write("shared-user", "SOUL.md", "AGENT-A", "agent-a");
    await s.write("shared-user", "SOUL.md", "AGENT-B", "agent-b");
    await s.append("shared-user", `${today}.md`, "A log", "agent-a");
    await s.append("shared-user", `${today}.md`, "B log", "agent-b");

    assert.equal(await s.read("shared-user", "SOUL.md", "agent-a"), "AGENT-A");
    assert.equal(await s.read("shared-user", "SOUL.md", "agent-b"), "AGENT-B");
    assert.deepEqual(await s.list("shared-user", "daily-log", "agent-a"), [`${today}.md`]);
    assert.deepEqual(await s.list("shared-user", "daily-log", "agent-b"), [`${today}.md`]);
    assert.equal(banks.size, 2);

    await s.remove("shared-user", "SOUL.md", "agent-a");
    assert.equal(await s.read("shared-user", "SOUL.md", "agent-a"), "");
    assert.equal(await s.read("shared-user", "SOUL.md", "agent-b"), "AGENT-B");
  });

  it("tags each memory with its source surface and user scope", async () => {
    const { fetchImpl, banks } = makeFakeHindsight();
    const s = newStorage(fetchImpl);
    await s.write("u1", "STRATEGY.md", "be bold");
    const mem = [...banks.values()][0].get("strategy");
    assert.ok(mem.tags.includes("sportsclaw"));
    assert.ok(mem.tags.some((tag) => /^scope:[a-f0-9]{64}$/.test(tag)));
    assert.ok(mem.tags.includes("surface:strategy"));
    assert.equal(mem.metadata.surface, "strategy");
    assert.equal(mem.metadata.file, "STRATEGY.md");
  });

  it("tags daily logs with the date surface", async () => {
    const { fetchImpl, banks } = makeFakeHindsight();
    const s = newStorage(fetchImpl);
    await s.write("u1", "2026-06-25.md", "today's chatter");
    const mem = [...banks.values()][0].get("daily:2026-06-25");
    assert.ok(mem.tags.includes("surface:daily"));
    assert.ok(mem.tags.includes("date:2026-06-25"));
  });

  it("creates the bank with verbatim extraction exactly once", async () => {
    const { fetchImpl, calls } = makeFakeHindsight();
    const s = newStorage(fetchImpl);
    await s.write("u1", "SOUL.md", "a");
    await s.write("u1", "FAN_PROFILE.md", "b");
    const bankCreates = calls.filter((c) => c.method === "PUT" && c.suffix === "");
    assert.equal(bankCreates.length, 1, "ensureBank should be cached per process");
    assert.equal(bankCreates[0].body.retain_extraction_mode, "verbatim");
    assert.match(bankCreates[0].pathname, /^\/v1\/default\/banks\/sportsclaw-[a-f0-9]{64}$/);
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

  it("does not lose thread messages across concurrent storage instances", async () => {
    const { fetchImpl } = makeFakeHindsight({ delayMs: 5 });
    const first = new MemoryManager("user-thread", newStorage(fetchImpl));
    const second = new MemoryManager("user-thread", newStorage(fetchImpl));
    await Promise.all([
      first.appendToThread("first question", "first answer"),
      second.appendToThread("second question", "second answer"),
    ]);

    const thread = await first.readThread();
    assert.deepEqual(
      thread.map((message) => message.content),
      ["first question", "first answer", "second question", "second answer"]
    );
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

  it("bounds semantic recall and forwards the native-agent scope", async () => {
    let seenOptions;
    const storage = {
      read: async () => "",
      write: async () => {},
      append: async () => {},
      list: async () => [],
      remove: async () => {},
      recall: async (_userId, _query, options) => {
        seenOptions = options;
        return Array.from({ length: 20 }, (_, index) => ({
          text: `${index}:${"x".repeat(2_000)}`,
        }));
      },
    };
    const mm = new MemoryManager("user-recall", storage, "agent-recall");
    const recalled = await mm.recallContext("what do I like?");

    assert.equal(seenOptions.agentId, "agent-recall");
    assert.equal(seenOptions.maxTokens, 2_048);
    assert.ok(recalled.length <= 8_000);
    assert.ok(!recalled.includes("8:"), "at most eight results should be included");
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

  it("reports failed reads and writes when the server is unreachable", async () => {
    let calls = 0;
    const failing = async () => {
      calls++;
      throw new Error("ECONNREFUSED");
    };
    const s = newStorage(failing);
    await assert.rejects(s.write("u1", "SOUL.md", "x"), /failed to create or update/);
    await assert.rejects(s.read("u1", "SOUL.md"), /Hindsight failed to read SOUL.md/);
    assert.equal(calls, 1, "a failed request should open the per-turn circuit");
  });

  it("combines the engine abort signal with the request timeout", async () => {
    const controller = new AbortController();
    controller.abort();
    let seenSignal;
    const fetchImpl = async (_url, init) => {
      seenSignal = init.signal;
      throw new Error("aborted");
    };
    const s = newStorage(fetchImpl, { abortSignal: controller.signal });

    await assert.rejects(s.write("u1", "SOUL.md", "x"), /failed to create or update/);
    assert.equal(seenSignal.aborted, true);
  });

  it("recovers on a new turn after a bank creation transport failure", async () => {
    const { fetchImpl, calls, failNext } = makeFakeHindsight();
    const s = newStorage(fetchImpl);
    failNext("PUT", "", { throw: new Error("ECONNRESET") });

    await assert.rejects(s.write("u1", "SOUL.md", "dropped"), /failed to create or update/);
    const nextTurn = newStorage(fetchImpl);
    await nextTurn.write("u1", "SOUL.md", "persisted");

    assert.equal(await nextTurn.read("u1", "SOUL.md"), "persisted");
    assert.equal(calls.filter((call) => call.method === "PUT" && call.suffix === "").length, 2);
  });

  it("does not need an exact read before a server-side append", async () => {
    const { fetchImpl, failNext } = makeFakeHindsight();
    const s = newStorage(fetchImpl);
    await s.write("u1", "REFLECTIONS.md", "existing");
    failNext("GET", "documents/reflections", { status: 503 });

    await s.append("u1", "REFLECTIONS.md", "new");
    await assert.rejects(s.read("u1", "REFLECTIONS.md"), /failed to read/);
    assert.equal(await newStorage(fetchImpl).read("u1", "REFLECTIONS.md"), "existing\nnew");
  });

  it("reports a failed server-side append without replacing existing content", async () => {
    const { fetchImpl, failNext } = makeFakeHindsight();
    const s = newStorage(fetchImpl);
    await s.write("u1", "REFLECTIONS.md", "existing");
    failNext("POST", "memories", { status: 503 });

    await assert.rejects(s.append("u1", "REFLECTIONS.md", "new"), /failed to append/);
    assert.equal(await newStorage(fetchImpl).read("u1", "REFLECTIONS.md"), "existing");
  });

  it("does not replace a thread after an atomic thread append fails", async () => {
    const { fetchImpl, failNext } = makeFakeHindsight();
    const storage = newStorage(fetchImpl);
    const mm = new MemoryManager("u1", storage);
    await storage.write("u1", "thread.json", '[{"role":"user","content":"existing","ts":"t"}]');
    failNext("POST", "memories", { status: 503 });

    await assert.rejects(mm.appendToThread("new question", "new answer"));
    assert.equal(
      await newStorage(fetchImpl).read("u1", "thread.json"),
      '[{"role":"user","content":"existing","ts":"t"}]'
    );
  });

  it("blocks replacements after an indeterminate exact read", async () => {
    const { fetchImpl, failNext } = makeFakeHindsight();
    const s = newStorage(fetchImpl);
    await s.write("u1", "SOUL.md", "existing");
    failNext("GET", "documents/fan_profile", { status: 503 });

    await assert.rejects(s.read("u1", "FAN_PROFILE.md"), /failed to read/);
    await assert.rejects(s.write("u1", "SOUL.md", "replacement"), /replacement blocked/);
    assert.equal(await newStorage(fetchImpl).read("u1", "SOUL.md"), "existing");
  });

  it("rejects a successful HTTP response whose retain payload reports failure", async () => {
    const { fetchImpl, failNext } = makeFakeHindsight();
    const s = newStorage(fetchImpl);
    failNext("POST", "memories", { status: 200, body: { success: false } });

    await assert.rejects(s.write("u1", "SOUL.md", "not persisted"), /failed to write/);
    assert.equal(await s.read("u1", "SOUL.md"), "");
  });
});

describe("engine Hindsight recall integration", () => {
  it("injects scoped semantic recall as non-authoritative user context", async () => {
    const server = await startFakeHindsightHttpServer();
    const root = mkdtempSync(join(tmpdir(), "sportsclaw-hindsight-engine-"));
    const agentsDir = join(root, "agents");
    const schemasDir = join(root, "schemas");
    mkdirSync(agentsDir, { recursive: true });
    mkdirSync(schemasDir, { recursive: true });
    writeFileSync(
      join(agentsDir, "memory-agent.md"),
      "---\nname: Memory Agent\nskills: []\nactive: true\n---\nUse memory carefully.\n"
    );

    const envKeys = [
      "SPORTSCLAW_MEMORY_PROVIDER",
      "HINDSIGHT_BASE_URL",
      "SPORTSCLAW_AGENTS_DIR",
      "sportsclaw_SCHEMA_DIR",
    ];
    const saved = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    process.env.SPORTSCLAW_MEMORY_PROVIDER = "hindsight";
    process.env.HINDSIGHT_BASE_URL = server.baseUrl;
    process.env.SPORTSCLAW_AGENTS_DIR = agentsDir;
    process.env.sportsclaw_SCHEMA_DIR = schemasDir;

    try {
      const seed = newStorage(globalThis.fetch, { baseUrl: server.baseUrl });
      await seed.write(
        "engine-user",
        "ARCHIVE.md",
        "The user prefers late injury updates.",
        "memory-agent"
      );
      const seededBankPath = server.calls.find(
        (call) => call.method === "POST" && call.suffix === "memories"
      ).pathname;

      const model = new MockLanguageModelV3({
        doGenerate: async () => ({
          content: [{ type: "text", text: "response from mock model" }],
          finishReason: { unified: "stop", raw: undefined },
          usage: {
            inputTokens: { total: 10 },
            outputTokens: { total: 5 },
            totalTokens: { total: 15 },
            reasoningTokens: { total: undefined },
          },
          warnings: [],
        }),
      });
      const engine = new sportsclawEngine({
        clarifyOnLowConfidence: false,
        thinkingBudget: 0,
        verbose: false,
      });
      engine.mainModel = model;

      const answer = await engine.run("What should I watch for?", {
        userId: "engine-user",
        agentIds: ["memory-agent"],
      });
      assert.equal(answer, "response from mock model");

      const recallCall = server.calls.find((call) => call.suffix === "memories/recall");
      assert.ok(recallCall, "engine.run must issue semantic recall");
      assert.equal(recallCall.body.max_tokens, 2_048);
      assert.equal(
        recallCall.pathname.replace(/\/memories\/recall$/, "/memories"),
        seededBankPath,
        "engine recall must use the selected native agent's bank"
      );
      const modelCall = model.doGenerateCalls.at(-1);
      const memoryMessage = modelCall.prompt.find(
        (message) =>
          message.role === "user" &&
          message.content.some((part) => part.type === "text" && part.text.includes("[MEMORY]"))
      );
      assert.ok(memoryMessage);
      const memoryText = memoryMessage.content.map((part) => part.text ?? "").join("\n");
      assert.match(memoryText, /Semantic recall \(possibly stale or incorrect\)/);
      assert.match(memoryText, /late injury updates/);
      const systemText = modelCall.prompt
        .filter((message) => message.role === "system")
        .flatMap((message) => message.content)
        .map((part) => part.text ?? "")
        .join("\n");
      assert.doesNotMatch(systemText, /late injury updates/);
    } finally {
      for (const key of envKeys) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
      rmSync(root, { recursive: true, force: true });
      await server.close();
    }
  });

  it("continues an engine run when semantic recall fails", async () => {
    const server = await startFakeHindsightHttpServer();
    const root = mkdtempSync(join(tmpdir(), "sportsclaw-hindsight-failure-"));
    const agentsDir = join(root, "agents");
    const schemasDir = join(root, "schemas");
    mkdirSync(agentsDir, { recursive: true });
    mkdirSync(schemasDir, { recursive: true });
    const saved = {
      provider: process.env.SPORTSCLAW_MEMORY_PROVIDER,
      url: process.env.HINDSIGHT_BASE_URL,
      agents: process.env.SPORTSCLAW_AGENTS_DIR,
      schemas: process.env.sportsclaw_SCHEMA_DIR,
    };
    process.env.SPORTSCLAW_MEMORY_PROVIDER = "hindsight";
    process.env.HINDSIGHT_BASE_URL = server.baseUrl;
    process.env.SPORTSCLAW_AGENTS_DIR = agentsDir;
    process.env.sportsclaw_SCHEMA_DIR = schemasDir;
    server.failNext("POST", "memories/recall", { status: 503 });

    try {
      const model = new MockLanguageModelV3({
        doGenerate: async () => ({
          content: [{ type: "text", text: "still answered" }],
          finishReason: { unified: "stop", raw: undefined },
          usage: {
            inputTokens: { total: 1 },
            outputTokens: { total: 1 },
            totalTokens: { total: 2 },
            reasoningTokens: { total: undefined },
          },
          warnings: [],
        }),
      });
      const engine = new sportsclawEngine({ clarifyOnLowConfidence: false, thinkingBudget: 0 });
      engine.mainModel = model;
      assert.equal(await engine.run("Any updates?", { userId: "failure-user" }), "still answered");
    } finally {
      if (saved.provider === undefined) delete process.env.SPORTSCLAW_MEMORY_PROVIDER;
      else process.env.SPORTSCLAW_MEMORY_PROVIDER = saved.provider;
      if (saved.url === undefined) delete process.env.HINDSIGHT_BASE_URL;
      else process.env.HINDSIGHT_BASE_URL = saved.url;
      if (saved.agents === undefined) delete process.env.SPORTSCLAW_AGENTS_DIR;
      else process.env.SPORTSCLAW_AGENTS_DIR = saved.agents;
      if (saved.schemas === undefined) delete process.env.sportsclaw_SCHEMA_DIR;
      else process.env.sportsclaw_SCHEMA_DIR = saved.schemas;
      rmSync(root, { recursive: true, force: true });
      await server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Provider selection
// ---------------------------------------------------------------------------

describe("createMemoryStorage provider selection", () => {
  const ENV_KEYS = [
    "SPORTSCLAW_MEMORY_PROVIDER",
    "SPORTSCLAW_MEMORY_BACKEND",
    "HINDSIGHT_BASE_URL",
    "HINDSIGHT_NAMESPACE",
    "HINDSIGHT_BANK_PREFIX",
    "HINDSIGHT_RETAIN_EXTRACTION_MODE",
    "HINDSIGHT_RECALL_BUDGET",
    "HINDSIGHT_RECALL_MAX_TOKENS",
    "HINDSIGHT_REQUEST_TIMEOUT_MS",
  ];
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

  it("preserves legacy auto selection when a Machina server is connected", () => {
    const mcpManager = { getMachinaServerName: () => "machina-test" };
    const sel = createMemoryStorage({ mcpManager });
    assert.equal(sel.requested, "auto");
    assert.equal(sel.provider, "pod");
  });

  it("keeps explicit file selection local when a Machina server is connected", () => {
    process.env.SPORTSCLAW_MEMORY_PROVIDER = "file";
    const mcpManager = { getMachinaServerName: () => "machina-test" };
    const sel = createMemoryStorage({ mcpManager });
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

  it("rejects auto on the canonical provider selector", () => {
    process.env.SPORTSCLAW_MEMORY_PROVIDER = "auto";
    assert.throws(() => createMemoryStorage({}), /Invalid SPORTSCLAW_MEMORY_PROVIDER/);
  });

  it("rejects hindsight on the legacy backend selector", () => {
    process.env.SPORTSCLAW_MEMORY_BACKEND = "hindsight";
    assert.throws(() => createMemoryStorage({}), /Invalid SPORTSCLAW_MEMORY_BACKEND/);
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

  it("validates Hindsight numeric and URL configuration strictly", () => {
    process.env.HINDSIGHT_RECALL_MAX_TOKENS = "1.5";
    assert.throws(() => hindsightConfigFromEnv(), /positive integer/);
    process.env.HINDSIGHT_RECALL_MAX_TOKENS = "100";
    process.env.HINDSIGHT_REQUEST_TIMEOUT_MS = "Infinity";
    assert.throws(() => hindsightConfigFromEnv(), /positive integer/);
    process.env.HINDSIGHT_REQUEST_TIMEOUT_MS = "1000";
    process.env.HINDSIGHT_BASE_URL = "file:///tmp/hindsight";
    assert.throws(() => hindsightConfigFromEnv(), /absolute http\(s\) URL|Use an http\(s\) URL/);

    process.env.HINDSIGHT_BASE_URL = "https://user:pass@hindsight.test";
    assert.throws(() => hindsightConfigFromEnv(), /without credentials/);
    process.env.HINDSIGHT_BASE_URL = "https://hindsight.test?namespace=other";
    assert.throws(() => hindsightConfigFromEnv(), /without credentials, query, or fragment/);
  });

  it("uses the current default namespace path and rejects unsafe bank prefixes", async () => {
    process.env.HINDSIGHT_BANK_PREFIX = "unsafe/prefix";
    assert.throws(() => hindsightConfigFromEnv(), /Invalid HINDSIGHT_BANK_PREFIX/);

    delete process.env.HINDSIGHT_BANK_PREFIX;
    process.env.HINDSIGHT_NAMESPACE = "../untrusted";
    assert.equal("namespace" in hindsightConfigFromEnv(), false);
    const { fetchImpl, calls } = makeFakeHindsight();
    const s = newStorage(fetchImpl, { baseUrl: "https://hindsight.test/api/" });
    await s.write("u1", "SOUL.md", "safe");
    assert.match(calls[0].pathname, /^\/api\/v1\/default\/banks\//);
  });
});
