/**
 * Prep jobs — job kinds declared `"prep": true` (clock maps, event indexes, subject tracks and identities:
 * the per-game work that takes minutes to an hour). They run here, on the engine, not on the run that
 * started them:
 *
 *   - One LocalJobRunner and one role proxy for all prep jobs, both created on the first prep job from the
 *     engine's media and inference config, and closed by close() (the engine's closeMedia()).
 *   - A run ending does not cancel them. On success every artifact they make is registered as shared for
 *     the source, so a later run that opens the same file finds it.
 *   - A later run on the same engine can read them by jobId (media_job_status, media_job_cancel).
 *   - At most MAX_PREP_JOBS run at once; the next start is refused with `prep_busy`.
 *   - Each job gets its own role-proxy token, revoked when the job ends. Its receipts go to the run that started it while that run is
 *     live (`sink.ended` false), and to this object's list after it ended (drainReceipts()).
 *
 * close() cancels running prep jobs and closes the proxy; their records stay readable. A prep job started
 * after close() gets a new runner and proxy.
 */

import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import type { ModelRoleRouterConfig } from "../inference/model-role-router.js";
import type { ModelRole } from "../inference/model-roles.js";
import type { InferenceReceipt } from "../inference/receipt.js";
import { ArtifactStore } from "./artifacts.js";
import { JobError, LocalJobRunner, type JobRecord, type JobRunner } from "./jobs.js";
import { startRoleProxy, type RoleProxy } from "./role-proxy.js";
import type { MediaConfig } from "./types.js";

export const MAX_PREP_JOBS = 4;

/** Where a prep job's receipts go: the starting run's observer until that run ends. */
export interface PrepSink {
  onReceipt?: (r: InferenceReceipt) => void;
  ended: boolean;
}

interface Live {
  runner: LocalJobRunner;
  proxy?: RoleProxy;
}

export class MediaPrep {
  private live?: Promise<Live>;
  /** jobId -> the runner it runs on (kept after close() so its record stays readable). */
  private readonly jobs = new Map<string, LocalJobRunner>();
  private readonly running = new Set<string>();
  /** Starts past the cap check that have not yet joined `running`. */
  private starting = 0;
  private receipts: InferenceReceipt[] = [];

  constructor(
    private readonly opts: {
      config: MediaConfig;
      inference?: ModelRoleRouterConfig;
      env?: Record<string, string | undefined>;
      /** The operator's Python: the job interpreter when media.interpreters has no default. */
      pythonPath?: string;
    },
  ) {}

  private setup(): Promise<Live> {
    this.live ??= (async () => {
      const { config, inference, pythonPath } = this.opts;
      await fs.mkdir(config.workspaceDir, { recursive: true });
      const workspaceDir = await fs.realpath(config.workspaceDir);
      const interpreters = { ...config.interpreters };
      if (!interpreters.default && pythonPath) interpreters.default = [pythonPath];
      const roles = Object.keys(inference?.roles ?? {}).filter((r) => r !== "brain") as ModelRole[];
      const proxy = inference && roles.length > 0 ? await startRoleProxy({ inference, allowRoles: roles, unref: true }) : undefined;
      const runner = new LocalJobRunner({
        store: new ArtifactStore({ workspaceDir, runId: `prep_${randomBytes(8).toString("hex")}` }),
        // The engine-wide cap is MAX_PREP_JOBS at once; each run counts the prep jobs it starts.
        config: { ...config, workspaceDir, interpreters, maxJobsPerRun: Number.POSITIVE_INFINITY },
        env: this.opts.env ?? process.env,
        shareArtifacts: true,
        ...(proxy ? { roleProxy: { url: proxy.url, token: proxy.token } } : {}),
      });
      return { runner, proxy };
    })();
    return this.live;
  }

  has(jobId: string): boolean {
    return this.jobs.has(jobId);
  }

  async start(req: Parameters<JobRunner["start"]>[0], sink: PrepSink): Promise<JobRecord> {
    for (const id of this.running) {
      if ((await this.jobs.get(id)!.status(id)).state !== "running") this.running.delete(id);
    }
    if (this.running.size + this.starting >= MAX_PREP_JOBS) {
      throw new JobError("prep_busy", `${MAX_PREP_JOBS} prep jobs are running; wait for one to end.`);
    }
    this.starting++;
    try {
      const { runner, proxy } = await this.setup();
      const onReceipt = (r: InferenceReceipt) => {
        if (sink.ended) this.receipts.push({ ...r });
        else sink.onReceipt?.(r);
      };
      const token = proxy?.addToken(onReceipt);
      let rec: JobRecord;
      try {
        rec = await runner.start({ ...req, ...(token ? { roleProxyToken: token } : {}) });
      } catch (err) {
        if (token) proxy?.revokeToken(token);
        throw err;
      }
      this.jobs.set(rec.jobId, runner);
      this.running.add(rec.jobId);
      // Promise reactions are not timers: this does not hold the process, and both branches are handled.
      const release = () => {
        if (token) proxy?.revokeToken(token);
        this.running.delete(rec.jobId);
      };
      void runner.ended(rec.jobId).then(release, release);
      return rec;
    } finally {
      this.starting--;
    }
  }

  status(jobId: string, opts?: { waitSec?: number }): Promise<JobRecord> {
    return this.runnerOf(jobId).status(jobId, opts);
  }

  cancel(jobId: string): Promise<JobRecord> {
    return this.runnerOf(jobId).cancel(jobId);
  }

  /** Receipts of prep jobs whose starting run had ended, oldest first; the list is emptied. */
  drainReceipts(): InferenceReceipt[] {
    const out = this.receipts;
    this.receipts = [];
    return out;
  }

  /** Cancels running prep jobs and closes the role proxy. */
  async close(): Promise<void> {
    const live = this.live;
    this.live = undefined;
    if (!live) return;
    const { runner, proxy } = await live.catch(() => ({ runner: undefined, proxy: undefined }));
    for (const id of this.running) await runner?.cancel(id).catch(() => undefined);
    this.running.clear();
    await proxy?.close();
  }

  private runnerOf(jobId: string): LocalJobRunner {
    const runner = this.jobs.get(jobId);
    if (!runner) throw new JobError("unknown_job", `No prep job ${String(jobId).slice(0, 40)}.`);
    return runner;
  }
}
