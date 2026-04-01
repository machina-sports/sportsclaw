/**
 * sportsclaw — Swarm Architecture (barrel export)
 *
 * Interfaces, types, and local implementations for the swarm layer.
 * Import from "sportsclaw/swarm" for all swarm primitives.
 */

// Interfaces & types
export type {
  SwarmDocument,
  SwarmQueryOptions,
  ISwarmStorage,
  WorkerSpec,
  WorkerRunState,
  WorkerStatus,
  IWorkerDispatcher,
} from "./interfaces.js";

// Local implementations
export { LocalFileStorageBackend } from "./LocalFileStorageBackend.js";
export { PM2Dispatcher } from "./PM2Dispatcher.js";

// Phase 3 — Swarm tools (MCP-compatible)
export {
  SWARM_TOOLS,
  teamCreateSpec,
  taskAssignSpec,
  workerSpawnSpec,
  executeTeamCreate,
  executeTaskAssign,
  executeWorkerSpawn,
  NS_TEAMS,
  NS_TASKS,
  NS_RESULTS,
} from "./tools.js";

export type {
  SwarmTeam,
  SwarmTask,
  SwarmTaskStatus,
  SwarmToolResult,
  SwarmToolContext,
  SwarmToolDefinition,
  TeamCreateParams,
  TaskAssignParams,
  WorkerSpawnParams,
} from "./tools.js";

// Phase 3 — Worker task executor
export { runWorkerTask } from "./worker-run.js";
export type { TaskResult } from "./worker-run.js";
