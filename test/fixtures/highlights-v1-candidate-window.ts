import type { CandidateWindow, FfprobeEvidence } from "../../dist/highlights/types.js";

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
