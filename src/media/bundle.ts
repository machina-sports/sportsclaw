/**
 * Media job kinds — a skill's `scripts/` is approved as one hashed bundle.
 *
 * A job kind runs only if the operator listed (skill, kind, bundleSha256) in
 * SPORTSCLAW_MEDIA_JOB_ALLOWLIST. The hash covers every file under scripts/ AND
 * the skill's jobs.json (entry, limits, produces, schema), so approval never
 * survives an edit to either.
 *
 * Sealed layout: sealBundle copies to <sealed>/scripts/... and <sealed>/jobs.json
 * (the same shape as a skill dir). `entry` resolves as <sealed>/scripts/<entry>,
 * and the runner must use the decls returned by sealBundle, never the live file. The allowlist is parsed as
 * strictly as skill-runtime's script policy: anything malformed denies all.
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { SkillGuide } from "../types.js";
import { ARTIFACT_KINDS, type ArtifactKind } from "./types.js";

export const JOB_ALLOWLIST_ENV = "SPORTSCLAW_MEDIA_JOB_ALLOWLIST";

const KIND_RE = /^[a-z][a-z0-9-]{1,40}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const MAX_JOBS_JSON_BYTES = 256 * 1024;
const MAX_ENTRY_CHARS = 200;

export interface JobKindDecl {
  skill: string;
  kind: string;
  /** Path under scripts/ */
  entry: string;
  inputSchema: Record<string, unknown>;
  readsSource: boolean;
  timeLimitSec?: number;
  maxOutputBytes?: number;
  produces: ArtifactKind[];
}

export class BundleError extends Error {
  constructor(
    public code: "bundle_changed" | "bundle_symlink" | "bundle_invalid",
    message: string,
  ) {
    super(message);
    this.name = "BundleError";
  }
}

/** Regular files under `root` (relative, "/"-separated); throws on any other entry type. */
async function listRegularFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(abs: string, rel: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(abs, { withFileTypes: true });
    } catch {
      throw new BundleError("bundle_invalid", `Cannot read bundle directory "${rel || "."}".`);
    }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(join(abs, e.name), childRel);
      else if (e.isFile()) out.push(childRel);
      else throw new BundleError("bundle_symlink", `"${childRel}" is not a regular file; bundles may not contain links or special files.`);
    }
  }
  const st = await fs.lstat(root).catch(() => undefined);
  if (!st || !st.isDirectory()) throw new BundleError("bundle_invalid", "Bundle has no scripts/ directory.");
  await walk(root, "");
  return out;
}

const JOBS_RECORD_PATH = "/jobs.json"; // reserved: a leading slash cannot occur in a relative path

/** Hash of <root>/scripts/** plus <root>/jobs.json, as the sorted records "<path>\0<file sha256>\n". */
async function hashBundleRoot(root: string): Promise<string> {
  const files = new Map<string, string>(); // record path -> absolute file
  for (const rel of await listRegularFiles(join(root, "scripts"))) files.set(rel, join(root, "scripts", rel));
  const jobs = join(root, "jobs.json");
  const st = await fs.lstat(jobs).catch(() => undefined);
  if (st) {
    if (!st.isFile()) throw new BundleError("bundle_symlink", "jobs.json is not a regular file.");
    files.set(JOBS_RECORD_PATH, jobs);
  }
  const paths = [...files.keys()].map((p) => Buffer.from(p, "utf8"));
  paths.sort(Buffer.compare);
  const h = createHash("sha256");
  for (const pathBuf of paths) {
    const fileSha = createHash("sha256").update(await fs.readFile(files.get(pathBuf.toString("utf8"))!)).digest("hex");
    h.update(Buffer.concat([pathBuf, Buffer.from(`\0${fileSha}\n`)]));
  }
  return h.digest("hex");
}

/** sha256 over the sorted records "<relative path>\0<file sha256>\n" of every regular file under scripts/, plus "/jobs.json". */
export function bundleSha256(skillDir: string): Promise<string> {
  return hashBundleRoot(skillDir);
}

interface AllowEntry {
  skill: string;
  kind: string;
  bundleSha256: string;
}

/** Operator policy. Anything malformed or duplicated denies everything (null). */
function loadJobPolicy(env: Record<string, string | undefined>): AllowEntry[] | null {
  const raw = env[JOB_ALLOWLIST_ENV];
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(value)) return null;
  const seen = new Set<string>();
  for (const entry of value) {
    if (
      !entry ||
      typeof entry !== "object" ||
      Object.keys(entry).sort().join(",") !== "bundleSha256,kind,skill" ||
      typeof entry.skill !== "string" ||
      typeof entry.kind !== "string" ||
      typeof entry.bundleSha256 !== "string" ||
      !SHA_RE.test(entry.bundleSha256)
    ) {
      return null;
    }
    const key = `${entry.skill}\u0000${entry.kind}`;
    if (seen.has(key)) return null;
    seen.add(key);
  }
  return value as AllowEntry[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function optionalPositiveInt(v: unknown): boolean {
  return v === undefined || (typeof v === "number" && Number.isInteger(v) && v > 0);
}

/** An entry is a plain relative path under scripts/ naming an existing regular file. */
async function entryIsInside(skillDir: string, entry: string): Promise<boolean> {
  if (
    !entry ||
    entry.length > MAX_ENTRY_CHARS ||
    /[\u0000-\u001f\\:]/.test(entry) ||
    entry.startsWith("/") ||
    entry.split("/").some((s) => s === "" || s === "." || s === "..")
  ) {
    return false;
  }
  const st = await fs.lstat(join(skillDir, "scripts", entry)).catch(() => undefined);
  return !!st && st.isFile();
}

/** Declarations from jobs.json; undefined if the file is unusable. Invalid single declarations are dropped. */
async function readJobDecls(skill: string, skillDir: string): Promise<JobKindDecl[] | undefined> {
  const file = join(skillDir, "jobs.json");
  const st = await fs.lstat(file).catch(() => undefined);
  if (!st || !st.isFile() || st.size > MAX_JOBS_JSON_BYTES) return undefined;
  let doc: unknown;
  try {
    doc = JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return undefined;
  }
  if (!isPlainObject(doc) || !Array.isArray(doc.jobs)) return undefined;

  const kinds = new Set<string>();
  const out: JobKindDecl[] = [];
  for (const j of doc.jobs) {
    if (!isPlainObject(j) || typeof j.kind !== "string") return undefined;
    if (kinds.has(j.kind)) return undefined; // ambiguous declarations deny the skill
    kinds.add(j.kind);
    if (
      !KIND_RE.test(j.kind) ||
      typeof j.entry !== "string" ||
      !isPlainObject(j.inputSchema) ||
      typeof j.readsSource !== "boolean" ||
      !optionalPositiveInt(j.timeLimitSec) ||
      !optionalPositiveInt(j.maxOutputBytes) ||
      !Array.isArray(j.produces) ||
      !j.produces.every((p) => typeof p === "string" && (ARTIFACT_KINDS as readonly string[]).includes(p)) ||
      !(await entryIsInside(skillDir, j.entry))
    ) {
      continue;
    }
    const decl: JobKindDecl = {
      skill,
      kind: j.kind,
      entry: j.entry,
      inputSchema: j.inputSchema,
      readsSource: j.readsSource,
      produces: j.produces as ArtifactKind[],
    };
    if (j.timeLimitSec !== undefined) decl.timeLimitSec = j.timeLimitSec as number;
    if (j.maxOutputBytes !== undefined) decl.maxOutputBytes = j.maxOutputBytes as number;
    out.push(decl);
  }
  return out;
}

/** One skill's approved kinds with the bundle hash they were approved under (what a runner needs to start them). */
export interface ApprovedBundle {
  skill: string;
  skillDir: string;
  bundleSha256: string;
  decls: JobKindDecl[];
}

/** Per skill: kinds from jobs.json whose (skill, kind, bundleSha256) is in the allowlist. Skills with none are left out. */
export async function approvedJobBundles(
  guides: ReadonlyArray<SkillGuide>,
  env: Record<string, string | undefined> = process.env,
): Promise<ApprovedBundle[]> {
  const policy = loadJobPolicy(env);
  if (!policy) return [];
  const result: ApprovedBundle[] = [];
  for (const guide of guides) {
    if (!guide.dir || !policy.some((p) => p.skill === guide.id)) continue;
    const decls = await readJobDecls(guide.id, guide.dir);
    if (!decls?.length) continue;
    let sha: string;
    try {
      sha = await bundleSha256(guide.dir);
    } catch {
      continue;
    }
    const approved = decls.filter((d) => policy.some((p) => p.skill === d.skill && p.kind === d.kind && p.bundleSha256 === sha));
    if (approved.length) result.push({ skill: guide.id, skillDir: guide.dir, bundleSha256: sha, decls: approved });
  }
  return result;
}

/** Kinds from <skill>/jobs.json whose (skill, kind, bundleSha256) is in the allowlist. Malformed allowlist or jobs.json -> []. */
export async function approvedJobKinds(
  guides: ReadonlyArray<SkillGuide>,
  env: Record<string, string | undefined> = process.env,
): Promise<JobKindDecl[]> {
  return (await approvedJobBundles(guides, env)).flatMap((b) => b.decls);
}

/**
 * Copies scripts/ and jobs.json to a fresh private temp dir (same layout as a skill dir), re-hashes the copy,
 * and throws BundleError("bundle_changed") unless it equals `expected`. Returns the declarations parsed from
 * the sealed copy. `skill` defaults to the skill dir's name (the guide id).
 */
export async function sealBundle(
  skillDir: string,
  expected: string,
  skill: string = basename(skillDir),
): Promise<{ dir: string; decls: JobKindDecl[]; dispose(): Promise<void> }> {
  const dir = await fs.mkdtemp(join(tmpdir(), "sportsclaw-bundle-"));
  const dispose = () => fs.rm(dir, { recursive: true, force: true });
  let decls: JobKindDecl[];
  try {
    await fs.chmod(dir, 0o700);
    const src = join(skillDir, "scripts");
    for (const rel of await listRegularFiles(src)) {
      const to = join(dir, "scripts", rel);
      await fs.mkdir(dirname(to), { recursive: true, mode: 0o700 });
      await fs.writeFile(to, await fs.readFile(join(src, rel)), { mode: 0o600 });
    }
    const jst = await fs.lstat(join(skillDir, "jobs.json")).catch(() => undefined);
    if (jst) {
      if (!jst.isFile()) throw new BundleError("bundle_symlink", "jobs.json is not a regular file.");
      await fs.writeFile(join(dir, "jobs.json"), await fs.readFile(join(skillDir, "jobs.json")), { mode: 0o600 });
    }
    if ((await hashBundleRoot(dir)) !== expected) {
      throw new BundleError("bundle_changed", "The skill's scripts or jobs.json changed since they were approved.");
    }
    const parsed = await readJobDecls(skill, dir);
    if (!parsed) throw new BundleError("bundle_invalid", "jobs.json is missing or malformed.");
    decls = parsed;
  } catch (err) {
    await dispose();
    throw err;
  }
  return { dir, decls, dispose };
}
