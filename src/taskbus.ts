/**
 * sportsclaw — Async Watcher Bus (Sprint 2: Condition-Action Triggers)
 *
 * A shared task/state bus for async execution. Enables "programmable watchers"
 * — conditional notifications like "Ping me if LeBron hits 30pts."
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

import { existsSync, mkdirSync } from "node:fs";
import { readdir, readFile, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import type { WatcherTask } from "./types.js";

/** Maximum number of active tasks per user */
export const MAX_TASKS_PER_USER = 10;

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
 * Throws if the user already has MAX_TASKS_PER_USER active tasks.
 */
export async function createTask(params: {
  condition: string;
  action: string;
  context: Record<string, unknown>;
  userId: string;
}): Promise<WatcherTask> {
  // Enforce per-user task limit
  const existing = await listTasks({ status: "active", userId: params.userId });
  if (existing.length >= MAX_TASKS_PER_USER) {
    throw new Error(
      `Task limit reached: you already have ${existing.length} active tasks (max ${MAX_TASKS_PER_USER}). ` +
        "Complete or cancel existing tasks before creating new ones."
    );
  }

  const task: WatcherTask = {
    id: randomUUID().slice(0, 8),
    condition: params.condition,
    action: params.action,
    context: params.context,
    userId: params.userId,
    status: "active",
    createdAt: new Date().toISOString(),
  };

  await writeFile(getTaskPath(task.id), JSON.stringify(task, null, 2), "utf-8");
  return task;
}

/**
 * List all tasks, optionally filtered by status and/or userId.
 */
export async function listTasks(
  filter?: { status?: WatcherTask["status"]; userId?: string }
): Promise<WatcherTask[]> {
  const dir = getTaskDir();
  if (!existsSync(dir)) return [];

  const tasks: WatcherTask[] = [];
  for (const file of await readdir(dir)) {
    if (!file.endsWith(".json")) continue;
    try {
      const raw = await readFile(join(dir, file), "utf-8");
      const task = JSON.parse(raw) as WatcherTask;
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
export async function completeTask(taskId: string): Promise<WatcherTask | null> {
  const path = getTaskPath(taskId);
  if (!existsSync(path)) return null;

  try {
    const raw = await readFile(path, "utf-8");
    const task = JSON.parse(raw) as WatcherTask;
    task.status = "completed";
    task.completedAt = new Date().toISOString();
    await writeFile(path, JSON.stringify(task, null, 2), "utf-8");
    return task;
  } catch {
    return null;
  }
}

/**
 * Delete a task file from disk (for cleanup).
 */
export async function deleteTask(taskId: string): Promise<boolean> {
  const path = getTaskPath(taskId);
  if (!existsSync(path)) return false;
  try {
    await unlink(path);
    return true;
  } catch (err) {
    console.error(
      `[sportsclaw] Failed to delete task ${taskId}: ${err instanceof Error ? err.message : String(err)}`
    );
    return false;
  }
}

/**
 * Expire tasks older than the given age in milliseconds.
 * Default: 24 hours. Returns the number of tasks expired.
 */
export async function expireOldTasks(maxAgeMs: number = 24 * 60 * 60 * 1000): Promise<number> {
  const tasks = await listTasks({ status: "active" });
  const now = Date.now();
  let expired = 0;

  for (const task of tasks) {
    const age = now - new Date(task.createdAt).getTime();
    if (age > maxAgeMs) {
      const path = getTaskPath(task.id);
      try {
        const raw = await readFile(path, "utf-8");
        const t = JSON.parse(raw) as WatcherTask;
        t.status = "expired";
        await writeFile(path, JSON.stringify(t, null, 2), "utf-8");
        expired++;
      } catch {
        // Skip
      }
    }
  }

  return expired;
}
