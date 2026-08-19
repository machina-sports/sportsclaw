/**
 * SportsClaw highlights core — typed contracts (V1)
 *
 * These types define the deterministic highlights job capability shared by the
 * CLI (`sportsclaw clip`, `sportsclaw highlights run`) and the project relay
 * job API. V1 operates only on local files already inside the relay/CLI
 * workspace; `SourceMediaRef.kind` is a discriminated union so signed-URL or
 * object-store references can be added later without breaking consumers.
 */

/** Rights/source authorization metadata. Extraction refuses to run without it. */
export interface RightsAuthorization {
  /** Owner of the source media rights (broadcaster, league, internal). */
  rightsHolder: string;
  /** License/agreement reference under which clipping is authorized. */
  licenseRef: string;
  /** Must be explicitly true — absence or false fails closed. */
  clearedForClipping: boolean;
  /** Optional ISO-3166 territory codes the clearance covers. */
  territories?: string[];
}

/** V1: a local file inside the relay/CLI workspace. No HTTP download. */
export interface LocalFileSource {
  kind: "local-file";
  path: string;
}

/** Future-proofing discriminant — only "local-file" is implemented in V1. */
export type SourceMediaRef = LocalFileSource;

/** Canonical identity of the sports event the source video covers. */
export interface CanonicalEventId {
  provider: string;
  sport: string;
  eventId: string;
}

/**
 * Clock semantics the deterministic mapper supports. Anything else (countdown
 * clocks, per-period resets without absolute elapsed time) is rejected
 * explicitly rather than guessed.
 */
export const SUPPORTED_CLOCK_SEMANTICS = "elapsed-ascending";

export interface PBPClock {
  /** Must equal SUPPORTED_CLOCK_SEMANTICS in V1. */
  semantics: string;
  /** Seconds elapsed since the event's clock origin (ascending). */
  elapsedSec: number;
}

/** A real play-by-play action from a data provider. Never synthesized. */
export interface PBPAction {
  actionId: string;
  provider: string;
  period: number;
  clock: PBPClock;
  label: string;
  type: string;
  /** Optional editorial importance 0–100; used only to trim to maxCandidates. */
  importance?: number;
  /** Where this action came from (feed name, capture reference). Required. */
  provenance: string;
}

/** Fixed anchor aligning the PBP clock to the source video timeline. */
export interface SyncAnchor {
  /** Source-video second at which the anchored clock moment appears. */
  videoSec: number;
  /** PBP elapsed-clock second at that same moment. */
  clockSec: number;
  /** Optional period the anchor was taken in (metadata only in V1). */
  period?: number;
}

/** Pre/post-roll and candidate limits for window planning. */
export interface WindowPolicy {
  preRollSec: number;
  postRollSec: number;
  maxCandidates: number;
}

/** The full typed request the core executes. */
export interface HighlightsRequest {
  rights: RightsAuthorization;
  source: SourceMediaRef;
  event: CanonicalEventId;
  actions: PBPAction[];
  syncAnchor: SyncAnchor;
  window?: WindowPolicy;
  outputDir: string;
}

/** A planned candidate window, mapped deterministically from one PBP action. */
export interface CandidateWindow {
  actionId: string;
  provider: string;
  provenance: string;
  label: string;
  type: string;
  period: number;
  importance?: number;
  /** Source-video second the action maps to. */
  actionVideoSec: number;
  startSec: number;
  endSec: number;
}

/** FFprobe evidence embedded in the manifest for the source and each clip. */
export interface FfprobeEvidence {
  durationSec: number;
  formatName: string;
}

/** One extracted clip in the output manifest. */
export interface ClipArtifact extends CandidateWindow {
  file: string;
  durationSec: number;
  ffprobe: FfprobeEvidence;
}

/** Terminal + non-terminal job states shared with the relay job API. */
export type HighlightsJobState = "queued" | "running" | "succeeded" | "failed" | "canceled";

/** The manifest written after a successful run. */
export interface ClipManifest {
  version: 1;
  generatedAt: string;
  state: "succeeded";
  event: CanonicalEventId;
  rights: RightsAuthorization;
  source: SourceMediaRef & { ffprobe: FfprobeEvidence };
  syncAnchor: SyncAnchor;
  window: WindowPolicy;
  windows: CandidateWindow[];
  clips: ClipArtifact[];
}
