/**
 * SportsClaw highlights core — public API.
 *
 * The single deterministic implementation behind `sportsclaw clip`,
 * `sportsclaw highlights run`, and the relay `/api/highlights/jobs` API.
 */

export * from "./types.js";
export {
  DEFAULT_WINDOW_POLICY,
  STRONG_WINDOW_OVERLAP_RATIO,
  HighlightsValidationError,
  parseHighlightsRequest,
  planCandidateWindows,
  validateHighlightsRequest,
} from "./plan.js";
export { extractSegment, probeVideo } from "./ffmpeg.js";
export {
  DEFAULT_MAX_JOB_OUTPUT_BYTES,
  HighlightsRunError,
  resolveMaxJobOutputBytes,
  runHighlights,
} from "./run.js";
