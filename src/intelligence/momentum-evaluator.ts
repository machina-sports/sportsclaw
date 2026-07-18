/**
 * sportsclaw — Momentum Explainer, Phase 5: the generator/evaluator split.
 *
 * Phase 3 proved the loop can *generate* a Momentum Explainer card. But a
 * generator grading its own output is the "Nodding Loop" from the
 * loop-engineering write-up: the model that wrote the card is far too willing
 * to wave it through, so the loop accumulates plausible-looking mistakes at
 * machine speed and never once says "no".
 *
 * This module is the thing that can say no. It follows the note's recipe for
 * growing a loop's floor:
 *
 *   1. Separate generation from judgment STRUCTURALLY — the evaluator lives in
 *      its own module and never shares state with `generateCard`.
 *   2. Tune the evaluator into a SKEPTIC — it assumes the card is wrong until
 *      the plays prove it right.
 *   3. Make it verify by ACTING, not reading — it is handed the raw play
 *      window and re-derives the cause independently, rather than trusting the
 *      generator's framing.
 *   4. Hand the final say to a FRESH MODEL — the checker defaults to a
 *      *different* model from the generator (maker/checker, decades old in
 *      banking: whoever enters the large transfer cannot be the one who
 *      approves it).
 *
 * Two tiers, mirroring Stripe's Minions: deterministic gates own everything a
 * rule can decide (does the cited play actually exist in the window?), and the
 * probabilistic model is reserved for the semantic call (does the sentence's
 * causal claim hold, and does it invent nothing?). Anything a rule can settle
 * never goes to the model.
 */

import { generateText } from "ai";
import type { LLMProvider } from "../types.js";
import { DEFAULT_MODELS } from "../types.js";
import {
  resolveExplainerModel,
  type CardVerdict,
  type MomentumCard,
  type NormalizedPlay,
  type PriceSwing,
} from "./momentum-explainer.js";

// ---------------------------------------------------------------------------
// Config — the checker defaults to a DIFFERENT model than the generator
// ---------------------------------------------------------------------------

/**
 * Default evaluator model, per provider. For anthropic this is deliberately
 * NOT the generator default (`claude-opus-4-6`): a skeptic on Sonnet is the
 * maker/checker separation the loop-engineering note calls for, and the note's
 * point that "the final say goes to a fresh model" is only real if the checker
 * is a different model than the writer. Override via `evaluatorModel`.
 */
export const DEFAULT_EVALUATOR_MODELS: Record<LLMProvider, string> = {
  anthropic: "claude-sonnet-4-5-20250929",
  openai: DEFAULT_MODELS.openai,
  google: "gemini-3.5-flash",
};

export interface EvaluatorConfig {
  /** Provider for the checker model (default: anthropic). */
  provider?: LLMProvider;
  /** Checker model id (default: provider's skeptic, e.g. Claude Sonnet 4.5). */
  model?: string;
}

/** A resolved, ready-to-call evaluator (built once, reused per card). */
export interface ResolvedEvaluator {
  model: unknown;
  modelId: string;
  provider: LLMProvider;
}

/**
 * Resolve the evaluator model once, reusing the generator's auth precedence
 * (API key → opted-in Claude Code OAuth → ambient OAuth). Throws loudly at
 * construction if no credentials exist, rather than failing cryptically on the
 * first card.
 */
export function resolveEvaluator(cfg: EvaluatorConfig = {}): ResolvedEvaluator {
  const provider = cfg.provider ?? "anthropic";
  const modelId = cfg.model ?? DEFAULT_EVALUATOR_MODELS[provider];
  const model = resolveExplainerModel(provider, modelId);
  return { model, modelId, provider };
}

// ---------------------------------------------------------------------------
// Tier 1 — deterministic gates (no model). What a rule can decide, a rule does.
// ---------------------------------------------------------------------------

interface HardGates {
  hasCause: boolean;
  playInWindow: boolean;
  /** Reasons for any gate that failed (empty when both pass). */
  reasons: string[];
}

/**
 * Rule-solvable checks. These run before the model and can reject on their own:
 * a card that cites a play absent from the window is structurally wrong, and no
 * amount of fluent prose should rescue it.
 */
export function runHardGates(
  card: MomentumCard,
  plays: NormalizedPlay[],
): HardGates {
  const reasons: string[] = [];
  const cause = card.causePlay;
  const hasCause = cause !== null;
  if (!hasCause) {
    reasons.push("Card cites no cause play, so its attribution is unverifiable.");
  }

  let playInWindow = true;
  if (cause) {
    // Verify by acting on the data: the cited play must exist in the window,
    // matched by id when present, else by exact text.
    playInWindow = plays.some((p) =>
      (cause.id && p.id && p.id === cause.id) ||
      (!!cause.text && p.text === cause.text),
    );
    if (!playInWindow) {
      reasons.push(
        "Cited cause play is not present in the resolved play window " +
          "(the card attributes the move to a play the data does not contain).",
      );
    }
  }

  return { hasCause, playInWindow, reasons };
}

// ---------------------------------------------------------------------------
// Tier 2 — the LLM skeptic (semantic call only)
// ---------------------------------------------------------------------------

interface SemanticVerdict {
  claimSupported: boolean;
  noHallucination: boolean;
  directionCoherent: boolean;
  reasons: string[];
}

/** Extract the first JSON object from a model response, defensively. */
function parseFirstJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function renderWindow(plays: NormalizedPlay[]): string {
  if (plays.length === 0) return "(no plays in window)";
  return plays
    .map(
      (p, i) =>
        `  ${i + 1}. [${p.type || "play"}] "${p.text}" ` +
        `(clock ${p.gameClock || "?"}, score home ${p.homeScore}-${p.awayScore} away` +
        `${p.scoring ? ", SCORING" : ""})`,
    )
    .join("\n");
}

/**
 * The skeptic. It is handed the raw play window and the exact price numbers and
 * asked to judge the card independently, assuming it is wrong until the data
 * proves otherwise. Returns three booleans and reasons. A parse failure is
 * treated as a rejection — an evaluator that cannot make itself understood does
 * not get to wave a card through.
 */
async function judgeCard(
  evaluator: ResolvedEvaluator,
  card: MomentumCard,
  plays: NormalizedPlay[],
  swing: PriceSwing,
): Promise<SemanticVerdict> {
  const dir = swing.delta > 0 ? "UP" : "DOWN";
  const pts = Math.abs(swing.delta);

  // gameLabel is "AWAY @ HOME"; give the checker the home/away reference frame so
  // it can map the window's "score home X-away Y" onto the named teams. Without
  // this it cannot verify (nor pass) any card that names the leading team.
  const [awayTeam, homeTeam] = card.gameLabel.split(" @ ");

  const system = [
    "You are a SKEPTICAL reviewer auditing a sports betting-market 'Momentum",
    "Explainer' card written by another model. Assume the card is WRONG until",
    "the play-by-play window proves it right. You are the check that can say no.",
    "Judge only against the plays given; do not use outside knowledge of the game.",
    "Reject ONLY for factual failures: a causal claim the window does not",
    "support, invented players/plays/events, or a direction mismatch. Do NOT",
    "reject over phrasing, tone, or word choice (e.g. 'extends the lead to 2-0'",
    "vs 'takes a 2-0 lead') when the underlying facts are correct.",
    "Respond with ONLY a JSON object, no prose, of the exact form:",
    '{"claimSupported": bool, "noHallucination": bool, "directionCoherent": bool, "reasons": [string]}',
    "  - claimSupported: the card attributes the price move to a play that is",
    "    genuinely the most plausible cause among those in the window.",
    "  - noHallucination: the card states no player, play, or fact absent from",
    "    the window. The HOME/AWAY team names given below are known ground truth,",
    "    so naming them (and reading the window's 'score home X-away Y' as those",
    "    teams) is NOT a hallucination.",
    "  - directionCoherent: the described effect matches the price direction",
    "    (a home-favorable play should move the HOME price UP, and vice-versa).",
    "  - reasons: one reason per failed check, each under 25 words; empty array",
    "    if all pass.",
  ].join("\n");

  const prompt = [
    `HOME team = ${homeTeam ?? "?"}, AWAY team = ${awayTeam ?? "?"} ` +
      `(the window's "score home X-away Y" refers to these teams).`,
    `Home win-probability price moved ${swing.before}c -> ${swing.after}c ` +
      `(${dir} ${pts} points).`,
    "",
    "Play-by-play window (independently determine the true cause from this):",
    renderWindow(plays),
    "",
    `Card under review: "${card.text}"`,
    `Card claims the cause was: ${card.causePlay ? `"${card.causePlay.text}"` : "(none)"}`,
    "",
    "Audit the card now. Output only the JSON verdict.",
  ].join("\n");

  // Generous budget: a truncated verdict is unparseable and fails closed,
  // which rejects good cards for the wrong reason (seen live 2026-07-17).
  const result = await generateText({
    model: evaluator.model as Parameters<typeof generateText>[0]["model"],
    system,
    prompt,
    maxOutputTokens: 1000,
  });

  const parsed = parseFirstJsonObject(result.text);
  if (!parsed) {
    // Fail closed, but keep a snippet of what the checker actually said so a
    // recurring parse failure is diagnosable from the rejection log.
    const snippet = result.text.trim().slice(0, 120) || "(empty response)";
    return {
      claimSupported: false,
      noHallucination: false,
      directionCoherent: false,
      reasons: [`Evaluator returned no parseable verdict; failing closed. Raw: ${snippet}`],
    };
  }

  const asBool = (v: unknown): boolean => v === true;
  const reasons = Array.isArray(parsed.reasons)
    ? parsed.reasons.filter((r): r is string => typeof r === "string")
    : [];

  return {
    claimSupported: asBool(parsed.claimSupported),
    noHallucination: asBool(parsed.noHallucination),
    directionCoherent: asBool(parsed.directionCoherent),
    reasons,
  };
}

// ---------------------------------------------------------------------------
// evaluateCard — combine both tiers into one verdict
// ---------------------------------------------------------------------------

/**
 * Judge one card. Runs deterministic gates first; if a rule-solvable check
 * fails, rejects WITHOUT spending a model call (the semantic checks are
 * reported as false, since an unverifiable card cannot be semantically sound).
 * Otherwise it hands the semantic call to the fresh checker model.
 *
 * A card ships ("pass") only if every check holds. `attempt` (1-based) is
 * stamped onto the verdict so the caller's retry budget is auditable.
 */
export async function evaluateCard(
  evaluator: ResolvedEvaluator,
  card: MomentumCard,
  plays: NormalizedPlay[],
  swing: PriceSwing,
  attempt: number,
): Promise<CardVerdict> {
  const gates = runHardGates(card, plays);

  if (!gates.hasCause || !gates.playInWindow) {
    return {
      verdict: "reject",
      reasons: gates.reasons,
      checks: {
        playInWindow: gates.playInWindow,
        hasCause: gates.hasCause,
        claimSupported: false,
        noHallucination: false,
        directionCoherent: false,
      },
      evaluatorModel: evaluator.modelId,
      attempts: attempt,
    };
  }

  const semantic = await judgeCard(evaluator, card, plays, swing);
  const pass =
    semantic.claimSupported &&
    semantic.noHallucination &&
    semantic.directionCoherent;

  return {
    verdict: pass ? "pass" : "reject",
    reasons: pass ? [] : semantic.reasons,
    checks: {
      playInWindow: gates.playInWindow,
      hasCause: gates.hasCause,
      claimSupported: semantic.claimSupported,
      noHallucination: semantic.noHallucination,
      directionCoherent: semantic.directionCoherent,
    },
    evaluatorModel: evaluator.modelId,
    attempts: attempt,
  };
}
