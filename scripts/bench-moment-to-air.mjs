#!/usr/bin/env node
/**
 * Moment-to-air benchmark — per-role inference latency across the
 * pod ⇄ inference-plane boundary.
 *
 * Runs the full editorial pipeline for one synthetic match moment:
 *
 *   eyes (visual read) -> brain (editorial reasoning)
 *     -> hands (asset generation) -> voice (narration/copy)
 *     -> publish (validate moment + manifest block)
 *
 * and prints a single JSON report with per-role latencies and
 * role/model/locality/accelerator metadata. GPU indices are runtime
 * metadata for the 8xH200 demo cluster — the contracts themselves are
 * hardware-agnostic.
 *
 * Routes:
 *   default          — mock route, no network, safe for CI.
 *   BENCH_ROUTE=nim  — real NIM endpoints (requires NIM_BASE_URL or
 *                      per-role config; endpoint values are never printed).
 *   BENCH_ROUTE=openshell — OpenShell Privacy Router.
 *
 * No secrets, tokens, or endpoint URLs are printed.
 */

import { invokeModelRole } from "../dist/inference/model-role-router.js";
import { validateMatchMoment, validatePlaylistManifest } from "../dist/schema/tv.js";

const route = process.env.BENCH_ROUTE ?? "mock";
if (!["mock", "nim", "openshell"].includes(route)) {
  console.error(`Unknown BENCH_ROUTE "${route}" — use mock, nim, or openshell.`);
  process.exit(1);
}

// Role -> model/accelerator placement for the 8xH200 demo cluster.
// Locality/accelerator are trace metadata only — callers request roles.
const ROLE_PLACEMENT = {
  eyes: { model: "nvidia/cosmos3-nano-reasoner", gpu: 0 },
  brain: { model: "nvidia/nemotron-3-super-120b-a12b", gpus: [1, 2, 3, 4] },
  hands: { model: "nvidia/cosmos3-super-i2v", gpus: [5, 6] },
  voice: { model: "nvidia/llama-3.3-nemotron-super-49b", gpu: 7 },
};

const config = {
  roles: Object.fromEntries(
    Object.entries(ROLE_PLACEMENT).map(([role, placement]) => [
      role,
      { route, locality: "h200", accelerator: "h200", model: placement.model },
    ]),
  ),
};

const FIXTURE_ID = "benchmark-fixture";

async function timeRole(role, input) {
  const result = await invokeModelRole({
    role,
    input,
    source: "benchmark",
    config,
  });
  return { latencyMs: result.trace.latencyMs, output: result.output, trace: result.trace };
}

async function main() {
  const totalStart = Date.now();

  // eyes — visual perception over a synthetic clip
  const eyes = await timeRole("eyes", {
    fixtureId: FIXTURE_ID,
    clipUrl: "https://example.invalid/benchmark/clip.mp4",
    sampledFps: 4,
    prompt: "Describe the decisive action in this clip.",
  });

  // brain — editorial reasoning over the visual read
  const brain = await timeRole("brain", {
    fixtureId: FIXTURE_ID,
    visualRead: "Left winger beats the fullback and drives a low cross.",
    prompt: "What is the tactical meaning and broadcast angle?",
  });

  // hands — generated asset production for the moment
  const hands = await timeRole("hands", {
    fixtureId: FIXTURE_ID,
    momentType: "goal_chance",
    prompt: "Generate a short explainer clip for this moment.",
  });

  // voice — narration/chyron copy
  const voice = await timeRole("voice", {
    fixtureId: FIXTURE_ID,
    broadcastAngle: "Brazil pressure is now structural, not random.",
    prompt: "Write a 12-second narration line and a chyron.",
  });

  // publish — validate the moment + manifest block through the TV contracts
  const publishStart = Date.now();
  const moment = {
    id: "benchmark-moment-1",
    fixtureId: FIXTURE_ID,
    clipUrl: "https://example.invalid/benchmark/clip.mp4",
    sampledFps: 4,
    momentType: "goal_chance",
    visualRead: "Left winger beats the fullback and drives a low cross.",
    tacticalMeaning: "Repeatable overloads on the left side.",
    broadcastAngle: "Brazil pressure is now structural, not random.",
    confidence: 0.84,
    createdAt: new Date().toISOString(),
    source: "benchmark",
    trace: eyes.trace,
  };
  const momentCheck = validateMatchMoment(moment);
  if (!momentCheck.ok) {
    console.error(`Benchmark moment failed validation: ${momentCheck.error}`);
    process.exit(1);
  }
  const manifestCheck = validatePlaylistManifest({
    id: "benchmark-manifest-1",
    channelId: "benchmark-channel",
    createdAt: new Date().toISOString(),
    blocks: [
      {
        id: "benchmark-block-1",
        title: "Benchmark moment",
        durationSec: 30,
        freshness: "LIVE",
        fallback: { blockId: "benchmark-evergreen-1", reason: "benchmark" },
        sourceRef: `tv-match-moment:${moment.id}`,
        freshnessTimestamp: moment.createdAt,
      },
    ],
  });
  if (!manifestCheck.ok) {
    console.error(`Benchmark manifest failed validation: ${manifestCheck.error}`);
    process.exit(1);
  }
  const publishMs = Date.now() - publishStart;

  const report = {
    cluster: "8xh200",
    route,
    fixture_id: FIXTURE_ID,
    eyes_ms: eyes.latencyMs,
    brain_ms: brain.latencyMs,
    hands_ms: hands.latencyMs,
    voice_ms: voice.latencyMs,
    publish_ms: publishMs,
    total_ms: Date.now() - totalStart,
    roles: Object.fromEntries(
      Object.entries(ROLE_PLACEMENT).map(([role, placement]) => [
        role,
        {
          ...placement,
          route,
          locality: "h200",
          accelerator: "h200",
        },
      ]),
    ),
  };

  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  // Never echo endpoint config in failures — message only.
  console.error(`moment-to-air benchmark failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
