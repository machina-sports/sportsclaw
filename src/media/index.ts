/**
 * Media stories — the public surface of src/media/ (see docs/advanced/media-stories.md).
 */

export { ARTIFACT_KINDS, PREP_KINDS, TOOL_MINTED_KINDS } from "./types.js";
export type { Artifact, ArtifactKind, MediaClearance, MediaConfig, RightsCheckMode } from "./types.js";
export { RIGHTS_CHECK_ENV, RIGHTS_OFF_NOTE, parseClearances, resolveRightsCheck } from "./rights.js";
export { ArtifactError, ArtifactStore, hashFile } from "./artifacts.js";
export type { ArtifactErrorCode } from "./artifacts.js";
export { BundleError, JOB_ALLOWLIST_ENV, approvedJobBundles, approvedJobKinds, bundleSha256, sealBundle } from "./bundle.js";
export type { ApprovedBundle, JobKindDecl } from "./bundle.js";
export { JobError, LocalJobRunner } from "./jobs.js";
export type { JobArtifactRef, JobRecord, JobRunner, JobStatusFile } from "./jobs.js";
export { MAX_ROLE_PROXY_BODY_BYTES, startRoleProxy } from "./role-proxy.js";
export type { RoleProxy } from "./role-proxy.js";
export { ClockMapError, clockMapFromSyncAnchor, clockToVideoSec, parseClockMap } from "./clock-map.js";
export type { ClockMap, ClockStretch } from "./clock-map.js";
export { buildEventIndex, findEvents } from "./event-index.js";
export type { EventIndex, IndexedEvent } from "./event-index.js";
export { LinesError, checkLines, collectFacts, draftLines, jobLineChecker } from "./lines.js";
export type { CheckedLine, DraftLine, Fact, LineChecker, LineVerdict } from "./lines.js";
export { EVENT_SLACK_SEC, TimelineError, resolveTimeline } from "./timeline.js";
export type { ResolvedTimeline, StoryTimeline, TimelineSegment } from "./timeline.js";
export { renderPlain } from "./render-plain.js";
export { MAX_PREP_JOBS, MediaPrep } from "./prep.js";
export type { PrepSink } from "./prep.js";
export { MAX_CHECK_ROUNDS, MAX_STATUS_WAIT_SEC, MEDIA_TOOL_NAMES, STEP_INPUT_STRING_CHARS, createMediaTools } from "./tools.js";
export type { MediaStep, MediaToolName, MediaToolsContext } from "./tools.js";
