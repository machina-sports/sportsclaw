/**
 * Shared types for the media stories module.
 */

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
}
