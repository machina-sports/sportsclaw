/**
 * sportsclaw — Swarm Worker: Task Executor
 *
 * Core logic for `sportsclaw worker run <task_id>`.
 *
 * Lifecycle:
 *   1. Load the task document from swarm storage
 *   2. Validate it's in a runnable state (running | assigned)
 *   3. Execute the sportsclaw sub-command captured in the task
 *   4. Write the result back to storage and transition status
 *   5. Exit with code 0 (success) or 1 (failure)
 *
 * The worker process inherits SWARM_TASK_ID and SWARM_TEAM_ID from env,
 * set by worker_spawn. This module can also accept the task ID as an
 * argument for direct CLI invocation.
 */

import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { ISwarmStorage } from "./interfaces.js";
import {
  NS_TASKS,
  NS_RESULTS,
  type SwarmTask,
  type SwarmTaskStatus,
} from "./tools.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max execution time for a single task (10 minutes). */
const TASK_TIMEOUT_MS = 600_000;

// ---------------------------------------------------------------------------
// Result shape written to the results namespace
// ---------------------------------------------------------------------------

export interface TaskResult {
  taskId: string;
  teamId: string;
  workerName: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  completedAt: string;
}

// ---------------------------------------------------------------------------
// Core executor
// ---------------------------------------------------------------------------

/**
 * Run a swarm task to completion.
 *
 * This is the main entry point for `sportsclaw worker run <task_id>`.
 * It loads the task, executes the captured command, and persists results.
 *
 * @returns exit code (0 = success, 1 = failure)
 */
export async function runWorkerTask(
  storage: ISwarmStorage,
  taskId: string,
): Promise<number> {
  const log = (msg: string) =>
    console.log(`[swarm:worker:${taskId}] ${msg}`);

  // ------------------------------------------------------------------
  // 1. Load and validate the task
  // ------------------------------------------------------------------

  const taskDoc = await storage.get<SwarmTask>(NS_TASKS, taskId);
  if (!taskDoc) {
    log(`Task not found: ${taskId}`);
    return 1;
  }

  const task = taskDoc.data;

  if (task.status !== "running" && task.status !== "assigned" && task.status !== "pending") {
    log(`Task is in status "${task.status}" — not runnable.`);
    return 1;
  }

  // Transition to running if not already
  if (task.status !== "running") {
    task.status = "running";
    task.assignedAt = new Date().toISOString();
    task.assignedWorker = process.env.PM2_PROCESS_NAME ?? `worker-${taskId}`;
    await updateTask(storage, taskId, task, "running");
  }

  log(`Executing: ${task.command} ${task.args.join(" ")}`);

  // ------------------------------------------------------------------
  // 2. Execute the sportsclaw sub-command
  // ------------------------------------------------------------------

  const startMs = Date.now();
  const entryPoint = resolveEntry();

  let stdout = "";
  let stderr = "";
  let exitCode = 0;

  try {
    const result = await execCommand(
      process.execPath,
      [entryPoint, ...task.command.split(/\s+/), ...task.args],
      TASK_TIMEOUT_MS,
    );
    stdout = result.stdout;
    stderr = result.stderr;
    exitCode = result.exitCode;
  } catch (err: unknown) {
    stderr = err instanceof Error ? err.message : String(err);
    exitCode = 1;
  }

  const durationMs = Date.now() - startMs;
  const completedAt = new Date().toISOString();

  // ------------------------------------------------------------------
  // 3. Write result document
  // ------------------------------------------------------------------

  const workerName =
    task.assignedWorker ?? process.env.PM2_PROCESS_NAME ?? `worker-${taskId}`;

  const taskResult: TaskResult = {
    taskId,
    teamId: task.teamId,
    workerName,
    exitCode,
    stdout: stdout.slice(0, 10_000), // Cap at 10KB
    stderr: stderr.slice(0, 5_000),  // Cap at 5KB
    durationMs,
    completedAt,
  };

  await storage.put(NS_RESULTS, `${taskId}-result`, taskResult, {
    ttlMs: 86_400_000 * 7, // 7-day retention
    labels: {
      kind: "result",
      team: task.teamId,
      taskId,
      exitCode: String(exitCode),
    },
  });

  // ------------------------------------------------------------------
  // 4. Transition task status
  // ------------------------------------------------------------------

  const finalStatus: SwarmTaskStatus = exitCode === 0 ? "completed" : "failed";
  task.status = finalStatus;
  task.completedAt = completedAt;
  task.resultSummary =
    exitCode === 0
      ? `Completed in ${durationMs}ms`
      : `Failed (exit ${exitCode}): ${stderr.slice(0, 200)}`;

  await updateTask(storage, taskId, task, finalStatus);

  log(
    finalStatus === "completed"
      ? `Done in ${durationMs}ms`
      : `Failed (exit ${exitCode}) in ${durationMs}ms`,
  );

  return exitCode === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve the compiled CLI entry point relative to this file. */
function resolveEntry(): string {
  return fileURLToPath(new URL("../../dist/index.js", import.meta.url));
}

/** Update task document and sync labels. */
async function updateTask(
  storage: ISwarmStorage,
  taskId: string,
  task: SwarmTask,
  status: string,
): Promise<void> {
  await storage.put(NS_TASKS, taskId, task, {
    labels: {
      kind: "task",
      team: task.teamId,
      status,
      priority: String(task.priority),
    },
  });
}

/** Promise wrapper around execFile with timeout. */
function execCommand(
  bin: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      bin,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024 * 5, // 5MB
        env: process.env,
      },
      (error, stdout, stderr) => {
        if (error && !("code" in error)) {
          reject(error);
          return;
        }

        resolve({
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          exitCode:
            error && "code" in error && typeof error.code === "number"
              ? error.code
              : error
                ? 1
                : 0,
        });
      },
    );

    // Ensure the child doesn't hold the parent open
    child.unref?.();
  });
}
