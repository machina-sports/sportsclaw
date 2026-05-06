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
