/**
 * sportsclaw — Async Watcher Bus (Sprint 2: Condition-Action Triggers)
 *
 * A shared task/state bus for async execution. Enables "programmable watchers"
 * — conditional notifications like "Ping me if LeBron hits 30pts."
 *
 * Backed by the unified DurableStateStore substrate.
 *
 * Tools exposed to the LLM:
 *   - create_task(condition, action, context)
 *   - list_active_tasks()
 *   - complete_task(taskId)
 */

import { randomUUID } from "node:crypto";
import { DurableStateStore } from "./durability.js";
import type { WatcherTask } from "./types.js";

/** Maximum number of active tasks per user */
export const MAX_TASKS_PER_USER = 10;

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

  const store = DurableStateStore.getInstance();
  await store.save<WatcherTask>("tasks", task.id, task);
  return task;
}

/**
 * List all tasks, optionally filtered by status and/or userId.
 */
export async function listTasks(
  filter?: { status?: WatcherTask["status"]; userId?: string }
): Promise<WatcherTask[]> {
  const store = DurableStateStore.getInstance();
  const rawTasks = await store.list<WatcherTask>("tasks", {
    filter: (task) => {
      if (filter?.status && task.status !== filter.status) return false;
      if (filter?.userId && task.userId !== filter.userId) return false;
      return true;
    }
  });

  const tasks = rawTasks.map((t) => t.data);

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
  const store = DurableStateStore.getInstance();
  const task = await store.load<WatcherTask>("tasks", taskId);
  if (!task) return null;

  task.status = "completed";
  task.completedAt = new Date().toISOString();
  await store.save<WatcherTask>("tasks", taskId, task);
  return task;
}

/**
 * Delete a task file from disk (for cleanup).
 */
export async function deleteTask(taskId: string): Promise<boolean> {
  const store = DurableStateStore.getInstance();
  return store.delete("tasks", taskId);
}

/**
 * Expire tasks older than the given age in milliseconds.
 * Default: 24 hours. Returns the number of tasks expired.
 */
export async function expireOldTasks(maxAgeMs: number = 24 * 60 * 60 * 1000): Promise<number> {
  const tasks = await listTasks({ status: "active" });
  const now = Date.now();
  let expired = 0;

  const store = DurableStateStore.getInstance();
  for (const task of tasks) {
    const age = now - new Date(task.createdAt).getTime();
    if (age > maxAgeMs) {
      task.status = "expired";
      await store.save<WatcherTask>("tasks", task.id, task);
      expired++;
    }
  }

  return expired;
}
