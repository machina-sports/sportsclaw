/**
 * sportsclaw — Response Shape Templates
 *
 * Maps detected query intents to format hints injected into the system prompt.
 * No LLM calls — pure static configuration that shapes how the model formats responses.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type QueryIntent =
  | "live_scores"
  | "standings"
  | "schedule"
  | "odds"
  | "best_bets"
  | "player_stats"
  | "team_stats"
  | "news"
  | "roster"
  | "analysis"
  | "prediction"
  | "ambiguous";

interface ResponseTemplate {
  /** Injected into system prompt as a format directive */
  hint: string;
  /** Substrings to match against tool names (for evaluator) */
  expectedToolPatterns: string[];
  /** Keywords the response should contain for live data intents */
  requiredKeywords: string[];
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

const TEMPLATES: Record<QueryIntent, ResponseTemplate> = {
  live_scores: {
    hint: "Start with one useful observation from the returned scores, like a friend catching the user up, not a generic feed introduction. Then give one compact score-and-status line per game in the requested scope; never let a length cap silently omit games. Show actual points/goals and clock or final status, not win-loss records. State which sports/leagues are covered and any missing scores. Include odds only if the user asked for betting information in the current task; do not copy betting or standings metadata merely because the source returned it.",
    expectedToolPatterns: ["score", "live", "game"],
    requiredKeywords: [],
  },
  standings: {
    hint: "Show standings as a ranked list: position, team, W-L record, and one key stat (GB, PCT, or points). Highlight the user's team if in Fan Profile.",
    expectedToolPatterns: ["standing", "table", "rank"],
    requiredKeywords: [],
  },
  schedule: {
    hint: "Open with a useful observation about today's action rather than a generic feed introduction. For a today update, put live scores first, then finals and upcoming games as relevant; keep one compact matchup/score/status or local start-time line per game in the requested scope. Say which sports/leagues you checked and label partial coverage. Do not omit completed games when the user asks for today's results. Include odds only if the user asked for betting information in the current task; omit unasked team win-loss records and betting metadata.",
    expectedToolPatterns: ["schedule", "fixture", "game"],
    requiredKeywords: [],
  },
  odds: {
    hint: "Compare the same event/date, market, period, line and selection on every requested venue; if neither the request nor prior conversation specifies a market, start with the full-game moneyline and say so. Compact result first: one short line per venue with the exact quote and sign, price type (bid/ask/last) and quote time; say explicitly when a venue or its matching market is missing. No unrelated schedules or prop dumps. Convert odds only with the betting convert_odds or another calculation tool; if it is unavailable, keep the original quotes and omit derived odds.",
    expectedToolPatterns: ["odds", "bet", "line"],
    requiredKeywords: [],
  },
  best_bets: {
    hint: "Answer with the requested number of picks, normally one for a short follow-up. Keep the venue, market and candidate board established by the conversation; use that venue's current quote as the recommendation's primary price. Other venues may appear only as explicitly requested comparisons, not substitute selections. Give a qualified lean with its factual basis and relevant uncertainty. Do not claim a pricing edge without supporting evidence: a cheap contract, team record or point cushion alone does not establish mispricing. If the evidence cannot justify a pick, state the specific limitation without asking the user to repeat the known board.",
    expectedToolPatterns: ["odds", "bet", "stat", "form"],
    requiredKeywords: [],
  },
  player_stats: {
    hint: "Lead with player name + team. Show stats relevant to the query (season averages, recent game, career milestone). Cite the data source.",
    expectedToolPatterns: ["player", "stat", "athlete"],
    requiredKeywords: [],
  },
  team_stats: {
    hint: "Cover offense and defense with 2-3 key metrics each. Compare to league average where the data supports it.",
    expectedToolPatterns: ["team", "stat"],
    requiredKeywords: [],
  },
  news: {
    hint: "Bullet each story: '• [Headline] — [1-sentence context/impact]'. Most recent first. Include date for each item.",
    expectedToolPatterns: ["news", "article"],
    requiredKeywords: [],
  },
  roster: {
    hint: "Group by position. Name, number, and one key stat or note per player. Flag active injuries prominently.",
    expectedToolPatterns: ["roster", "player", "team"],
    requiredKeywords: [],
  },
  analysis: {
    hint: "Structure: situation → data → take. Back every claim with actual numbers from tools. End with a clear verdict on what was checked. For arbitrage, count only executable complementary prices on the same event and settlement terms, net of fees, with available size/liquidity and matching quote timestamps; anything else is an indicative spread, not a verified opportunity. If the scan is incomplete, report the checked scope only; never conclude that no risk-free arb exists anywhere. No allocation worksheet unless asked.",
    expectedToolPatterns: [],
    requiredKeywords: [],
  },
  prediction: {
    hint: "Give a clear pick with supporting data. State confidence (high/medium/low). Don't hedge — commit to a take and explain why.",
    expectedToolPatterns: [],
    requiredKeywords: [],
  },
  ambiguous: {
    hint: "",
    expectedToolPatterns: [],
    requiredKeywords: [],
  },
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export function getTemplate(intent: QueryIntent): ResponseTemplate {
  return TEMPLATES[intent] ?? TEMPLATES.ambiguous;
}

/**
 * Build the "## Response Shape" section injected into buildSystemPrompt().
 * Returns empty string for ambiguous intent (no hint to inject).
 */
export function buildTemplatePrompt(intent: QueryIntent): string {
  const t = getTemplate(intent);
  if (!t.hint) return "";
  return [
    "## Response Shape",
    "",
    `Detected query type: **${intent.replace(/_/g, " ")}**`,
    "Apply this shape only when consistent with the current request, retained conversation scope and available evidence. Do not add unrelated markets or fields.",
    "",
    t.hint,
  ].join("\n");
}
