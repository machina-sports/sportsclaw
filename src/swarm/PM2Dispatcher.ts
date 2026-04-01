/**
 * sportsclaw — Swarm Dispatch: PM2 Worker Manager
 *
 * Implements IWorkerDispatcher using PM2 as the process supervisor.
 * Each worker runs as a named PM2 process: `sc-swarm-<name>`.
 *
 * Worker specs are persisted to swarm storage so restarts can
 * re-hydrate the spec without the caller holding state. This is
 * the bridge between the swarm orchestrator and local process
 * management — production deployments swap this for K8sDispatcher.
 */

import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type {
  IWorkerDispatcher,
  ISwarmStorage,
  WorkerSpec,
  WorkerStatus,
  WorkerRunState,
} from "./interfaces.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PM2_PREFIX = "sc-swarm-";
const WORKER_NAMESPACE = "workers";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Prefixed PM2 process name. */
function pm2Name(workerName: string): string {
  return `${PM2_PREFIX}${workerName}`;
}

/** Resolve the compiled entry point (dist/index.js). */
function entryPoint(): string {
  return fileURLToPath(new URL("../../dist/index.js", import.meta.url));
}

/** Verify PM2 is installed. Throws with install guidance if missing. */
function requirePm2(): void {
  try {
    execSync("which pm2", { stdio: "ignore" });
  } catch {
    throw new Error(
      "PM2 is required for swarm worker dispatch. " +
      "Install via: npm install -g pm2",
    );
  }
}

/** Run a PM2 command and return stdout. */
function pm2Exec(args: string, quiet = false): string {
  try {
    return execSync(`pm2 ${args}`, {
      encoding: "utf-8",
      stdio: quiet ? ["ignore", "pipe", "ignore"] : ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (err: unknown) {
    if (!quiet) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[PM2Dispatcher] pm2 error: ${msg}`);
    }
    return "";
  }
}

/** Parse PM2 jlist output into a typed array. */
interface PM2ProcessInfo {
  name: string;
  pid: number;
  pm2_env?: {
    status?: string;
    pm_uptime?: number;
    restart_time?: number;
    env?: Record<string, string>;
  };
  monit?: {
    memory?: number;
    cpu?: number;
  };
}

function pm2ListAll(): PM2ProcessInfo[] {
  const raw = pm2Exec("jlist", true);
  if (!raw) return [];

  try {
    return JSON.parse(raw) as PM2ProcessInfo[];
  } catch {
    return [];
  }
}

/** Convert PM2 status string to WorkerRunState. */
function toRunState(pm2Status?: string): WorkerRunState {
  switch (pm2Status) {
    case "online": return "online";
    case "stopping": return "stopping";
    case "stopped": return "stopped";
    case "errored": return "errored";
    default: return "unknown";
  }
}

/** Build WorkerStatus from a PM2 process info entry. */
function toWorkerStatus(proc: PM2ProcessInfo): WorkerStatus {
  const state = toRunState(proc.pm2_env?.status);
  const uptime = proc.pm2_env?.pm_uptime
    ? Date.now() - proc.pm2_env.pm_uptime
    : null;

  return {
    name: proc.name.replace(PM2_PREFIX, ""),
    state,
    pid: state === "online" ? proc.pid : null,
    memoryBytes: proc.monit?.memory ?? null,
    uptimeMs: state === "online" ? uptime : null,
    restarts: proc.pm2_env?.restart_time ?? 0,
    checkedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// PM2Dispatcher
// ---------------------------------------------------------------------------

export class PM2Dispatcher implements IWorkerDispatcher {
  private readonly storage: ISwarmStorage;

  constructor(storage: ISwarmStorage) {
    this.storage = storage;
  }

  // -------------------------------------------------------------------------
  // IWorkerDispatcher — spawn
  // -------------------------------------------------------------------------

  async spawn(spec: WorkerSpec): Promise<WorkerStatus> {
    requirePm2();

    const name = pm2Name(spec.name);
    const entry = entryPoint();

    // Guard against duplicate
    const existing = this.findProcess(name);
    if (existing && toRunState(existing.pm2_env?.status) === "online") {
      throw new Error(
        `Worker "${spec.name}" is already running (PID ${existing.pid}). ` +
        `Stop it first or use restart().`,
      );
    }

    // Persist spec to storage for re-hydration
    await this.storage.put(WORKER_NAMESPACE, spec.name, spec, {
      labels: spec.labels ?? {},
    });

    // Build PM2 start command
    const parts = [
      `start ${entry}`,
      `--name ${name}`,
    ];

    if (spec.autorestart === false) {
      parts.push("--no-autorestart");
    }

    if (spec.maxMemoryMb) {
      parts.push(`--max-memory-restart ${spec.maxMemoryMb}M`);
    }

    // Forward env vars
    if (spec.env && Object.keys(spec.env).length > 0) {
      const envPairs = Object.entries(spec.env)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ");
      // PM2 env injection via --env doesn't exist; use node_args workaround
      // Set env via the -- separator and let the child read process.env
      parts.push(`--node-args=""`); // placeholder for future node flags
    }

    // Append the sportsclaw command after --
    const cmdArgs = spec.args ? ` ${spec.args.join(" ")}` : "";
    parts.push(`-- ${spec.command}${cmdArgs}`);

    const pm2Cmd = parts.join(" ");

    try {
      execSync(`pm2 ${pm2Cmd}`, {
        stdio: "pipe",
        env: { ...process.env, ...spec.env },
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to spawn worker "${spec.name}": ${msg}`);
    }

    // Brief delay for PM2 to register the process
    await new Promise((r) => setTimeout(r, 500));

    return this.statusOrThrow(spec.name);
  }

  // -------------------------------------------------------------------------
  // IWorkerDispatcher — stop
  // -------------------------------------------------------------------------

  async stop(name: string): Promise<WorkerStatus> {
    requirePm2();

    const pm2 = pm2Name(name);
    const proc = this.findProcess(pm2);
    if (!proc) {
      throw new Error(`Worker "${name}" not found in PM2 process list.`);
    }

    try {
      execSync(`pm2 stop ${pm2}`, { stdio: "pipe" });
      execSync(`pm2 delete ${pm2}`, { stdio: "ignore" });
    } catch {
      // Already stopped — acceptable
    }

    return {
      name,
      state: "stopped",
      pid: null,
      memoryBytes: null,
      uptimeMs: null,
      restarts: proc.pm2_env?.restart_time ?? 0,
      checkedAt: new Date().toISOString(),
    };
  }

  // -------------------------------------------------------------------------
  // IWorkerDispatcher — restart
  // -------------------------------------------------------------------------

  async restart(name: string): Promise<WorkerStatus> {
    requirePm2();

    // Load persisted spec
    const doc = await this.storage.get<WorkerSpec>(WORKER_NAMESPACE, name);
    if (!doc) {
      // Fallback: try PM2 restart directly
      const pm2 = pm2Name(name);
      const proc = this.findProcess(pm2);
      if (!proc) {
        throw new Error(
          `Worker "${name}" not found. No persisted spec or PM2 process.`,
        );
      }

      try {
        execSync(`pm2 restart ${pm2}`, { stdio: "pipe" });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to restart worker "${name}": ${msg}`);
      }

      await new Promise((r) => setTimeout(r, 500));
      return this.statusOrThrow(name);
    }

    // Full stop + re-spawn from spec
    try {
      await this.stop(name);
    } catch {
      // Might not be running — that's fine
    }

    return this.spawn(doc.data);
  }

  // -------------------------------------------------------------------------
  // IWorkerDispatcher — status
  // -------------------------------------------------------------------------

  async status(name: string): Promise<WorkerStatus | null> {
    requirePm2();

    const proc = this.findProcess(pm2Name(name));
    if (!proc) return null;

    return toWorkerStatus(proc);
  }

  // -------------------------------------------------------------------------
  // IWorkerDispatcher — list
  // -------------------------------------------------------------------------

  async list(labels?: Record<string, string>): Promise<WorkerStatus[]> {
    requirePm2();

    const allProcs = pm2ListAll().filter((p) =>
      p.name.startsWith(PM2_PREFIX),
    );

    if (!labels || Object.keys(labels).length === 0) {
      return allProcs.map(toWorkerStatus);
    }

    // Filter by labels from persisted specs
    const results: WorkerStatus[] = [];

    for (const proc of allProcs) {
      const workerName = proc.name.replace(PM2_PREFIX, "");
      const doc = await this.storage.get<WorkerSpec>(WORKER_NAMESPACE, workerName);

      if (!doc) continue;

      const specLabels = doc.data.labels ?? {};
      const match = Object.entries(labels).every(
        ([k, v]) => specLabels[k] === v,
      );

      if (match) {
        results.push(toWorkerStatus(proc));
      }
    }

    return results;
  }

  // -------------------------------------------------------------------------
  // IWorkerDispatcher — destroyAll
  // -------------------------------------------------------------------------

  async destroyAll(): Promise<void> {
    requirePm2();

    const allProcs = pm2ListAll().filter((p) =>
      p.name.startsWith(PM2_PREFIX),
    );

    for (const proc of allProcs) {
      try {
        execSync(`pm2 stop ${proc.name}`, { stdio: "ignore" });
        execSync(`pm2 delete ${proc.name}`, { stdio: "ignore" });
      } catch {
        // Best-effort cleanup
      }

      const workerName = proc.name.replace(PM2_PREFIX, "");
      await this.storage.delete(WORKER_NAMESPACE, workerName).catch(() => {});
    }
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private findProcess(pm2ProcessName: string): PM2ProcessInfo | undefined {
    return pm2ListAll().find((p) => p.name === pm2ProcessName);
  }

  private async statusOrThrow(name: string): Promise<WorkerStatus> {
    const s = await this.status(name);
    if (!s) {
      throw new Error(
        `Worker "${name}" was spawned but not found in PM2 process list.`,
      );
    }
    return s;
  }
}
