/**
 * Local job runner — runs operator-approved media job kinds on this machine.
 *
 * Job contract:
 *   - The skill's bundle is sealed (copied and re-hashed) per job; the declaration, entry, limits, schema and
 *     `produces` all come from the sealed copy, never from the caller or the live skill dir.
 *   - Command: `<interpreter argv> <sealed dir>/scripts/<entry> --input <input.json> --out <out dir>`, cwd the
 *     sealed dir, own process group, environment = PASSTHROUGH_ENV (skill-runtime) plus
 *     SPORTSCLAW_ROLE_PROXY_URL / SPORTSCLAW_ROLE_PROXY_TOKEN when a role proxy is configured. Nothing else.
 *     The interpreter is `config.interpreters["<skill>/<kind>"] ?? config.interpreters.default ?? ["python3"]`.
 *   - input.json is `{ "input": <validated input>, "source"?: { "path", "sha256" }, "artifacts": { "<id>":
 *     { "kind", "path", "sha256" } } }` (source only for `readsSource` kinds; artifacts is the map the caller
 *     resolved and checked against the store, `{}` when none — the runner checks only its shape). Before the
 *     rights check the runner binds the source: its realpath must be a regular
 *     file inside the workspace (`source_outside`) whose sha256 is the given one (`source_mismatch`); input.json
 *     carries that realpath. Files: `<workspaceDir>/jobs/<jobId>/input.json` and `.../out/` (0700).
 *   - Limits: `timeLimitSec` (default 600) and `maxOutputBytes` (default DEFAULT_MAX_JOB_OUTPUT_BYTES), the total
 *     size of files under out/, checked every 250 ms and at exit. Over a limit, or on cancel, the whole process
 *     group is killed.
 *   - On exit 0 the job must have written `<out dir>/manifest.json` (max 1 MiB):
 *     `{ "artifacts": [{ "kind", "file", "facts"?, "shared"? }], "facts": {} }`. Each `file` must be a relative
 *     path to a regular file (not a symlink) inside the out dir after realpath, and each `kind` must be in the
 *     sealed declaration's `produces`. Every entry is validated before any is registered. A runner built with
 *     `shareArtifacts` (prep jobs) registers every artifact as shared for the source.
 *   - `roleProxyToken` on start gives that job its own role-proxy token instead of the runner's.
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { DEFAULT_MAX_JOB_OUTPUT_BYTES } from "../highlights/run.js";
import type { HighlightsJobState, RightsAuthorization } from "../highlights/types.js";
import { PASSTHROUGH_ENV } from "../skill-runtime.js";
import { hashFile, type ArtifactStore } from "./artifacts.js";
import { BundleError, sealBundle, type JobKindDecl } from "./bundle.js";
import { RIGHTS_OFF_NOTE, resolveRightsCheck } from "./rights.js";
import { ARTIFACT_KINDS, type Artifact, type ArtifactKind, type MediaConfig } from "./types.js";

const DEFAULT_TIME_LIMIT_SEC = 600;
export const DEFAULT_MAX_JOBS_PER_RUN = 12;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_STDERR_CHARS = 4000;
const BUDGET_CHECK_MS = 250;
const SHA_RE = /^[0-9a-f]{64}$/;

export interface JobRecord {
  jobId: string;
  skill: string;
  kind: string;
  state: HighlightsJobState;
  startedAt: string;
  endedAt?: string;
  error?: string;
  artifacts: Artifact[];
  facts: Record<string, unknown>;
  rightsCheck?: "off (operator)";
  /** The authorization the source was read under (rightsCheck "require" and a source-reading kind). */
  rights?: { rightsHolder: string; licenseRef: string; territories?: string[] };
}

/** One entry of input.json's `artifacts` map. */
export interface JobArtifactRef {
  kind: ArtifactKind;
  path: string;
  sha256: string;
}

const ARTIFACT_ID_RE = /^art_[0-9a-f]{16}$/;

function isArtifactMap(v: unknown): v is Record<string, JobArtifactRef> {
  if (!isPlainObject(v)) return false;
  return Object.entries(v).every(
    ([id, a]) =>
      ARTIFACT_ID_RE.test(id) &&
      isPlainObject(a) &&
      Object.keys(a).sort().join(",") === "kind,path,sha256" &&
      (ARTIFACT_KINDS as readonly unknown[]).includes(a.kind) &&
      typeof a.path === "string" && isAbsolute(a.path) &&
      typeof a.sha256 === "string" && SHA_RE.test(a.sha256),
  );
}

export interface JobRunner {
  start(req: {
    decl: JobKindDecl;
    skillDir: string;
    bundleSha256: string;
    input: unknown;
    source?: { path: string; sha256: string; rights?: RightsAuthorization };
    /** Artifacts handed to the job, already checked by the caller (ArtifactStore.require). */
    artifacts?: Record<string, JobArtifactRef>;
    /** A role-proxy token for this job only, instead of the runner's (prep jobs: receipts per job). */
    roleProxyToken?: string;
  }): Promise<JobRecord>;
  status(jobId: string, opts?: { waitSec?: number }): Promise<JobRecord>;
  cancel(jobId: string): Promise<JobRecord>;
}

/** Refusals thrown by `start` (nothing ran) and by `status`/`cancel` for unknown ids. */
export class JobError extends Error {
  constructor(
    public code:
      | "unsupported_platform"
      | "job_budget"
      | "unknown_kind"
      | "bundle_changed"
      | "bundle_symlink"
      | "bundle_invalid"
      | "invalid_entry"
      | "invalid_interpreter"
      | "invalid_input"
      | "source_required"
      | "source_outside"
      | "source_mismatch"
      | "rights_required"
      | "prep_busy"
      | "unknown_job",
    message: string,
  ) {
    super(message);
    this.name = "JobError";
  }
}

interface LiveJob {
  record: JobRecord;
  done: Promise<void>;
  cancel(): void;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function typeMatches(type: unknown, v: unknown): boolean {
  switch (type) {
    case "string": return typeof v === "string";
    case "number": return typeof v === "number" && Number.isFinite(v);
    case "integer": return typeof v === "number" && Number.isInteger(v);
    case "boolean": return typeof v === "boolean";
    case "array": return Array.isArray(v);
    case "object": return isPlainObject(v);
    default: return true; // no (or unsupported) type constraint
  }
}

/** The JSON-Schema subset jobs.json may rely on: type, required, properties[].type, additionalProperties:false. */
function inputErrors(schema: Record<string, unknown>, input: unknown): string | undefined {
  if (!typeMatches(schema.type ?? "object", input) || !isPlainObject(input)) return "input must be an object";
  const props = isPlainObject(schema.properties) ? schema.properties : {};
  if (Array.isArray(schema.required)) {
    for (const key of schema.required) if (typeof key === "string" && !Object.hasOwn(input, key)) return `"${key}" is required`;
  }
  for (const [key, value] of Object.entries(input)) {
    const prop = props[key];
    if (prop === undefined) {
      if (schema.additionalProperties === false) return `"${key}" is not allowed`;
    } else if (isPlainObject(prop) && !typeMatches(prop.type, value)) {
      return `"${key}" must be of type ${String(prop.type)}`;
    }
  }
  return undefined;
}

/** A rights block that clears the source for clipping (also used by the plain renderer). */
export function rightsCleared(r: RightsAuthorization | undefined): boolean {
  return (
    isPlainObject(r) &&
    r.clearedForClipping === true &&
    typeof r.rightsHolder === "string" && r.rightsHolder.trim() !== "" &&
    typeof r.licenseRef === "string" && r.licenseRef.trim() !== ""
  );
}

/** Total size of the files under `dir` (links counted as themselves, never followed). */
async function treeBytes(dir: string): Promise<number> {
  let total = 0;
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) total += await treeBytes(p);
    else total += (await fs.lstat(p).catch(() => undefined))?.size ?? 0;
  }
  return total;
}

type Intake =
  | { ok: true; facts: Record<string, unknown>; items: { kind: ArtifactKind; path: string; facts?: Record<string, unknown>; shared?: boolean }[] }
  | { ok: false; code: string; message: string };

/** Reads and validates out/manifest.json in full; registers nothing. */
async function readManifest(outDir: string, decl: JobKindDecl, hasSource: boolean): Promise<Intake> {
  const bad = (code: string, message: string): Intake => ({ ok: false, code, message });
  const file = join(outDir, "manifest.json");
  const st = await fs.lstat(file).catch(() => undefined);
  if (!st || !st.isFile()) return bad("manifest_invalid", "the job wrote no manifest.json");
  if (st.size > MAX_MANIFEST_BYTES) return bad("manifest_invalid", "manifest.json is larger than 1 MiB");
  let doc: unknown;
  try {
    doc = JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return bad("manifest_invalid", "manifest.json is not valid JSON");
  }
  if (!isPlainObject(doc) || !Array.isArray(doc.artifacts) || (doc.facts !== undefined && !isPlainObject(doc.facts))) {
    return bad("manifest_invalid", "manifest.json must be { artifacts: [], facts?: {} }");
  }
  const realOut = await fs.realpath(outDir);
  const items: Extract<Intake, { ok: true }>["items"] = [];
  for (const a of doc.artifacts) {
    if (
      !isPlainObject(a) ||
      typeof a.kind !== "string" ||
      typeof a.file !== "string" ||
      (a.facts !== undefined && !isPlainObject(a.facts)) ||
      (a.shared !== undefined && typeof a.shared !== "boolean")
    ) {
      return bad("manifest_invalid", "each artifact must be { kind, file, facts?, shared? }");
    }
    const shown = JSON.stringify(a.file.slice(0, 200));
    if (a.file === "" || isAbsolute(a.file)) return bad("artifact_path", `${shown} is not a relative path`);
    const abs = resolve(outDir, a.file);
    const lst = await fs.lstat(abs).catch(() => undefined);
    if (!lst || !lst.isFile()) return bad("artifact_path", `${shown} is not a regular file`);
    const real = await fs.realpath(abs).catch(() => "");
    if (!real.startsWith(realOut + sep)) return bad("artifact_path", `${shown} is outside the job's out dir`);
    if (!(decl.produces as string[]).includes(a.kind)) {
      return bad("artifact_kind", `kind "${a.kind.slice(0, 50)}" is not in this job kind's produces`);
    }
    if (a.shared && !hasSource) return bad("manifest_invalid", "a shared artifact needs a source");
    items.push({
      kind: a.kind as ArtifactKind,
      path: real,
      ...(a.facts !== undefined ? { facts: a.facts } : {}),
      ...(a.shared !== undefined ? { shared: a.shared } : {}),
    });
  }
  return { ok: true, facts: (doc.facts as Record<string, unknown> | undefined) ?? {}, items };
}

/** Ties the caller's source path to its sha256: returns the realpath of a regular file inside the workspace. */
async function bindSource(workspaceDir: string, path: string, sha256: string): Promise<string> {
  const realWs = await fs.realpath(workspaceDir).catch(() => undefined);
  const real = await fs.realpath(path).catch(() => undefined);
  if (!realWs || !real || !real.startsWith(realWs + sep)) {
    throw new JobError("source_outside", "The source must be a file inside the workspace.");
  }
  const st = await fs.lstat(real).catch(() => undefined);
  if (!st || !st.isFile() || (await hashFile(real).catch(() => "")) !== sha256) {
    throw new JobError("source_mismatch", "The source file is not a regular file with the given sha256.");
  }
  return real;
}

export class LocalJobRunner implements JobRunner {
  private readonly store: ArtifactStore;
  private readonly config: MediaConfig;
  private readonly env: Record<string, string | undefined>;
  private readonly roleProxy?: { url: string; token: string };
  private readonly shareArtifacts: boolean;
  private readonly jobs = new Map<string, LiveJob>();
  private started = 0;

  constructor(opts: {
    store: ArtifactStore;
    config: MediaConfig;
    env?: Record<string, string | undefined>;
    roleProxy?: { url: string; token: string };
    /** Register every artifact a job makes as shared for its source (prep jobs). */
    shareArtifacts?: boolean;
  }) {
    this.store = opts.store;
    this.config = opts.config;
    this.env = opts.env ?? process.env;
    this.roleProxy = opts.roleProxy;
    this.shareArtifacts = opts.shareArtifacts === true;
  }

  async start(req: Parameters<JobRunner["start"]>[0]): Promise<JobRecord> {
    if (process.platform === "win32") {
      throw new JobError("unsupported_platform", "Media jobs require POSIX process-group cleanup (Linux/macOS).");
    }
    const maxJobs = this.config.maxJobsPerRun ?? DEFAULT_MAX_JOBS_PER_RUN;
    if (this.started >= maxJobs) throw new JobError("job_budget", `This run already started its ${maxJobs} jobs.`);

    let sealed: Awaited<ReturnType<typeof sealBundle>>;
    try {
      sealed = await sealBundle(req.skillDir, req.bundleSha256, req.decl.skill);
    } catch (err) {
      if (err instanceof BundleError) throw new JobError(err.code, err.message);
      throw err;
    }
    try {
      return await this.launch(req, sealed);
    } catch (err) {
      await sealed.dispose();
      throw err;
    }
  }

  private async launch(
    req: Parameters<JobRunner["start"]>[0],
    sealed: Awaited<ReturnType<typeof sealBundle>>,
  ): Promise<JobRecord> {
    const decl = sealed.decls.find((d) => d.kind === req.decl.kind);
    if (!decl) throw new JobError("unknown_kind", `Skill "${req.decl.skill}" declares no job kind "${req.decl.kind}".`);
    if (!isDeepStrictEqual(decl, req.decl)) {
      throw new JobError("bundle_changed", "The job kind's declaration differs from the approved bundle.");
    }
    if (decl.entry.startsWith("-")) throw new JobError("invalid_entry", "A job entry may not start with '-'.");

    const interpreters = this.config.interpreters;
    const interp = interpreters?.[`${decl.skill}/${decl.kind}`] ?? interpreters?.default ?? ["python3"];
    if (!Array.isArray(interp) || interp.length === 0 || !interp.every((s) => typeof s === "string" && s !== "")) {
      throw new JobError("invalid_interpreter", `The interpreter configured for ${decl.skill}/${decl.kind} is not a list of strings.`);
    }

    const problem = inputErrors(decl.inputSchema, req.input);
    if (problem) throw new JobError("invalid_input", `Input does not match the job's inputSchema: ${problem}.`);
    const artifacts = req.artifacts ?? {};
    if (!isArtifactMap(artifacts)) throw new JobError("invalid_input", "artifacts must map artifact ids to { kind, path, sha256 }.");
    const inputJson: Record<string, unknown> = { input: req.input };

    let rightsOff = false;
    let rightsUsed: JobRecord["rights"];
    let sourcePath: string;
    if (decl.readsSource) {
      const src = req.source;
      if (!src || typeof src.path !== "string" || typeof src.sha256 !== "string" || !SHA_RE.test(src.sha256)) {
        throw new JobError("source_required", "This job kind reads the source; give { path, sha256 }.");
      }
      sourcePath = await bindSource(this.config.workspaceDir, src.path, src.sha256);
      if (resolveRightsCheck(this.config, this.env) === "off") rightsOff = true;
      else if (!rightsCleared(src.rights)) {
        throw new JobError("rights_required", "This job kind reads the source; a rights block with clearedForClipping: true is required.");
      } else {
        const r = src.rights!;
        rightsUsed = { rightsHolder: r.rightsHolder, licenseRef: r.licenseRef, ...(r.territories ? { territories: [...r.territories] } : {}) };
      }
      inputJson.source = { path: sourcePath, sha256: src.sha256 };
    }
    inputJson.artifacts = artifacts;
    const inputText = JSON.stringify(inputJson);
    if (Buffer.byteLength(inputText) > MAX_INPUT_BYTES) throw new JobError("invalid_input", "Input is larger than 1 MiB.");
    const sourceSha256 = decl.readsSource ? req.source!.sha256 : undefined;

    const jobId = `job_${randomBytes(8).toString("hex")}`;
    const jobDir = join(this.config.workspaceDir, "jobs", jobId);
    const outDir = join(jobDir, "out");
    const inputFile = join(jobDir, "input.json");
    await fs.mkdir(outDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(inputFile, inputText, { mode: 0o600 });

    const env: Record<string, string> = {};
    for (const key of PASSTHROUGH_ENV) {
      const value = this.env[key];
      if (value !== undefined) env[key] = value;
    }
    if (this.roleProxy) {
      env.SPORTSCLAW_ROLE_PROXY_URL = this.roleProxy.url;
      env.SPORTSCLAW_ROLE_PROXY_TOKEN = req.roleProxyToken ?? this.roleProxy.token;
    }

    const timeLimitSec = decl.timeLimitSec ?? DEFAULT_TIME_LIMIT_SEC;
    const maxBytes = decl.maxOutputBytes ?? DEFAULT_MAX_JOB_OUTPUT_BYTES;
    const record: JobRecord = {
      jobId,
      skill: decl.skill,
      kind: decl.kind,
      state: "running",
      startedAt: new Date().toISOString(),
      artifacts: [],
      facts: {},
      ...(rightsOff ? { rightsCheck: RIGHTS_OFF_NOTE } : {}),
      ...(rightsUsed ? { rights: rightsUsed } : {}),
    };

    this.started++;
    const child = spawn(
      interp[0],
      [...interp.slice(1), join(sealed.dir, "scripts", decl.entry), "--input", inputFile, "--out", outDir],
      { cwd: sealed.dir, env, shell: false, detached: true, stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr!.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-MAX_STDERR_CHARS);
    });

    let stopped: "time" | "output" | "cancel" | undefined;
    const killGroup = () => {
      if (child.pid !== undefined) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
      }
    };
    const stop = (why: "time" | "output" | "cancel") => {
      if (stopped) return;
      stopped = why;
      killGroup();
    };
    const timer = setTimeout(() => stop("time"), timeLimitSec * 1000);
    let measuring = false;
    const meter = setInterval(() => {
      if (measuring) return;
      measuring = true;
      void treeBytes(outDir).then((bytes) => {
        measuring = false;
        if (bytes > maxBytes) stop("output");
      });
    }, BUDGET_CHECK_MS);

    const exited = new Promise<{ code: number | null; spawnError?: Error }>((resolveExit) => {
      child.once("error", (err) => resolveExit({ code: null, spawnError: err }));
      child.once("exit", (code) => resolveExit({ code }));
    });

    const fail = (code: string, message: string) => {
      record.state = "failed";
      record.error = `${code}: ${message}`;
    };
    const done = (async () => {
      const { code, spawnError } = await exited;
      clearTimeout(timer);
      clearInterval(meter);
      killGroup(); // reap anything the job left behind in its group
      try {
        if (stopped === "cancel") {
          record.state = "canceled";
          record.error = "canceled";
        } else if (stopped === "time") {
          fail("time_limit", `the job exceeded its time limit of ${timeLimitSec}s and was killed`);
        } else if (stopped === "output" || (code === 0 && (await treeBytes(outDir)) > maxBytes)) {
          fail("output_limit", `the job wrote more than its output limit of ${maxBytes} bytes and was killed`);
        } else if (spawnError) {
          fail("spawn_failed", `could not start the job: ${spawnError.message}`);
        } else if (code !== 0) {
          fail("exit_code", `the job exited with code ${code}${stderr ? `; stderr: ${stderr}` : ""}`);
        } else {
          const intake = await readManifest(outDir, decl, sourceSha256 !== undefined);
          if (!intake.ok) {
            fail(intake.code, intake.message);
          } else {
            const artifacts: Artifact[] = [];
            for (const item of intake.items) {
              artifacts.push(await this.store.register({
                ...item,
                ...(sourceSha256 ? { sourceSha256 } : {}),
                ...(this.shareArtifacts && sourceSha256 ? { shared: true } : {}),
              }));
            }
            record.artifacts = artifacts;
            record.facts = intake.facts;
            record.state = "succeeded";
          }
        }
      } catch (err) {
        fail("intake_failed", err instanceof Error ? err.message : String(err));
      } finally {
        record.endedAt = new Date().toISOString();
        await sealed.dispose().catch(() => undefined);
      }
    })();

    this.jobs.set(jobId, { record, done, cancel: () => stop("cancel") });
    return this.snapshot(record);
  }

  private snapshot(record: JobRecord): JobRecord {
    return { ...record, artifacts: [...record.artifacts], facts: { ...record.facts }, ...(record.rights ? { rights: { ...record.rights } } : {}) };
  }

  private live(jobId: string): LiveJob {
    const job = this.jobs.get(jobId);
    if (!job) throw new JobError("unknown_job", `No job ${String(jobId).slice(0, 40)} in this run.`);
    return job;
  }

  async status(jobId: string, opts?: { waitSec?: number }): Promise<JobRecord> {
    const job = this.live(jobId);
    const waitMs = Math.max(0, Number(opts?.waitSec) || 0) * 1000;
    if (waitMs > 0 && job.record.state === "running") {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([job.done, new Promise<void>((r) => { timer = setTimeout(r, waitMs); })]);
      clearTimeout(timer);
    }
    return this.snapshot(job.record);
  }

  /** Resolves when the job's `done` settles (any end state). Not on `JobRunner`: only local callers need it. */
  async ended(jobId: string): Promise<void> {
    await this.live(jobId).done;
  }

  async cancel(jobId: string): Promise<JobRecord> {
    const job = this.live(jobId);
    if (job.record.state === "running") {
      job.cancel();
      await job.done;
    }
    return this.snapshot(job.record);
  }
}
