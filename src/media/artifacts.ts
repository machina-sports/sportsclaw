/**
 * Artifact store — every media tool validates its inputs through it.
 *
 * Registry layout under `<workspaceDir>/artifacts/`:
 *   <id>.json                      one record per artifact
 *   by-source/<sourceSha256>.json  array of ids of shared artifacts for a source
 */

import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { Artifact, ArtifactKind } from "./types.js";

export type ArtifactErrorCode =
  | "artifact_unknown"
  | "artifact_wrong_kind"
  | "artifact_changed"
  | "artifact_wrong_source"
  | "artifact_wrong_run";

export class ArtifactError extends Error {
  code: ArtifactErrorCode;
  constructor(code: ArtifactErrorCode, message: string) {
    super(message);
    this.name = "ArtifactError";
    this.code = code;
  }
}

interface StoredArtifact {
  artifact: Artifact;
  shared: boolean;
}

const ID_RE = /^art_[0-9a-f]{16}$/;
const SHA_RE = /^[0-9a-f]{64}$/;

function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(path)
      .on("error", reject)
      .on("data", (c) => h.update(c))
      .on("end", () => resolve(h.digest("hex")));
  });
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmp, JSON.stringify(value));
  await rename(tmp, path);
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

/** One write chain per registry directory, shared by every store instance in this process. */
const queues = new Map<string, Promise<unknown>>();

export class ArtifactStore {
  private readonly workspaceDir: string;
  private readonly runId: string;

  constructor(opts: { workspaceDir: string; runId: string }) {
    this.workspaceDir = opts.workspaceDir;
    this.runId = opts.runId;
  }

  private get dir(): string {
    return join(this.workspaceDir, "artifacts");
  }

  /** Serialise registry writes per workspace within this process (index files are read-modify-write). */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const key = resolve(this.dir);
    const prev = queues.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => undefined);
    queues.set(key, tail);
    void tail.then(() => {
      if (queues.get(key) === tail) queues.delete(key);
    });
    return next;
  }

  /** Hashes the file, records it. `shared: true` also files it in the per-source registry. */
  register(input: {
    kind: ArtifactKind;
    path: string;
    sourceSha256?: string;
    facts?: Record<string, unknown>;
    shared?: boolean;
  }): Promise<Artifact> {
    return this.serial(async () => {
      if (input.sourceSha256 !== undefined && !SHA_RE.test(input.sourceSha256)) {
        throw new Error("sourceSha256 must be 64 lowercase hex characters");
      }
      if (input.shared && input.sourceSha256 === undefined) {
        throw new Error("a shared artifact needs a sourceSha256");
      }
      await mkdir(join(this.dir, "by-source"), { recursive: true });
      const wsReal = await realpath(this.workspaceDir);
      let real: string;
      try {
        real = await realpath(input.path);
      } catch {
        throw new Error(`artifact file not found: ${input.path}`);
      }
      if (real !== wsReal && !real.startsWith(wsReal.endsWith(sep) ? wsReal : wsReal + sep)) {
        throw new Error(`artifact path is outside workspace: ${input.path}`);
      }
      const st = await stat(real);
      if (!st.isFile()) throw new Error(`artifact path is not a file: ${input.path}`);

      const artifact: Artifact = {
        id: `art_${randomBytes(8).toString("hex")}`,
        kind: input.kind,
        path: real,
        sha256: await hashFile(real),
        sizeBytes: st.size,
        ...(input.sourceSha256 !== undefined ? { sourceSha256: input.sourceSha256 } : {}),
        runId: this.runId,
        createdAt: new Date().toISOString(),
        ...(input.facts !== undefined ? { facts: input.facts } : {}),
      };
      const shared = input.shared === true;
      await writeJsonAtomic(join(this.dir, `${artifact.id}.json`), { artifact, shared } satisfies StoredArtifact);
      if (shared) {
        const idx = join(this.dir, "by-source", `${artifact.sourceSha256}.json`);
        const ids = (await readJson<string[]>(idx)) ?? [];
        ids.push(artifact.id);
        await writeJsonAtomic(idx, ids);
      }
      return artifact;
    });
  }

  private async load(id: string): Promise<StoredArtifact | undefined> {
    if (!ID_RE.test(id)) return undefined;
    const stored = await readJson<StoredArtifact>(join(this.dir, `${id}.json`));
    if (!stored?.artifact || stored.artifact.id !== id) return undefined;
    return stored;
  }

  /** Throws ArtifactError unless: known, of `kind`, from this run (or shared for the asserted source), and the file still matches its hash. */
  async require(id: string, kind: ArtifactKind, opts?: { sourceSha256?: string }): Promise<Artifact> {
    const stored = await this.load(id);
    if (!stored) throw new ArtifactError("artifact_unknown", `unknown artifact: ${id}`);
    const { artifact, shared } = stored;
    if (artifact.kind !== kind) {
      throw new ArtifactError("artifact_wrong_kind", `artifact ${id} is ${artifact.kind}, expected ${kind}`);
    }
    const otherRun = artifact.runId !== this.runId;
    if (otherRun && !shared) {
      throw new ArtifactError("artifact_wrong_run", `artifact ${id} belongs to another run`);
    }
    // A shared artifact used from another run must be tied to the source the caller asserts.
    const want = opts?.sourceSha256;
    if ((want !== undefined || (otherRun && shared)) && artifact.sourceSha256 !== want) {
      throw new ArtifactError("artifact_wrong_source", `artifact ${id} is not for the requested source`);
    }
    let sha: string;
    try {
      sha = await hashFile(artifact.path);
    } catch {
      throw new ArtifactError("artifact_changed", `artifact file is missing: ${id}`);
    }
    if (sha !== artifact.sha256) {
      throw new ArtifactError("artifact_changed", `artifact file changed since registration: ${id}`);
    }
    return artifact;
  }

  /** Shared artifacts registered for a source, newest first. */
  async forSource(sourceSha256: string, kind?: ArtifactKind): Promise<Artifact[]> {
    if (!SHA_RE.test(sourceSha256)) return [];
    const ids = (await readJson<string[]>(join(this.dir, "by-source", `${sourceSha256}.json`))) ?? [];
    const out: Artifact[] = [];
    for (const id of ids.slice().reverse()) {
      const stored = await this.load(id);
      if (!stored || !stored.shared) continue;
      if (kind !== undefined && stored.artifact.kind !== kind) continue;
      out.push(stored.artifact);
    }
    return out;
  }
}
