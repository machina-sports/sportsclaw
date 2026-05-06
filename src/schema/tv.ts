/**
 * sportsclaw — TV Operator Contracts
 *
 * Typed contracts and lightweight runtime validators for broadcast operations.
 * These are data-only definitions — no engine wiring or behavior.
 */

// ---------------------------------------------------------------------------
// FreshnessClass — how stale is this content?
// ---------------------------------------------------------------------------

export const FRESHNESS_CLASSES = [
  "LIVE",
  "HOT_SYNC",
  "FRESH",
  "EVERGREEN",
] as const;

export type FreshnessClass = (typeof FRESHNESS_CLASSES)[number];

// ---------------------------------------------------------------------------
// ReviewState — editorial approval state
// ---------------------------------------------------------------------------

export type ReviewState = "pending" | "approved" | "rejected" | "expired";

// ---------------------------------------------------------------------------
// FallbackPolicy — what to air when a block's source is unavailable
// ---------------------------------------------------------------------------

export interface FallbackPolicy {
  blockId: string;
  reason: string;
}

// ---------------------------------------------------------------------------
// PlaylistBlock — a single segment in a broadcast playlist
// ---------------------------------------------------------------------------

export interface PlaylistBlock {
  id: string;
  title: string;
  durationSec: number;
  freshness: FreshnessClass;
  fallback: FallbackPolicy;
  sourceRef?: string;
  freshnessTimestamp?: string;
  review?: ReviewState;
  meta?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// PlaylistManifest — ordered list of blocks for a channel
// ---------------------------------------------------------------------------

export interface PlaylistManifest {
  id: string;
  channelId: string;
  blocks: PlaylistBlock[];
  createdAt: string;
  meta?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// ChannelState — snapshot of a broadcast channel
// ---------------------------------------------------------------------------

export interface ChannelState {
  channelId: string;
  status: "idle" | "on-air" | "error";
  currentBlockId?: string;
  manifestId?: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// OnAirBlock / OnAirState — what is currently playing
// ---------------------------------------------------------------------------

export interface OnAirBlock {
  blockId: string;
  startedAt: string;
  elapsedSec: number;
  remainingSec: number;
}

export interface OnAirState {
  channelId: string;
  current: OnAirBlock | null;
  next: OnAirBlock | null;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// DecisionRecord — audit trail for automated broadcast decisions
// ---------------------------------------------------------------------------

export interface DecisionRecord {
  id: string;
  timestamp: string;
  action: string;
  reason: string;
  blockId?: string;
  agentId?: string;
  meta?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// AgentRunRecord — record of an agent run that produced broadcast actions
// ---------------------------------------------------------------------------

export interface AgentRunRecord {
  id: string;
  agentId: string;
  startedAt: string;
  endedAt?: string;
  decisions: DecisionRecord[];
  status: "running" | "completed" | "failed";
}

// ---------------------------------------------------------------------------
// IncidentRecord — record of an operational incident or pipeline issue
// ---------------------------------------------------------------------------

export interface IncidentRecord {
  id: string;
  timestamp: string;
  level: "warning" | "error" | "critical";
  message: string;
  component: string;
  resolvedAt?: string;
  resolution?: string;
  meta?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// HealthSnapshot — point-in-time health of the broadcast pipeline
// ---------------------------------------------------------------------------

export interface HealthSnapshot {
  timestamp: string;
  channelId: string;
  status: "healthy" | "degraded" | "down";
  activeBlocks: number;
  staleSources: number;
  errors: string[];
}

// ---------------------------------------------------------------------------
// Validation result
// ---------------------------------------------------------------------------

export type ValidationResult =
  | { ok: true }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// HealthSnapshot input (omits derived status)
// ---------------------------------------------------------------------------

export type HealthSnapshotInput = Omit<HealthSnapshot, "status">;

// ---------------------------------------------------------------------------
// buildHealthSnapshot — derive status from input signals
// ---------------------------------------------------------------------------

const DOWN_KEYWORDS = /\bcritical\b|\bdown\b/i;

export function buildHealthSnapshot(input: HealthSnapshotInput): HealthSnapshot {
  const { timestamp, channelId, activeBlocks, staleSources, errors } = input;

  let status: HealthSnapshot["status"];

  const hasCriticalError = errors.some((e) => DOWN_KEYWORDS.test(e));

  if (activeBlocks === 0 || hasCriticalError) {
    status = "down";
  } else if (staleSources > 0 || errors.length > 0) {
    status = "degraded";
  } else {
    status = "healthy";
  }

  return { timestamp, channelId, status, activeBlocks, staleSources, errors };
}

// ---------------------------------------------------------------------------
// validateHealthSnapshot — runtime validation
// ---------------------------------------------------------------------------

const VALID_STATUSES = new Set(["healthy", "degraded", "down"]);

export function validateHealthSnapshot(snapshot: unknown): ValidationResult {
  if (!snapshot || typeof snapshot !== "object") {
    return { ok: false, error: "Snapshot must be a non-null object." };
  }

  const s = snapshot as Record<string, unknown>;

  if (typeof s.timestamp !== "string" || s.timestamp === "") {
    return { ok: false, error: "Snapshot must have a non-empty timestamp." };
  }

  if (typeof s.channelId !== "string" || s.channelId === "") {
    return { ok: false, error: "Snapshot must have a non-empty channelId." };
  }

  if (!VALID_STATUSES.has(s.status as string)) {
    return { ok: false, error: "Snapshot status must be healthy, degraded, or down." };
  }

  if (typeof s.activeBlocks !== "number" || s.activeBlocks < 0) {
    return { ok: false, error: "Snapshot activeBlocks must be a non-negative number." };
  }

  if (typeof s.staleSources !== "number" || s.staleSources < 0) {
    return { ok: false, error: "Snapshot staleSources must be a non-negative number." };
  }

  if (!Array.isArray(s.errors)) {
    return { ok: false, error: "Snapshot errors must be an array." };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Validators — lightweight runtime safety checks
// ---------------------------------------------------------------------------

/** Every playlist block must have positive duration and a fallback. */
export function validatePlaylistBlock(block: unknown): ValidationResult {
  const b = block as Record<string, unknown>;

  if (typeof b?.durationSec !== "number" || b.durationSec <= 0) {
    return { ok: false, error: "Block must have a positive duration (durationSec > 0)." };
  }

  if (!b.fallback || typeof b.fallback !== "object") {
    return { ok: false, error: "Block must have a fallback policy." };
  }

  return { ok: true };
}

/** Manifest must have at least one block and positive total duration. */
export function validatePlaylistManifest(manifest: unknown): ValidationResult {
  const m = manifest as Record<string, unknown>;
  const blocks = m?.blocks;

  if (!Array.isArray(blocks) || blocks.length === 0) {
    return { ok: false, error: "Manifest must contain at least one block." };
  }

  for (const block of blocks) {
    const blockResult = validatePlaylistBlock(block);
    if (!blockResult.ok) return blockResult;
    const metaResult = validateLiveContentMeta(block);
    if (!metaResult.ok) return metaResult;
  }

  const totalDuration = blocks.reduce(
    (sum: number, b: Record<string, unknown>) => sum + (Number(b.durationSec) || 0),
    0,
  );
  if (totalDuration <= 0) {
    return { ok: false, error: "Manifest total duration must be positive." };
  }

  return { ok: true };
}

/** LIVE and HOT_SYNC content must carry sourceRef and freshnessTimestamp. */
export function validateLiveContentMeta(block: unknown): ValidationResult {
  const b = block as Record<string, unknown>;
  const freshness = b?.freshness as string | undefined;

  if (freshness === "LIVE" || freshness === "HOT_SYNC") {
    if (!b.sourceRef || typeof b.sourceRef !== "string") {
      return { ok: false, error: `${freshness} block must have a source reference (sourceRef).` };
    }
    if (!b.freshnessTimestamp || typeof b.freshnessTimestamp !== "string") {
      return { ok: false, error: `${freshness} block must have a freshness timestamp (freshnessTimestamp).` };
    }
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// validateManifestCoverage — higher-level coverage policy checks
// ---------------------------------------------------------------------------

export interface ManifestCoverageOptions {
  minimumTotalDurationSec?: number;
  maximumTotalDurationSec?: number;
  requireFallbackForEveryBlock?: boolean;
  requireFreshnessForLiveBlocks?: boolean;
  maxLiveAgeMs?: number;
  nowMs?: number;
  expectedBlockCountMin?: number;
}

function isLiveFreshness(value: unknown): boolean {
  return value === "LIVE" || value === "HOT_SYNC";
}

export function validateManifestCoverage(
  manifest: unknown,
  options: ManifestCoverageOptions = {},
): ValidationResult {
  const baseResult = validatePlaylistManifest(manifest);
  if (!baseResult.ok) return baseResult;

  const blocks = (manifest as { blocks: Record<string, unknown>[] }).blocks;

  if (
    typeof options.expectedBlockCountMin === "number" &&
    blocks.length < options.expectedBlockCountMin
  ) {
    return {
      ok: false,
      error: `Manifest must contain at least ${options.expectedBlockCountMin} blocks (found ${blocks.length}).`,
    };
  }

  const totalDuration = blocks.reduce(
    (sum, b) => sum + (Number(b.durationSec) || 0),
    0,
  );

  if (
    typeof options.minimumTotalDurationSec === "number" &&
    totalDuration < options.minimumTotalDurationSec
  ) {
    return {
      ok: false,
      error: `Manifest total duration ${totalDuration}s is below minimum ${options.minimumTotalDurationSec}s.`,
    };
  }

  if (
    typeof options.maximumTotalDurationSec === "number" &&
    totalDuration > options.maximumTotalDurationSec
  ) {
    return {
      ok: false,
      error: `Manifest total duration ${totalDuration}s exceeds maximum ${options.maximumTotalDurationSec}s.`,
    };
  }

  if (options.requireFallbackForEveryBlock) {
    for (const block of blocks) {
      const fallback = block.fallback as Record<string, unknown> | undefined;
      if (
        !fallback ||
        typeof fallback.blockId !== "string" ||
        fallback.blockId === "" ||
        typeof fallback.reason !== "string" ||
        fallback.reason === ""
      ) {
        return {
          ok: false,
          error: `Block ${String(block.id ?? "?")} must have a complete fallback policy (blockId and reason).`,
        };
      }
    }
  }

  if (options.requireFreshnessForLiveBlocks) {
    for (const block of blocks) {
      if (!isLiveFreshness(block.freshness)) continue;
      if (typeof block.sourceRef !== "string" || block.sourceRef === "") {
        return {
          ok: false,
          error: `Block ${String(block.id ?? "?")} (${String(block.freshness)}) must have a sourceRef.`,
        };
      }
      if (
        typeof block.freshnessTimestamp !== "string" ||
        block.freshnessTimestamp === ""
      ) {
        return {
          ok: false,
          error: `Block ${String(block.id ?? "?")} (${String(block.freshness)}) must have a freshnessTimestamp.`,
        };
      }
    }
  }

  if (typeof options.maxLiveAgeMs === "number") {
    const nowMs = typeof options.nowMs === "number" ? options.nowMs : Date.now();
    for (const block of blocks) {
      if (!isLiveFreshness(block.freshness)) continue;
      const ts = block.freshnessTimestamp;
      if (typeof ts !== "string" || ts === "") continue;
      const ageMs = nowMs - Date.parse(ts);
      if (Number.isNaN(ageMs)) continue;
      if (ageMs > options.maxLiveAgeMs) {
        return {
          ok: false,
          error: `Block ${String(block.id ?? "?")} (${String(block.freshness)}) freshness is stale: age ${ageMs}ms exceeds maxLiveAgeMs ${options.maxLiveAgeMs}ms.`,
        };
      }
    }
  }

  return { ok: true };
}
