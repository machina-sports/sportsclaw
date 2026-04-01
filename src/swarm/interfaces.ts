/**
 * sportsclaw — Swarm Architecture: Core Interfaces
 *
 * Defines the storage and dispatch contracts for the swarm layer.
 * All implementations (local file, cloud, PM2, k8s) conform to these
 * interfaces so the orchestrator stays backend-agnostic.
 *
 * Storage namespaces map 1:1 to Machina pod documents — each namespace
 * is a logical partition (e.g. "workers", "jobs", "results") that can
 * be bridged to Relay channels for cross-pod synchronisation.
 */

// ---------------------------------------------------------------------------
// Swarm Document — the unit of persistence
// ---------------------------------------------------------------------------

/** Metadata envelope wrapping any JSON-serialisable payload. */
export interface SwarmDocument<T = unknown> {
  /** Unique document ID within its namespace. */
  id: string;
  /** Logical namespace (e.g. "workers", "jobs", "results"). */
  namespace: string;
  /** The payload. */
  data: T;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** ISO-8601 last-update timestamp. */
  updatedAt: string;
  /** Optional TTL in milliseconds. Null = no expiry. */
  ttlMs: number | null;
  /** Arbitrary key-value labels for filtering. */
  labels: Record<string, string>;
}

/** Options for listing / querying documents. */
export interface SwarmQueryOptions {
  /** Filter by label key-value pairs (AND logic). */
  labels?: Record<string, string>;
  /** Maximum number of results. */
  limit?: number;
  /** Sort order by updatedAt. Default: "desc". */
  sort?: "asc" | "desc";
}

// ---------------------------------------------------------------------------
// ISwarmStorage — persistence contract
// ---------------------------------------------------------------------------

/**
 * Backend-agnostic storage for swarm state.
 *
 * Implementations:
 *   - LocalFileStorageBackend  → ~/.sportsclaw/swarm/  (this repo)
 *   - Future: CloudStorageBackend → Machina Core API / pod memory
 */
export interface ISwarmStorage {
  /**
   * Persist a document. Creates or overwrites.
   * Returns the stored document with updated timestamps.
   */
  put<T>(
    namespace: string,
    id: string,
    data: T,
    options?: { ttlMs?: number; labels?: Record<string, string> },
  ): Promise<SwarmDocument<T>>;

  /**
   * Retrieve a single document by namespace + ID.
   * Returns null if not found or expired.
   */
  get<T = unknown>(namespace: string, id: string): Promise<SwarmDocument<T> | null>;

  /**
   * Delete a document. Returns true if it existed.
   */
  delete(namespace: string, id: string): Promise<boolean>;

  /**
   * List documents in a namespace, optionally filtered.
   */
  list<T = unknown>(
    namespace: string,
    options?: SwarmQueryOptions,
  ): Promise<SwarmDocument<T>[]>;

  /**
   * Remove all expired documents across all namespaces.
   * Returns the count of purged documents.
   */
  purgeExpired(): Promise<number>;
}

// ---------------------------------------------------------------------------
// Worker types — dispatch contract primitives
// ---------------------------------------------------------------------------

/** What to run and how. */
export interface WorkerSpec {
  /** Unique worker name (becomes the PM2/process name). */
  name: string;
  /** The sportsclaw sub-command to execute (e.g. "listen discord", "watch"). */
  command: string;
  /** Extra CLI args appended after the command. */
  args?: string[];
  /** Environment variables merged into the child process. */
  env?: Record<string, string>;
  /** Restart on crash. Default: true. */
  autorestart?: boolean;
  /** Max memory in MB before PM2 triggers a restart. */
  maxMemoryMb?: number;
  /** Arbitrary labels for grouping / filtering. */
  labels?: Record<string, string>;
}

/** Runtime status of a dispatched worker. */
export type WorkerRunState =
  | "online"
  | "stopping"
  | "stopped"
  | "errored"
  | "unknown";

/** Snapshot of a running (or recently stopped) worker. */
export interface WorkerStatus {
  /** The worker name from WorkerSpec. */
  name: string;
  /** Current runtime state. */
  state: WorkerRunState;
  /** OS process ID (null if not running). */
  pid: number | null;
  /** Memory usage in bytes (null if unavailable). */
  memoryBytes: number | null;
  /** Uptime in milliseconds (null if not running). */
  uptimeMs: number | null;
  /** Number of times PM2 has restarted this worker. */
  restarts: number;
  /** ISO-8601 timestamp of the last status check. */
  checkedAt: string;
}

// ---------------------------------------------------------------------------
// IWorkerDispatcher — process lifecycle contract
// ---------------------------------------------------------------------------

/**
 * Backend-agnostic worker lifecycle management.
 *
 * Implementations:
 *   - PM2Dispatcher      → local PM2 process manager (this repo)
 *   - Future: K8sDispatcher → Kubernetes Job / Deployment
 */
export interface IWorkerDispatcher {
  /**
   * Spawn a new worker process from a spec.
   * Throws if a worker with the same name is already running.
   */
  spawn(spec: WorkerSpec): Promise<WorkerStatus>;

  /**
   * Gracefully stop a worker by name.
   * Returns the final status. Throws if worker not found.
   */
  stop(name: string): Promise<WorkerStatus>;

  /**
   * Restart a worker (stop + start with same spec).
   * Throws if worker not found.
   */
  restart(name: string): Promise<WorkerStatus>;

  /**
   * Get the current status of a single worker.
   * Returns null if no worker with that name exists.
   */
  status(name: string): Promise<WorkerStatus | null>;

  /**
   * List all workers managed by this dispatcher.
   * Optionally filter by label key-value pairs.
   */
  list(labels?: Record<string, string>): Promise<WorkerStatus[]>;

  /**
   * Stop and remove all workers managed by this dispatcher.
   */
  destroyAll(): Promise<void>;
}
