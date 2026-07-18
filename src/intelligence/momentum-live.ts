/**
 * sportsclaw — Momentum Explainer live runner
 *
 * Boots the real WatchManager against a LIVE, in-progress game: the watcher
 * polls the `get_live_tick` Kalshi price feed, and when the home win-probability
 * swings past the threshold the explainer resolves the play (real ESPN
 * play-by-play via `get_plays_near_timestamp`), a real LLM writes the card, and
 * the independent evaluator checks it before it ships. Same pipeline as the
 * demo — only the price source and play source are live.
 *
 * Run (after `npm run build`):
 *   MOMENTUM_SPORT=nfl MOMENTUM_EVENT_ID=401547439 \
 *     SPORTS_SKILLS_SRC=../sports-skills/src node dist/intelligence/momentum-live.js
 *   # or: node dist/intelligence/momentum-live.js <sport> <event_id>
 *
 * Env overrides:
 *   MOMENTUM_SPORT / MOMENTUM_EVENT_ID   the live game (required; or argv[0/1])
 *   MOMENTUM_DURATION_SECONDS   how long to run (default 300)
 *   MOMENTUM_INTERVAL_SECONDS   price poll interval (default 30)
 *   MOMENTUM_THRESHOLD_CENTS    swing threshold in cents (default 10)
 *   SPORTS_SKILLS_SRC           PYTHONPATH for sports_skills (default ../sports-skills/src)
 *   SPORTSCLAW_PROVIDER / SPORTSCLAW_MODEL   LLM provider/model
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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

/**
 * The macOS cert fix: Python's urllib doesn't trust the system keychain, so a
 * live HTTPS fetch to ESPN/Kalshi fails with a cert error unless SSL_CERT_FILE
 * points at certifi's bundle. Compute it once and thread it into the subprocess
 * env, alongside PYTHONPATH.
 */
function certifiPath(pythonPath: string): string | undefined {
  try {
    return execSync(`${pythonPath} -c "import certifi; print(certifi.where())"`, {
      encoding: "utf8",
    }).trim();
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  const sport = (process.env.MOMENTUM_SPORT ?? process.argv[2] ?? "").toLowerCase();
  const eventId = process.env.MOMENTUM_EVENT_ID ?? process.argv[3] ?? "";

  if (!sport || !eventId) {
    console.error(
      "[momentum-live] MOMENTUM_SPORT and MOMENTUM_EVENT_ID are required.\n" +
        "  MOMENTUM_SPORT=nfl MOMENTUM_EVENT_ID=<espn event id> " +
        "node dist/intelligence/momentum-live.js\n" +
        "  (or: node dist/intelligence/momentum-live.js <sport> <event_id>)",
    );
    process.exit(1);
  }

  const sportsSkillsSrc =
    process.env.SPORTS_SKILLS_SRC ??
    resolve(REPO_ROOT, "..", "sports-skills", "src");
  if (!existsSync(sportsSkillsSrc)) {
    console.error(
      `[momentum-live] sports-skills src not found: ${sportsSkillsSrc}\n` +
        `Set SPORTS_SKILLS_SRC to the sports-skills 'src' directory.`,
    );
    process.exit(1);
  }

  const pythonPath = process.env.PYTHON_PATH ?? "python3";
  const intervalSeconds = envInt("MOMENTUM_INTERVAL_SECONDS", 30);
  const durationSeconds = envInt("MOMENTUM_DURATION_SECONDS", 300);
  const thresholdCents = envInt("MOMENTUM_THRESHOLD_CENTS", 10);
  const provider = (process.env.SPORTSCLAW_PROVIDER as LLMProvider) ?? "anthropic";

  // Live feeds hit ESPN/Kalshi over HTTPS from the Python subprocess — set the
  // macOS cert fix so both the price feed and the play fetch succeed.
  const sslCertFile = certifiPath(pythonPath);
  const env: Record<string, string> = { PYTHONPATH: sportsSkillsSrc };
  if (sslCertFile) env.SSL_CERT_FILE = sslCertFile;

  console.log(
    `[momentum-live] game=${sport}:${eventId}\n` +
      `[momentum-live] PYTHONPATH=${sportsSkillsSrc}\n` +
      `[momentum-live] SSL_CERT_FILE=${sslCertFile ?? "(unset — certifi not found)"}\n` +
      `[momentum-live] running ${durationSeconds}s @ ${intervalSeconds}s polls ` +
      `(threshold ${thresholdCents}c)`,
  );

  // Evaluator on by default (same as the demo); MOMENTUM_EVALUATE=0 → Phase 3.
  const evaluate = process.env.MOMENTUM_EVALUATE !== "0";
  const maxAttempts = envInt("MOMENTUM_MAX_ATTEMPTS", 2);

  const explainer = new MomentumExplainer({
    provider,
    model: process.env.SPORTSCLAW_MODEL,
    thresholdCents,
    mode: "live",
    direction: "both", // down-swings are real momentum events live
    pythonPath,
    env,
    verbose: true,
    evaluate,
    evaluatorModel: process.env.SPORTSCLAW_EVALUATOR_MODEL,
    maxAttempts,
  });

  explainer.start({
    sport: "markets",
    command: "get_live_tick",
    args: { sport, event_id: eventId },
    intervalSeconds,
  });

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    console.log(
      `\n[momentum-live] stopping — ${explainer.cardsEmitted} card(s) passed, ` +
        `${explainer.cardsRejected} held for review.`,
    );
    await explainer.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  setTimeout(shutdown, durationSeconds * 1000);
}

main().catch((err) => {
  console.error("[momentum-live] fatal:", err);
  process.exit(1);
});
