/**
 * Shared types for the media stories module.
 */

import type { RightsAuthorization } from "../highlights/types.js";

export const ARTIFACT_KINDS = [
  "source",
  "clock-map",
  "event-index",
  "subject-tracks",
  "subject-identity",
  "facts",
  "lines-checked",
  "voice",
  "timeline",
  "video",
] as const;

export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/**
 * Kinds only the story tools make (facts, checked lines, voice, timelines). A job kind whose produces
 * names one is invalid (bundle.ts), and the tools accept such an artifact only if they registered it
 * in the same run (tools.ts, `artifact_not_minted`).
 */
export const TOOL_MINTED_KINDS: ReadonlySet<ArtifactKind> = new Set<ArtifactKind>(["facts", "lines-checked", "voice", "timeline"]);

/**
 * Per-game kinds a prep job may make ("prep": true in jobs.json). Prep jobs outlive the run that started
 * them and their artifacts are shared for the source (prep.ts).
 */
export const PREP_KINDS: ReadonlySet<ArtifactKind> = new Set<ArtifactKind>(["clock-map", "event-index", "subject-tracks", "subject-identity"]);

export interface Artifact {
  id: string;
  kind: ArtifactKind;
  path: string;
  sha256: string;
  sizeBytes: number;
  sourceSha256?: string;
  runId: string;
  createdAt: string;
  facts?: Record<string, unknown>;
}

export type RightsCheckMode = "require" | "off";

/**
 * Footage clearance for one exact file (its sha256). It comes only from operator config
 * (media.clearances) or from the app starting a run (RunOptions.mediaClearances), never
 * from a tool call, so the model cannot clear a video.
 */
export type MediaClearance = RightsAuthorization & { sourceSha256: string };

export interface MediaConfig {
  workspaceDir: string;
  rightsCheck?: RightsCheckMode;
  /** "<skill>/<kind>" or "default" -> argv prefix. */
  interpreters?: Record<string, string[]>;
  maxJobsPerRun?: number;
  /**
   * Tool names whose results count as facts for story_facts_collect, besides the Sports Skills
   * data tools. Host and MCP tools are not facts unless listed here. Default: none.
   */
  factTools?: string[];
  /** Operator clearances, each tied to one source file's sha256 (used when rightsCheck is "require"). */
  clearances?: MediaClearance[];
}
