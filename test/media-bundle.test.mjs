/**
 * Media job kinds — approved as a hashed bundle of a skill's scripts/.
 */

import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = join(repoRoot, "test/fixtures/media/pack-ok");
const { bundleSha256, approvedJobKinds, sealBundle, BundleError, JOB_ALLOWLIST_ENV } = await import(
  join(repoRoot, "dist/media/bundle.js")
);

let tmp;
let n = 0;
before(() => {
  tmp = mkdtempSync(join(tmpdir(), "bundle-test-"));
});
after(() => rmSync(tmp, { recursive: true, force: true }));

function copyPack() {
  const dir = join(tmp, `pack-${n++}`);
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}
const guide = (dir, id = "pack-ok") => ({ id, name: id, description: "", body: "", dir });
const allow = (entries) => ({ [JOB_ALLOWLIST_ENV]: JSON.stringify(entries) });

describe("bundleSha256", () => {
  it("is stable and 64 lowercase hex", async () => {
    const a = await bundleSha256(FIXTURE);
    assert.match(a, /^[0-9a-f]{64}$/);
    assert.equal(await bundleSha256(FIXTURE), a);
  });
  it("is independent of where the pack lives", async () => {
    assert.equal(await bundleSha256(copyPack()), await bundleSha256(FIXTURE));
  });
  it("changes when a file's bytes change", async () => {
    const dir = copyPack();
    const before = await bundleSha256(dir);
    writeFileSync(join(dir, "scripts/helper.py"), "def shout(t):\n    return t\n");
    assert.notEqual(await bundleSha256(dir), before);
  });
  it("changes when a file's name changes, or a file is added (including in subfolders)", async () => {
    const dir = copyPack();
    const base = await bundleSha256(dir);
    cpSync(join(dir, "scripts/helper.py"), join(dir, "scripts/helper2.py"));
    const added = await bundleSha256(dir);
    assert.notEqual(added, base);
    rmSync(join(dir, "scripts/helper2.py"));
    cpSync(join(dir, "scripts/helper.py"), join(dir, "scripts/renamed.py"));
    rmSync(join(dir, "scripts/helper.py"));
    assert.notEqual(await bundleSha256(dir), base);
    const dir2 = copyPack();
    cpSync(join(dir2, "scripts/helper.py"), join(dir2, "scripts/lib/helper.py"), { recursive: true });
    assert.notEqual(await bundleSha256(dir2), base);
  });
  it("ignores files outside scripts/", async () => {
    const dir = copyPack();
    const base = await bundleSha256(dir);
    writeFileSync(join(dir, "SKILL.md"), "changed");
    assert.equal(await bundleSha256(dir), base);
  });
  it("refuses a symlink anywhere under scripts/", async () => {
    const dir = copyPack();
    symlinkSync("/etc/hosts", join(dir, "scripts/link.py"));
    await assert.rejects(bundleSha256(dir), (e) => e instanceof BundleError && e.code === "bundle_symlink");
    const dir2 = copyPack();
    mkdirSync(join(dir2, "scripts/sub"));
    symlinkSync("helper.py", join(dir2, "scripts/sub/deep.py"));
    await assert.rejects(bundleSha256(dir2), (e) => e instanceof BundleError && e.code === "bundle_symlink");
  });
});

describe("approvedJobKinds", () => {
  it("yields nothing when there is no allowlist or the bundle is unlisted", async () => {
    assert.deepEqual(await approvedJobKinds([guide(FIXTURE)], {}), []);
    const sha = await bundleSha256(FIXTURE);
    assert.deepEqual(await approvedJobKinds([guide(FIXTURE)], allow([{ skill: "other", kind: "echo-job", bundleSha256: sha }])), []);
    assert.deepEqual(await approvedJobKinds([guide(FIXTURE)], allow([{ skill: "pack-ok", kind: "nope", bundleSha256: sha }])), []);
    assert.deepEqual(await approvedJobKinds([guide(FIXTURE)], allow([{ skill: "pack-ok", kind: "echo-job", bundleSha256: "0".repeat(64) }])), []);
  });
  it("yields the declared kinds for a listed bundle", async () => {
    const sha = await bundleSha256(FIXTURE);
    const kinds = await approvedJobKinds([guide(FIXTURE)], allow([{ skill: "pack-ok", kind: "echo-job", bundleSha256: sha }]));
    assert.equal(kinds.length, 1);
    assert.equal(kinds[0].skill, "pack-ok");
    assert.equal(kinds[0].kind, "echo-job");
    assert.equal(kinds[0].entry, "echo_job.py");
    assert.equal(kinds[0].readsSource, false);
    assert.equal(kinds[0].timeLimitSec, 30);
    assert.deepEqual(kinds[0].produces, ["facts"]);
  });
  it("a bundle edited after approval yields nothing", async () => {
    const dir = copyPack();
    const sha = await bundleSha256(dir);
    writeFileSync(join(dir, "scripts/helper.py"), "evil");
    assert.deepEqual(await approvedJobKinds([guide(dir)], allow([{ skill: "pack-ok", kind: "echo-job", bundleSha256: sha }])), []);
  });
  it("editing jobs.json after approval changes the hash and drops the kind", async () => {
    const dir = copyPack();
    const sha = await bundleSha256(dir);
    const env = allow([{ skill: "pack-ok", kind: "echo-job", bundleSha256: sha }]);
    assert.equal((await approvedJobKinds([guide(dir)], env)).length, 1);
    const j = JSON.parse(readFileSync(join(dir, "jobs.json"), "utf8"));
    j.jobs[0].readsSource = true;
    writeFileSync(join(dir, "jobs.json"), JSON.stringify(j));
    assert.notEqual(await bundleSha256(dir), sha);
    assert.deepEqual(await approvedJobKinds([guide(dir)], env), []);
  });
  it("a bundle with a symlink yields nothing", async () => {
    const dir = copyPack();
    const sha = await bundleSha256(dir);
    symlinkSync("helper.py", join(dir, "scripts/link.py"));
    assert.deepEqual(await approvedJobKinds([guide(dir)], allow([{ skill: "pack-ok", kind: "echo-job", bundleSha256: sha }])), []);
  });
  it("a guide without dir has no jobs", async () => {
    const sha = await bundleSha256(FIXTURE);
    const g = { id: "pack-ok", name: "x", description: "", body: "" };
    assert.deepEqual(await approvedJobKinds([g], allow([{ skill: "pack-ok", kind: "echo-job", bundleSha256: sha }])), []);
  });
  it("malformed or duplicate allowlists deny everything", async () => {
    const sha = await bundleSha256(FIXTURE);
    const good = { skill: "pack-ok", kind: "echo-job", bundleSha256: sha };
    const bad = [
      "not json",
      "{}",
      JSON.stringify([good, good]),
      JSON.stringify([{ ...good, extra: 1 }]),
      JSON.stringify([{ skill: "pack-ok", kind: "echo-job" }]),
      JSON.stringify([{ ...good, bundleSha256: sha.toUpperCase() }]),
      JSON.stringify([{ ...good, bundleSha256: "abc" }]),
      JSON.stringify([good, null]),
      JSON.stringify([good, { skill: "z", kind: "k", bundleSha256: 5 }]),
    ];
    for (const raw of bad) {
      assert.deepEqual(await approvedJobKinds([guide(FIXTURE)], { [JOB_ALLOWLIST_ENV]: raw }), [], raw);
    }
  });
  it("malformed jobs.json yields nothing", async () => {
    const dir = copyPack();
    for (const content of ["nope", "[]", '{"jobs":{}}', "{}"]) {
      writeFileSync(join(dir, "jobs.json"), content);
      const env = allow([{ skill: "pack-ok", kind: "echo-job", bundleSha256: await bundleSha256(dir) }]);
      assert.deepEqual(await approvedJobKinds([guide(dir)], env), [], content);
    }
    rmSync(join(dir, "jobs.json"));
    const env = allow([{ skill: "pack-ok", kind: "echo-job", bundleSha256: await bundleSha256(dir) }]);
    assert.deepEqual(await approvedJobKinds([guide(dir)], env), []);
  });
  it("drops declarations that are invalid, keeps the valid ones", async () => {
    const dir = copyPack();
    const ok = { kind: "echo-job", entry: "echo_job.py", inputSchema: {}, readsSource: true, produces: ["facts"] };
    const variants = [
      { ...ok, kind: "b-escape", entry: "../SKILL.md" },
      { ...ok, kind: "b-abs", entry: "/etc/passwd" },
      { ...ok, kind: "b-missing", entry: "missing.py" },
      { ...ok, kind: "b-dotdot", entry: "lib/../echo_job.py" },
      { ...ok, kind: "b-backslash", entry: "lib\\x.py" },
      { ...ok, kind: "Bad_Kind" },
      { ...ok, kind: "b-produces", produces: ["not-a-kind"] },
      { ...ok, kind: "b-zero", timeLimitSec: 0 },
      { ...ok, kind: "b-frac", maxOutputBytes: 1.5 },
      { ...ok, kind: "b-schema", inputSchema: [] },
      { ...ok, kind: "b-reads", readsSource: "yes" },
    ];
    writeFileSync(join(dir, "jobs.json"), JSON.stringify({ jobs: [...variants, ok] }));
    const sha = await bundleSha256(dir);
    const allowed = [...variants, ok].map((j) => ({ skill: "pack-ok", kind: j.kind, bundleSha256: sha }));
    const kinds = await approvedJobKinds([guide(dir)], allow(allowed));
    assert.deepEqual(kinds.map((k) => k.kind), ["echo-job"]);
    assert.equal(kinds[0].readsSource, true);
  });
  it("duplicate kinds in jobs.json deny the skill", async () => {
    const dir = copyPack();
    const ok = { kind: "echo-job", entry: "echo_job.py", inputSchema: {}, readsSource: false, produces: [] };
    writeFileSync(join(dir, "jobs.json"), JSON.stringify({ jobs: [ok, ok] }));
    const sha = await bundleSha256(dir);
    assert.deepEqual(await approvedJobKinds([guide(dir)], allow([{ skill: "pack-ok", kind: "echo-job", bundleSha256: sha }])), []);
  });
});

describe("sealBundle", () => {
  it("copies scripts/ privately and disposes of it (twice is fine)", async () => {
    const dir = copyPack();
    const sha = await bundleSha256(dir);
    const sealed = await sealBundle(dir, sha);
    assert.notEqual(sealed.dir, dir);
    assert.equal(await bundleSha256(sealed.dir), sha);
    assert.equal(readFileSync(join(sealed.dir, "scripts/echo_job.py"), "utf8"), readFileSync(join(dir, "scripts/echo_job.py"), "utf8"));
    await sealed.dispose();
    assert.equal(existsSync(sealed.dir), false);
    await sealed.dispose();
  });
  it("edit helper.py between hash and seal -> bundle_changed and the sealed dir is removed", async () => {
    const dir = copyPack();
    const sha = await bundleSha256(dir);
    writeFileSync(join(dir, "scripts/helper.py"), "def shout(t):\n    return 'pwned'\n");
    const before = readdirSync(tmpdir()).filter((f) => f.startsWith("sportsclaw-bundle-"));
    await assert.rejects(sealBundle(dir, sha), (e) => e instanceof BundleError && e.code === "bundle_changed");
    const after = readdirSync(tmpdir()).filter((f) => f.startsWith("sportsclaw-bundle-"));
    assert.deepEqual(after.sort(), before.sort());
  });
  it("edit jobs.json between hash and seal -> bundle_changed and the sealed dir is removed", async () => {
    const dir = copyPack();
    const sha = await bundleSha256(dir);
    const j = JSON.parse(readFileSync(join(dir, "jobs.json"), "utf8"));
    j.jobs[0].readsSource = true;
    writeFileSync(join(dir, "jobs.json"), JSON.stringify(j));
    const before = readdirSync(tmpdir()).filter((f) => f.startsWith("sportsclaw-bundle-"));
    await assert.rejects(sealBundle(dir, sha), (e) => e instanceof BundleError && e.code === "bundle_changed");
    const after = readdirSync(tmpdir()).filter((f) => f.startsWith("sportsclaw-bundle-"));
    assert.deepEqual(after.sort(), before.sort());
  });
  it("returns the declarations parsed from the sealed copy, equal to the approved ones", async () => {
    const dir = copyPack();
    const sha = await bundleSha256(dir);
    const approved = await approvedJobKinds([guide(dir)], allow([{ skill: "pack-ok", kind: "echo-job", bundleSha256: sha }]));
    const sealed = await sealBundle(dir, sha, "pack-ok");
    try {
      assert.deepEqual(sealed.decls, approved);
      assert.equal(existsSync(join(sealed.dir, "scripts", sealed.decls[0].entry)), true);
    } finally {
      await sealed.dispose();
    }
  });
  it("refuses a symlink and leaves no copy behind", async () => {
    const dir = copyPack();
    const sha = await bundleSha256(dir);
    symlinkSync("/etc/hosts", join(dir, "scripts/link.py"));
    const before = readdirSync(tmpdir()).filter((f) => f.startsWith("sportsclaw-bundle-"));
    await assert.rejects(sealBundle(dir, sha), (e) => e instanceof BundleError && e.code === "bundle_symlink");
    const after = readdirSync(tmpdir()).filter((f) => f.startsWith("sportsclaw-bundle-"));
    assert.deepEqual(after.sort(), before.sort());
  });
});
