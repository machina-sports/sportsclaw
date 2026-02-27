/**
 * sportsclaw — Degen Task Bus (Sprint 2: Async Subagent Coordination)
 *
 * A shared task/state bus for async execution. Enables "programmable degen
 * agents" — conditional notifications like "Ping me if LeBron hits 30pts."
 *
 * Tasks are persisted to ~/.sportsclaw/tasks/ as individual JSON files.
 * A lightweight watcher (cron-driven or polling) can check active tasks
 * and fire notifications when conditions are met.
 *
 * Tools exposed to the LLM:
 *   - create_task(condition, action, context)
 *   - list_active_tasks()
 *   - complete_task(taskId)
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import type { DegenTask } from "./types.js";

// ---------------------------------------------------------------------------
// Task directory
// ---------------------------------------------------------------------------

function getTaskDir(): string {
  const dir = join(homedir(), ".sportsclaw", "tasks");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function getTaskPath(taskId: string): string {
  return join(getTaskDir(), `${taskId}.json`);
}

// ---------------------------------------------------------------------------
// CRUD operations
// ---------------------------------------------------------------------------

/**
 * Create a new task and persist it to disk.
 * Returns the created task with its generated ID.
 */
export function createTask(params: {
  condition: string;
  action: string;
  context: Record<string, unknown>;
  userId: string;
}): DegenTask {
  const task: DegenTask = {
    id: randomUUID().slice(0, 8),
    condition: params.condition,
    action: params.action,
    context: params.context,
    userId: params.userId,
    status: "active",
    createdAt: new Date().toISOString(),
  };

  writeFileSync(getTaskPath(task.id), JSON.stringify(task, null, 2), "utf-8");
  return task;
}

/**
 * List all tasks, optionally filtered by status.
 */
export function listTasks(
  filter?: { status?: DegenTask["status"]; userId?: string }
): DegenTask[] {
  const dir = getTaskDir();
  if (!existsSync(dir)) return [];

  const tasks: DegenTask[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    try {
      const raw = readFileSync(join(dir, file), "utf-8");
      const task = JSON.parse(raw) as DegenTask;
      if (filter?.status && task.status !== filter.status) continue;
      if (filter?.userId && task.userId !== filter.userId) continue;
      tasks.push(task);
    } catch {
      // Skip malformed task files
    }
  }

  // Sort by creation time (newest first)
  return tasks.sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
}

/**
 * Mark a task as completed and persist the change.
 * Returns the updated task, or null if not found.
 */
export function completeTask(taskId: string): DegenTask | null {
  const path = getTaskPath(taskId);
  if (!existsSync(path)) return null;

  try {
    const raw = readFileSync(path, "utf-8");
    const task = JSON.parse(raw) as DegenTask;
    task.status = "completed";
    task.completedAt = new Date().toISOString();
    writeFileSync(path, JSON.stringify(task, null, 2), "utf-8");
    return task;
  } catch {
    return null;
  }
}

/**
 * Delete a task file from disk (for cleanup).
 */
export function deleteTask(taskId: string): boolean {
  const path = getTaskPath(taskId);
  if (!existsSync(path)) return false;
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Expire tasks older than the given age in milliseconds.
 * Default: 24 hours. Returns the number of tasks expired.
 */
export function expireOldTasks(maxAgeMs: number = 24 * 60 * 60 * 1000): number {
  const tasks = listTasks({ status: "active" });
  const now = Date.now();
  let expired = 0;

  for (const task of tasks) {
    const age = now - new Date(task.createdAt).getTime();
    if (age > maxAgeMs) {
      const path = getTaskPath(task.id);
      try {
        const raw = readFileSync(path, "utf-8");
        const t = JSON.parse(raw) as DegenTask;
        t.status = "expired";
        writeFileSync(path, JSON.stringify(t, null, 2), "utf-8");
        expired++;
      } catch {
        // Skip
      }
    }
  }

  return expired;
}
