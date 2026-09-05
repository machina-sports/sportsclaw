import type { CandidateWindow, ClipManifest, FfprobeEvidence } from "../../dist/highlights/types.js";

const candidate: CandidateWindow = {
  actionId: "goal-1",
  provider: "espn",
  provenance: "espn:pbp:401234567:goal-1",
  label: "Goal",
  type: "goal",
  period: 1,
  importance: 95,
  actionVideoSec: 10,
  startSec: 7,
  endSec: 14,
};

void candidate;

const v1Evidence: FfprobeEvidence = {
  durationSec: 7,
  formatName: "mov,mp4",
};

void v1Evidence;

// Old V1 receipts remain representable; consumers must check integrity fields
// explicitly before treating them as verified media.
const historical: ClipManifest = {
  version: 1, generatedAt: "2026-09-04T00:00:00Z", state: "succeeded",
  event: { provider: "espn", sport: "soccer", eventId: "401234567" },
  rights: { rightsHolder: "Test", licenseRef: "synthetic", clearedForClipping: true },
  source: { kind: "local-file", path: "/synthetic.mp4", ffprobe: v1Evidence },
  syncAnchor: { videoSec: 0, clockSec: 0 },
  window: { preRollSec: 3, postRollSec: 4, maxCandidates: 1 },
  windows: [candidate],
  clips: [{ ...candidate, file: "/clip.mp4", durationSec: 7, ffprobe: v1Evidence }],
};
void historical;
