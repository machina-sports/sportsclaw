/**
 * sportsclaw — Swarm Architecture: Phase 3 Tools
 *
 * MCP-compatible tool definitions for swarm orchestration:
 *   - team_create    — Provision a named team with role labels and relay bindings
 *   - task_assign    — Create and assign a task document to a team worker
 *   - worker_spawn   — Dispatch a worker process from a task specification
 *
 * All tools operate through ISwarmStorage and IWorkerDispatcher interfaces,
 * making them backend-agnostic (local file ↔ pod memory, PM2 ↔ k8s).
 *
 * Each tool exposes a static `spec` (MCP-compatible JSON Schema) and an
 * async `execute()` function, so registration into an MCP server is a
 * one-liner per tool.
 */

import { randomUUID } from "node:crypto";
import type {
  ISwarmStorage,
  IWorkerDispatcher,
  SwarmDocument,
  WorkerSpec,
  WorkerStatus,
} from "./interfaces.js";

// ---------------------------------------------------------------------------
// Namespaces — map 1:1 to logical pod document partitions
// ---------------------------------------------------------------------------

export const NS_TEAMS = "teams";
export const NS_TASKS = "tasks";
export const NS_RESULTS = "results";

// ---------------------------------------------------------------------------
// Data shapes stored in swarm documents
// ---------------------------------------------------------------------------

/** A team is a named group of workers with shared configuration. */
export interface SwarmTeam {
  name: string;
  /** Roles this team fulfils (e.g. "watcher", "analyst", "presenter"). */
  roles: string[];
  /** Relay channels this team subscribes to for inbound work. */
  relayBindings: string[];
  /** Default environment variables inherited by all workers in this team. */
  defaultEnv: Record<string, string>;
  /** Maximum concurrent workers allowed for this team. */
  maxWorkers: number;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
}

/** Task status lifecycle: pending → assigned → running → completed | failed. */
export type SwarmTaskStatus =
  | "pending"
  | "assigned"
  | "running"
  | "completed"
  | "failed";

/** A unit of work assigned to a team / worker. */
export interface SwarmTask {
  /** Human-readable task description. */
  description: string;
  /** The sportsclaw sub-command to execute (e.g. "watch nba scores"). */
  command: string;
  /** Extra CLI args for the command. */
  args: string[];
  /** Team this task is assigned to (team document ID). */
  teamId: string;
  /** Worker name handling this task (set on spawn). */
  assignedWorker: string | null;
  /** Current lifecycle status. */
  status: SwarmTaskStatus;
  /** Priority: 0 = highest, 9 = lowest. Default: 5. */
  priority: number;
  /** ISO-8601 timestamp when the task was assigned. */
  assignedAt: string | null;
  /** ISO-8601 timestamp when the task completed or failed. */
  completedAt: string | null;
  /** Result summary or error message (populated on completion). */
  resultSummary: string | null;
}

// ---------------------------------------------------------------------------
// Tool result envelope — uniform shape for all tool responses
// ---------------------------------------------------------------------------

export interface SwarmToolResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

// ---------------------------------------------------------------------------
// Swarm context — injected dependencies for all tool executors
// ---------------------------------------------------------------------------

export interface SwarmToolContext {
  storage: ISwarmStorage;
  dispatcher: IWorkerDispatcher;
}

// ---------------------------------------------------------------------------
// team_create
// ---------------------------------------------------------------------------

export const teamCreateSpec = {
  name: "team_create",
  description:
    "Provision a named swarm team with role labels, relay channel bindings, " +
    "and worker concurrency limits. Teams group workers that share " +
    "configuration and can be targeted for task assignment.",
  inputSchema: {
    type: "object" as const,
    properties: {
      name: {
        type: "string",
        description: "Unique team name (e.g. 'nba-watchers', 'odds-analysts').",
      },
      roles: {
        type: "array",
        items: { type: "string" },
        description:
          "Roles this team fulfils (e.g. ['watcher', 'presenter']).",
      },
      relay_bindings: {
        type: "array",
        items: { type: "string" },
        description:
          "Relay channels to subscribe to (e.g. ['live-games', 'odds']).",
      },
      default_env: {
        type: "object",
        additionalProperties: { type: "string" },
        description:
          "Default environment variables inherited by all workers in this team.",
      },
      max_workers: {
        type: "number",
        description:
          "Maximum concurrent workers for this team. Default: 3.",
      },
    },
    required: ["name", "roles"],
  },
} as const;

export interface TeamCreateParams {
  name: string;
  roles: string[];
  relay_bindings?: string[];
  default_env?: Record<string, string>;
  max_workers?: number;
}

export async function executeTeamCreate(
  ctx: SwarmToolContext,
  params: TeamCreateParams,
): Promise<SwarmToolResult<SwarmDocument<SwarmTeam>>> {
  // Guard: no duplicate team names
  const existing = await ctx.storage.get<SwarmTeam>(NS_TEAMS, params.name);
  if (existing) {
    return {
      ok: false,
      error: `Team "${params.name}" already exists. Delete it first or choose a different name.`,
    };
  }

  const team: SwarmTeam = {
    name: params.name,
    roles: params.roles,
    relayBindings: params.relay_bindings ?? [],
    defaultEnv: params.default_env ?? {},
    maxWorkers: params.max_workers ?? 3,
    createdAt: new Date().toISOString(),
  };

  const doc = await ctx.storage.put<SwarmTeam>(NS_TEAMS, params.name, team, {
    labels: {
      kind: "team",
      ...Object.fromEntries(params.roles.map((r) => [`role:${r}`, "true"])),
    },
  });

  return { ok: true, data: doc };
}

// ---------------------------------------------------------------------------
// task_assign
// ---------------------------------------------------------------------------

export const taskAssignSpec = {
  name: "task_assign",
  description:
    "Create a swarm task document and assign it to a team. The task " +
    "captures a sportsclaw command, arguments, priority, and team binding. " +
    "Once assigned, a worker can pick it up via `sportsclaw worker run`.",
  inputSchema: {
    type: "object" as const,
    properties: {
      description: {
        type: "string",
        description: "Human-readable description of what this task does.",
      },
      command: {
        type: "string",
        description:
          "The sportsclaw sub-command to execute (e.g. 'watch', 'listen discord').",
      },
      args: {
        type: "array",
        items: { type: "string" },
        description: "Extra CLI arguments appended after the command.",
      },
      team_id: {
        type: "string",
        description: "Name/ID of the team this task is assigned to.",
      },
      priority: {
        type: "number",
        description: "Priority 0 (highest) to 9 (lowest). Default: 5.",
      },
      ttl_ms: {
        type: "number",
        description:
          "Time-to-live in milliseconds. Null = no expiry. Default: 86400000 (24h).",
      },
    },
    required: ["description", "command", "team_id"],
  },
} as const;

export interface TaskAssignParams {
  description: string;
  command: string;
  args?: string[];
  team_id: string;
  priority?: number;
  ttl_ms?: number;
}

export async function executeTaskAssign(
  ctx: SwarmToolContext,
  params: TaskAssignParams,
): Promise<SwarmToolResult<SwarmDocument<SwarmTask>>> {
  // Validate team exists
  const team = await ctx.storage.get<SwarmTeam>(NS_TEAMS, params.team_id);
  if (!team) {
    return {
      ok: false,
      error: `Team "${params.team_id}" not found. Create it first with team_create.`,
    };
  }

  const taskId = randomUUID().slice(0, 12);

  const task: SwarmTask = {
    description: params.description,
    command: params.command,
    args: params.args ?? [],
    teamId: params.team_id,
    assignedWorker: null,
    status: "pending",
    priority: params.priority ?? 5,
    assignedAt: null,
    completedAt: null,
    resultSummary: null,
  };

  const doc = await ctx.storage.put<SwarmTask>(NS_TASKS, taskId, task, {
    ttlMs: params.ttl_ms ?? 86_400_000, // 24h default
    labels: {
      kind: "task",
      team: params.team_id,
      status: "pending",
      priority: String(task.priority),
    },
  });

  return { ok: true, data: doc };
}

// ---------------------------------------------------------------------------
// worker_spawn
// ---------------------------------------------------------------------------

export const workerSpawnSpec = {
  name: "worker_spawn",
  description:
    "Spawn a worker process to execute a swarm task. The worker is " +
    "dispatched via the configured backend (PM2 locally, k8s in production). " +
    "The task status transitions from pending/assigned → running.",
  inputSchema: {
    type: "object" as const,
    properties: {
      task_id: {
        type: "string",
        description: "ID of the task document to execute.",
      },
      worker_name: {
        type: "string",
        description:
          "Optional worker name override. Defaults to 'task-<task_id>'.",
      },
      env: {
        type: "object",
        additionalProperties: { type: "string" },
        description:
          "Extra environment variables merged into the worker process.",
      },
      max_memory_mb: {
        type: "number",
        description:
          "Max memory in MB before the process manager triggers a restart.",
      },
    },
    required: ["task_id"],
  },
} as const;

export interface WorkerSpawnParams {
  task_id: string;
  worker_name?: string;
  env?: Record<string, string>;
  max_memory_mb?: number;
}

export async function executeWorkerSpawn(
  ctx: SwarmToolContext,
  params: WorkerSpawnParams,
): Promise<SwarmToolResult<{ task: SwarmDocument<SwarmTask>; worker: WorkerStatus }>> {
  // Load the task
  const taskDoc = await ctx.storage.get<SwarmTask>(NS_TASKS, params.task_id);
  if (!taskDoc) {
    return {
      ok: false,
      error: `Task "${params.task_id}" not found.`,
    };
  }

  const task = taskDoc.data;

  // Guard: only pending or assigned tasks can be spawned
  if (task.status !== "pending" && task.status !== "assigned") {
    return {
      ok: false,
      error: `Task "${params.task_id}" is in status "${task.status}" — only pending or assigned tasks can be spawned.`,
    };
  }

  // Load team for default env
  const teamDoc = await ctx.storage.get<SwarmTeam>(NS_TEAMS, task.teamId);
  const teamEnv = teamDoc?.data.defaultEnv ?? {};

  // Check team concurrency limit
  if (teamDoc) {
    const activeWorkers = await ctx.storage.list<SwarmTask>(NS_TASKS, {
      labels: { team: task.teamId, status: "running" },
    });
    if (activeWorkers.length >= teamDoc.data.maxWorkers) {
      return {
        ok: false,
        error:
          `Team "${task.teamId}" has reached its max worker limit ` +
          `(${teamDoc.data.maxWorkers}). Stop a running task first.`,
      };
    }
  }

  const workerName = params.worker_name ?? `task-${params.task_id}`;

  // Build the worker spec
  const spec: WorkerSpec = {
    name: workerName,
    command: "worker run",
    args: [params.task_id],
    env: {
      ...teamEnv,
      ...(params.env ?? {}),
      SWARM_TASK_ID: params.task_id,
      SWARM_TEAM_ID: task.teamId,
    },
    autorestart: false, // Tasks run to completion
    maxMemoryMb: params.max_memory_mb,
    labels: {
      kind: "swarm-worker",
      team: task.teamId,
      taskId: params.task_id,
    },
  };

  // Transition task to running
  const now = new Date().toISOString();
  task.status = "running";
  task.assignedWorker = workerName;
  task.assignedAt = now;

  const updatedTask = await ctx.storage.put<SwarmTask>(
    NS_TASKS,
    params.task_id,
    task,
    {
      labels: {
        kind: "task",
        team: task.teamId,
        status: "running",
        priority: String(task.priority),
      },
    },
  );

  // Dispatch the worker process
  let workerStatus: WorkerStatus;
  try {
    workerStatus = await ctx.dispatcher.spawn(spec);
  } catch (err: unknown) {
    // Roll back task status on spawn failure
    task.status = "assigned";
    task.assignedWorker = null;
    await ctx.storage.put<SwarmTask>(NS_TASKS, params.task_id, task, {
      labels: {
        kind: "task",
        team: task.teamId,
        status: "assigned",
        priority: String(task.priority),
      },
    });

    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Failed to spawn worker: ${msg}` };
  }

  return {
    ok: true,
    data: { task: updatedTask, worker: workerStatus },
  };
}

// ---------------------------------------------------------------------------
// Tool registry — for bulk MCP server registration
// ---------------------------------------------------------------------------

export interface SwarmToolDefinition {
  spec: {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  };
  execute: (
    ctx: SwarmToolContext,
    params: Record<string, unknown>,
  ) => Promise<SwarmToolResult>;
}

/**
 * All swarm tools in a registry array. Each entry has a `spec` for
 * MCP tool registration and an `execute` function for invocation.
 *
 * Usage with an MCP server:
 * ```ts
 * for (const tool of SWARM_TOOLS) {
 *   server.tool(tool.spec.name, tool.spec.inputSchema, async (params) => {
 *     return tool.execute(ctx, params);
 *   });
 * }
 * ```
 */
export const SWARM_TOOLS: SwarmToolDefinition[] = [
  {
    spec: teamCreateSpec,
    execute: (ctx, params) =>
      executeTeamCreate(ctx, params as unknown as TeamCreateParams),
  },
  {
    spec: taskAssignSpec,
    execute: (ctx, params) =>
      executeTaskAssign(ctx, params as unknown as TaskAssignParams),
  },
  {
    spec: workerSpawnSpec,
    execute: (ctx, params) =>
      executeWorkerSpawn(ctx, params as unknown as WorkerSpawnParams),
  },
];
