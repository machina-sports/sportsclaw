/**
 * sportsclaw — Momentum Explainer demo runner (Phase 3)
 *
 * Boots the real WatchManager against the committed mock game and prints a
 * Momentum Explainer card each time the home price swings >10 cents. Fully
 * self-contained: mock data source + in-process callback transport + a real
 * LLM writing the card (via ambient Claude Code OAuth if no API key is set).
 *
 * Run (after `npm run build`):
 *   node dist/intelligence/momentum-demo.js
 *
 * Env overrides:
 *   MOMENTUM_DURATION_SECONDS   how long to run (default 40)
 *   MOMENTUM_THRESHOLD_CENTS    swing threshold in cents (default 10)
 *   MOMENTUM_MOCK_FILE          mock game JSON (default demo/vault_data)
 *   SPORTS_SKILLS_SRC           PYTHONPATH for sports_skills (default ../sports-skills/src)
 *   SPORTSCLAW_PROVIDER / SPORTSCLAW_MODEL   LLM provider/model
 */

import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { MomentumExplainer } from "./momentum-explainer.js";
import type { LLMProvider } from "../types.js";

const HERE = dirname(fileURLToPath(import.meta.url)); // dist/intelligence
const REPO_ROOT = resolve(HERE, "..", ".."); // <sportsclaw>

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

async function main(): Promise<void> {
  const mockFile =
    process.env.MOMENTUM_MOCK_FILE ??
    join(REPO_ROOT, "demo", "vault_data", "mock_game.json");
  const sportsSkillsSrc =
    process.env.SPORTS_SKILLS_SRC ??
    resolve(REPO_ROOT, "..", "sports-skills", "src");

  if (!existsSync(mockFile)) {
    console.error(`[momentum-demo] mock file not found: ${mockFile}`);
    process.exit(1);
  }
  if (!existsSync(sportsSkillsSrc)) {
    console.error(
      `[momentum-demo] sports-skills src not found: ${sportsSkillsSrc}\n` +
        `Set SPORTS_SKILLS_SRC to the sports-skills 'src' directory.`,
    );
    process.exit(1);
  }

  const intervalSeconds = 5; // MUST match the mock file's tick interval
  const durationSeconds = envInt("MOMENTUM_DURATION_SECONDS", 40);
  const thresholdCents = envInt("MOMENTUM_THRESHOLD_CENTS", 10);
  const provider = (process.env.SPORTSCLAW_PROVIDER as LLMProvider) ?? "anthropic";

  console.log(
    `[momentum-demo] mock=${mockFile}\n` +
      `[momentum-demo] PYTHONPATH=${sportsSkillsSrc}\n` +
      `[momentum-demo] running ${durationSeconds}s @ ${intervalSeconds}s ticks ` +
      `(threshold ${thresholdCents}c)`,
  );

  // Phase 5 — evaluator on by default; MOMENTUM_EVALUATE=0 falls back to Phase 3.
  const evaluate = process.env.MOMENTUM_EVALUATE !== "0";
  const maxAttempts = envInt("MOMENTUM_MAX_ATTEMPTS", 2);

  const explainer = new MomentumExplainer({
    provider,
    model: process.env.SPORTSCLAW_MODEL,
    thresholdCents,
    mode: "mock",
    pythonPath: process.env.PYTHON_PATH ?? "python3",
    env: { PYTHONPATH: sportsSkillsSrc },
    verbose: true,
    evaluate,
    evaluatorModel: process.env.SPORTSCLAW_EVALUATOR_MODEL,
    maxAttempts,
  });

  explainer.start({
    sport: "markets",
    command: "get_mock_tick",
    args: { mock_file_path: mockFile, interval_seconds: intervalSeconds },
    intervalSeconds,
  });

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    console.log(
      `\n[momentum-demo] stopping — ${explainer.cardsEmitted} card(s) passed, ` +
        `${explainer.cardsRejected} held for review.`,
    );
    await explainer.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  setTimeout(shutdown, durationSeconds * 1000);
}

main().catch((err) => {
  console.error("[momentum-demo] fatal:", err);
  process.exit(1);
});
