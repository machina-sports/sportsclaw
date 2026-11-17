/**
 * Media local job runner — limits, environment, and manifest intake.
 */

import assert from "node:assert/strict";
import { describe, it, after } from "node:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = join(repoRoot, "test/fixtures/media/pack-jobs");
const SKILL = "pack-jobs";
const { LocalJobRunner } = await import(join(repoRoot, "dist/media/jobs.js"));
const { ArtifactStore } = await import(join(repoRoot, "dist/media/artifacts.js"));
const { bundleSha256, approvedJobKinds, JOB_ALLOWLIST_ENV } = await import(join(repoRoot, "dist/media/bundle.js"));
const { PASSTHROUGH_ENV } = await import(join(repoRoot, "dist/skill-runtime.js"));

let n = 0;
const tmp = mkdtempSync(join(tmpdir(), "jobs-test-"));
// Sealed bundles go to os.tmpdir(); keep ours private so parallel test files that watch the shared tmpdir
// (media-bundle) are not disturbed, and so we can check every sealed copy is disposed.
const SEAL_TMP = join(tmp, "sealed");
mkdirSync(SEAL_TMP);
process.env.TMPDIR = SEAL_TMP;
after(() => rmSync(tmp, { recursive: true, force: true }));

function copyPack() {
  const dir = join(tmp, `pack-${n++}`, SKILL);
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

/** Approved decls of a pack, the way the caller (Task 10) obtains them. */
async function approved(skillDir) {
  const sha = await bundleSha256(skillDir);
  const kinds = JSON.parse(readFileSync(join(skillDir, "jobs.json"), "utf8")).jobs.map((j) => j.kind);
  const env = { [JOB_ALLOWLIST_ENV]: JSON.stringify(kinds.map((kind) => ({ skill: SKILL, kind, bundleSha256: sha }))) };
  const decls = await approvedJobKinds([{ id: SKILL, name: SKILL, description: "", body: "", dir: skillDir }], env);
  return { sha, decl: (kind) => decls.find((d) => d.kind === kind) };
}

function setup(config = {}, extra = {}) {
  const workspaceDir = join(tmp, `ws-${n++}`);
  mkdirSync(workspaceDir, { recursive: true });
  const store = new ArtifactStore({ workspaceDir, runId: "run_1" });
  const runner = new LocalJobRunner({ store, config: { workspaceDir, ...config }, env: extra.env ?? process.env, roleProxy: extra.roleProxy });
  return { workspaceDir, store, runner };
}

const pack = copyPack();
const A = await approved(pack);

async function run(runner, kind, input = {}, more = {}) {
  const rec = await runner.start({ decl: A.decl(kind), skillDir: pack, bundleSha256: A.sha, input, ...more });
  return runner.status(rec.jobId, { waitSec: 30 });
}

function registeredCount(workspaceDir) {
  const dir = join(workspaceDir, "artifacts");
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).length : 0;
}

async function rejects(promise, code) {
  await assert.rejects(promise, (err) => {
    assert.equal(err.code, code, `expected ${code}, got ${err.code}: ${err.message}`);
    return true;
  });
}

const SRC = { path: "/media/game.mp4", sha256: "a".repeat(64) };
const RIGHTS = { rightsHolder: "League", licenseRef: "L-1", clearedForClipping: true };

describe("LocalJobRunner", () => {
  it("ok_job succeeds and its artifact is registered with the right kind and sha256", async () => {
    const { runner, store, workspaceDir } = setup();
    const rec = await run(runner, "ok-job", { text: "hi" });
    assert.equal(rec.state, "succeeded", rec.error);
    assert.match(rec.jobId, /^job_[0-9a-f]{16}$/);
    assert.equal(rec.skill, SKILL);
    assert.equal(rec.kind, "ok-job");
    assert.ok(rec.endedAt);
    assert.equal(rec.artifacts.length, 1);
    const art = rec.artifacts[0];
    assert.equal(art.kind, "facts");
    assert.deepEqual(art.facts, { n: 1 });
    const file = join(workspaceDir, "jobs", rec.jobId, "out", "result.json");
    assert.equal(art.sha256, createHash("sha256").update(readFileSync(file)).digest("hex"));
    assert.deepEqual(await store.require(art.id, "facts"), art);
    assert.equal(rec.rightsCheck, undefined);
  });

  it("runs the sealed script by absolute path under <sealed>/scripts/", async () => {
    const { runner } = setup();
    const rec = await run(runner, "ok-job", { text: "hi" });
    assert.equal(rec.state, "succeeded", rec.error);
    assert.ok(isAbsolute(rec.facts.argv0), rec.facts.argv0);
    assert.ok(rec.facts.argv0.endsWith("/scripts/ok_job.py"));
    assert.ok(!rec.facts.argv0.startsWith(pack), "must run the sealed copy, not the live skill dir");
  });

  it("refuses input failing inputSchema with invalid_input, and nothing runs", async () => {
    const { runner, workspaceDir } = setup();
    for (const input of [{ text: 5 }, {}, { text: "x", extra: 1 }, "str", null]) {
      await rejects(runner.start({ decl: A.decl("ok-job"), skillDir: pack, bundleSha256: A.sha, input }), "invalid_input");
    }
    assert.equal(existsSync(join(workspaceDir, "jobs")), false);
  });

  it("readsSource without rights under require -> rights_required; under off it runs and notes it", async () => {
    const req = { decl: A.decl("source-job"), skillDir: pack, bundleSha256: A.sha, input: {} };
    const strict = setup({ rightsCheck: "require" }).runner;
    await rejects(strict.start({ ...req, source: SRC }), "rights_required");
    await rejects(strict.start({ ...req, source: { ...SRC, rights: { ...RIGHTS, clearedForClipping: false } } }), "rights_required");
    const cleared = await run(strict, "source-job", {}, { source: { ...SRC, rights: RIGHTS } });
    assert.equal(cleared.state, "succeeded", cleared.error);
    assert.equal(cleared.rightsCheck, undefined);
    assert.equal(cleared.artifacts[0].sourceSha256, SRC.sha256);

    const off = setup({ rightsCheck: "off" }).runner;
    const rec = await run(off, "source-job", {}, { source: SRC });
    assert.equal(rec.state, "succeeded", rec.error);
    assert.equal(rec.rightsCheck, "off (operator)");
    assert.deepEqual(rec.facts.source, { path: SRC.path, sha256: SRC.sha256 });
  });

  it("slow_job past timeLimitSec is killed: failed, error mentions the limit, no artifacts", async () => {
    const { runner, workspaceDir } = setup();
    const t0 = Date.now();
    const rec = await run(runner, "slow-job");
    assert.equal(rec.state, "failed");
    assert.match(rec.error, /time limit/i);
    assert.match(rec.error, /1\s?s/);
    assert.equal(rec.artifacts.length, 0);
    assert.ok(Date.now() - t0 < 10_000);
    assert.equal(registeredCount(workspaceDir), 0);
  });

  it("big_job writing past maxOutputBytes is killed: failed, no artifacts", async () => {
    const { runner, workspaceDir } = setup();
    const rec = await run(runner, "big-job");
    assert.equal(rec.state, "failed");
    assert.match(rec.error, /output/i);
    assert.equal(rec.artifacts.length, 0);
    assert.equal(registeredCount(workspaceDir), 0);
  });

  for (const mode of ["dotdot", "abs", "symlink"]) {
    it(`escape_job naming ${mode} -> failed, artifact_path, nothing registered`, async () => {
      const { runner, workspaceDir } = setup();
      const rec = await run(runner, "escape-job", { mode });
      assert.equal(rec.state, "failed");
      assert.match(rec.error, /^artifact_path/);
      assert.equal(rec.artifacts.length, 0);
      assert.equal(registeredCount(workspaceDir), 0);
    });
  }

  it("a manifest kind not in produces -> failed, artifact_kind", async () => {
    const { runner, workspaceDir } = setup();
    const rec = await run(runner, "ok-job", { text: "x", kind: "video" });
    assert.equal(rec.state, "failed");
    assert.match(rec.error, /^artifact_kind/);
    assert.equal(registeredCount(workspaceDir), 0);
  });

  it("env_job sees only the passthrough names plus the two role-proxy names", async () => {
    const env = {
      PATH: process.env.PATH,
      LANG: "C.UTF-8",
      HOME: "/home/x",
      PYTHONPATH: "/evil",
      OPENAI_API_KEY: "sk-1",
      GITHUB_TOKEN: "ghp",
      SPORTSCLAW_MEDIA_JOB_ALLOWLIST: "[]",
    };
    const { runner } = setup({}, { env, roleProxy: { url: "http://127.0.0.1:9/", token: "t" } });
    const rec = await run(runner, "env-job");
    assert.equal(rec.state, "succeeded", rec.error);
    const allowed = new Set([...PASSTHROUGH_ENV, "SPORTSCLAW_ROLE_PROXY_URL", "SPORTSCLAW_ROLE_PROXY_TOKEN"]);
    // macOS CoreFoundation adds this inside the Python process itself (it appears even under `env -i`).
    if (process.platform === "darwin") allowed.add("__CF_USER_TEXT_ENCODING");
    for (const name of rec.facts.env) assert.ok(allowed.has(name), `unexpected env name ${name}`);
    assert.ok(rec.facts.env.includes("SPORTSCLAW_ROLE_PROXY_URL"));
    assert.ok(rec.facts.env.includes("SPORTSCLAW_ROLE_PROXY_TOKEN"));
    const secrets = rec.facts.env.filter((k) => /_(KEY|TOKEN)$/.test(k));
    assert.deepEqual(secrets, ["SPORTSCLAW_ROLE_PROXY_TOKEN"]);
  });

  it("the 13th job with maxJobsPerRun unset -> job_budget", async () => {
    const { runner } = setup();
    const recs = [];
    for (let i = 0; i < 12; i++) {
      recs.push(await runner.start({ decl: A.decl("ok-job"), skillDir: pack, bundleSha256: A.sha, input: { text: "x" } }));
    }
    await rejects(runner.start({ decl: A.decl("ok-job"), skillDir: pack, bundleSha256: A.sha, input: { text: "x" } }), "job_budget");
    for (const r of recs) assert.equal((await runner.status(r.jobId, { waitSec: 30 })).state, "succeeded");
  });

  it("cancel on a running job -> canceled; status waitSec returns as soon as the job ends", async () => {
    const { runner, workspaceDir } = setup();
    const rec = await runner.start({ decl: A.decl("slow-job"), skillDir: pack, bundleSha256: A.sha, input: {} });
    assert.equal(rec.state, "running");
    const canceled = await runner.cancel(rec.jobId);
    assert.equal(canceled.state, "canceled");
    assert.equal((await runner.status(rec.jobId)).state, "canceled");
    assert.equal(registeredCount(workspaceDir), 0);

    const ok = await runner.start({ decl: A.decl("ok-job"), skillDir: pack, bundleSha256: A.sha, input: { text: "x" } });
    const t0 = Date.now();
    const done = await runner.status(ok.jobId, { waitSec: 5 });
    assert.equal(done.state, "succeeded", done.error);
    assert.ok(Date.now() - t0 < 4000, "status must return when the job ends, not after waitSec");
  });

  it("ruling 1: refuses a req.decl that differs from the sealed declaration (bundle_changed) or names an unknown kind", async () => {
    const { runner, workspaceDir } = setup();
    const forged = { ...A.decl("slow-job"), timeLimitSec: 3600 };
    await rejects(runner.start({ decl: forged, skillDir: pack, bundleSha256: A.sha, input: {} }), "bundle_changed");
    const unknown = { ...A.decl("ok-job"), kind: "no-such-kind" };
    await rejects(runner.start({ decl: unknown, skillDir: pack, bundleSha256: A.sha, input: { text: "x" } }), "unknown_kind");
    const edited = copyPack();
    writeFileSync(join(edited, "scripts/ok_job.py"), "print('changed')\n");
    await rejects(runner.start({ decl: A.decl("ok-job"), skillDir: edited, bundleSha256: A.sha, input: { text: "x" } }), "bundle_changed");
    assert.equal(existsSync(join(workspaceDir, "jobs")), false);
  });

  it("ruling 2: refuses an entry starting with '-' (invalid_entry)", async () => {
    const dir = copyPack();
    writeFileSync(join(dir, "scripts/-x.py"), "print(1)\n");
    const jobs = JSON.parse(readFileSync(join(dir, "jobs.json"), "utf8"));
    jobs.jobs.push({ kind: "dash-job", entry: "-x.py", readsSource: false, produces: ["facts"], inputSchema: { type: "object" } });
    writeFileSync(join(dir, "jobs.json"), JSON.stringify(jobs));
    const B = await approved(dir);
    assert.ok(B.decl("dash-job"));
    const { runner, workspaceDir } = setup();
    await rejects(runner.start({ decl: B.decl("dash-job"), skillDir: dir, bundleSha256: B.sha, input: {} }), "invalid_entry");
    assert.equal(existsSync(join(workspaceDir, "jobs")), false);
  });

  it("every sealed bundle is disposed once its job ends or is refused", () => {
    assert.equal(tmpdir(), SEAL_TMP);
    assert.deepEqual(readdirSync(SEAL_TMP).filter((f) => f.startsWith("sportsclaw-bundle-")), []);
  });
});
