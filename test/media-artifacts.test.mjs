/**
 * Media artifact store — every later tool validates its inputs through it.
 */

import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, unlinkSync, symlinkSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const { ArtifactStore, ArtifactError } = await import(join(repoRoot, "dist/media/artifacts.js"));

const SRC_X = "a".repeat(64);
const SRC_Y = "b".repeat(64);

async function rejectsWith(promise, code) {
  await assert.rejects(promise, (e) => {
    assert.ok(e instanceof ArtifactError, `expected ArtifactError, got ${e}`);
    assert.equal(e.code, code);
    return true;
  });
}

describe("ArtifactStore", () => {
  let root, ws, outside, n = 0;
  const mk = (content = "hello") => {
    const p = join(ws, `f${n++}.bin`);
    writeFileSync(p, content);
    return p;
  };
  before(() => {
    root = mkdtempSync(join(tmpdir(), "media-art-"));
    ws = join(root, "ws");
    outside = join(root, "outside");
    mkdirSync(ws);
    mkdirSync(outside);
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it("register then require returns the same record", async () => {
    const s = new ArtifactStore({ workspaceDir: ws, runId: "runA" });
    const a = await s.register({ kind: "source", path: mk("abc"), facts: { k: 1 } });
    assert.match(a.id, /^art_[0-9a-f]{16}$/);
    assert.equal(a.runId, "runA");
    assert.equal(a.sizeBytes, 3);
    assert.match(a.sha256, /^[0-9a-f]{64}$/);
    const b = await s.require(a.id, "source");
    assert.deepEqual(b, a);
    // a fresh store instance in the same run reads the persisted registry
    const s2 = new ArtifactStore({ workspaceDir: ws, runId: "runA" });
    assert.deepEqual(await s2.require(a.id, "source"), a);
  });

  it("wrong kind -> artifact_wrong_kind", async () => {
    const s = new ArtifactStore({ workspaceDir: ws, runId: "runA" });
    const a = await s.register({ kind: "source", path: mk() });
    await rejectsWith(s.require(a.id, "video"), "artifact_wrong_kind");
  });

  it("unknown or malformed id -> artifact_unknown", async () => {
    const s = new ArtifactStore({ workspaceDir: ws, runId: "runA" });
    await rejectsWith(s.require("art_0123456789abcdef", "source"), "artifact_unknown");
    await rejectsWith(s.require("../../etc/passwd", "source"), "artifact_unknown");
    await rejectsWith(s.require("", "source"), "artifact_unknown");
  });

  it("appended byte -> artifact_changed", async () => {
    const s = new ArtifactStore({ workspaceDir: ws, runId: "runA" });
    const p = mk();
    const a = await s.register({ kind: "source", path: p });
    appendFileSync(p, "x");
    await rejectsWith(s.require(a.id, "source"), "artifact_changed");
  });

  it("deleted file -> artifact_changed", async () => {
    const s = new ArtifactStore({ workspaceDir: ws, runId: "runA" });
    const p = mk();
    const a = await s.register({ kind: "source", path: p });
    unlinkSync(p);
    await rejectsWith(s.require(a.id, "source"), "artifact_changed");
  });

  it("non-shared artifact from run A is refused in run B", async () => {
    const A = new ArtifactStore({ workspaceDir: ws, runId: "runA" });
    const B = new ArtifactStore({ workspaceDir: ws, runId: "runB" });
    const a = await A.register({ kind: "source", path: mk(), sourceSha256: SRC_X });
    await rejectsWith(B.require(a.id, "source"), "artifact_wrong_run");
    await rejectsWith(B.require(a.id, "source", { sourceSha256: SRC_X }), "artifact_wrong_run");
  });

  it("shared artifact is usable in run B for its source only", async () => {
    const A = new ArtifactStore({ workspaceDir: ws, runId: "runA" });
    const B = new ArtifactStore({ workspaceDir: ws, runId: "runB" });
    const a = await A.register({ kind: "clock-map", path: mk(), sourceSha256: SRC_X, shared: true });
    assert.deepEqual(await B.require(a.id, "clock-map", { sourceSha256: SRC_X }), a);
    await rejectsWith(B.require(a.id, "clock-map", { sourceSha256: SRC_Y }), "artifact_wrong_source");
    // cross-run use without asserting a source is not allowed
    await rejectsWith(B.require(a.id, "clock-map"), "artifact_wrong_source");
    // same run, wrong source is also refused
    await rejectsWith(A.require(a.id, "clock-map", { sourceSha256: SRC_Y }), "artifact_wrong_source");
  });

  it("forSource lists shared artifacts newest first, filtered by kind", async () => {
    const w2 = join(root, "ws-forsource");
    mkdirSync(w2);
    const p = (name) => { const f = join(w2, name); writeFileSync(f, name); return f; };
    const A = new ArtifactStore({ workspaceDir: w2, runId: "runA" });
    const B = new ArtifactStore({ workspaceDir: w2, runId: "runB" });
    const first = await A.register({ kind: "clock-map", path: p("1"), sourceSha256: SRC_X, shared: true });
    const second = await A.register({ kind: "event-index", path: p("2"), sourceSha256: SRC_X, shared: true });
    const third = await A.register({ kind: "clock-map", path: p("3"), sourceSha256: SRC_X, shared: true });
    await A.register({ kind: "clock-map", path: p("4"), sourceSha256: SRC_X }); // not shared
    await A.register({ kind: "clock-map", path: p("5"), sourceSha256: SRC_Y, shared: true });
    assert.deepEqual((await B.forSource(SRC_X)).map((a) => a.id), [third.id, second.id, first.id]);
    assert.deepEqual((await B.forSource(SRC_X, "clock-map")).map((a) => a.id), [third.id, first.id]);
    assert.deepEqual(await B.forSource("c".repeat(64)), []);
    assert.deepEqual(await B.forSource("../x"), []);
  });

  it("refuses paths outside workspaceDir at register", async () => {
    const s = new ArtifactStore({ workspaceDir: ws, runId: "runA" });
    const out = join(outside, "o.bin");
    writeFileSync(out, "o");
    await assert.rejects(s.register({ kind: "source", path: out }), /outside workspace/);
    await assert.rejects(s.register({ kind: "source", path: join(ws, "..", "outside", "o.bin") }), /outside workspace/);
    // symlink inside the workspace pointing outside is refused
    const link = join(ws, "link.bin");
    symlinkSync(out, link);
    await assert.rejects(s.register({ kind: "source", path: link }), /outside workspace/);
  });

  it("refuses shared registration without a valid sourceSha256", async () => {
    const s = new ArtifactStore({ workspaceDir: ws, runId: "runA" });
    await assert.rejects(s.register({ kind: "clock-map", path: mk(), shared: true }), /sourceSha256/);
    await assert.rejects(s.register({ kind: "clock-map", path: mk(), sourceSha256: "../x", shared: true }), /sourceSha256/);
  });
});
