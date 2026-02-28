/**
 * sportsclaw — News Normalizer
 *
 * Converts raw `sports-news` text outputs into strict `CoverageInsight`
 * JSON objects and publishes them to the relay `intel` channel.
 *
 * Input: unstructured text from the sports-news Python skill (RSS/Atom feeds,
 *        Google News scrapes, etc.)
 * Output: `CoverageInsight` matching the Machina Alpha Schema
 */

import type { CoverageInsight } from "../schema/machina.js";
import { relayManager } from "../relay.js";

// ---------------------------------------------------------------------------
// Tag extraction patterns
// ---------------------------------------------------------------------------

const TAG_PATTERNS: [string, RegExp][] = [
  ["injury", /\b(injur(?:y|ed|ies)|out\s+(?:for|with)|sidelined|hamstring|acl|concussion|day-to-day|questionable|doubtful|ruled out|ir\b)\b/i],
  ["transfer", /\b(transfer|sign(?:ed|ing|s)|trade(?:d|s)?|acquir(?:e|ed)|free agent|loan|waiv(?:e|ed|er)|release(?:d)?|cut\b|deal\b|swap)\b/i],
  ["matchup", /\b(matchup|head-to-head|h2h|face(?:s|d)?|clash|showdown|rivalry|versus|vs\.?)\b/i],
  ["preview", /\b(preview|upcoming|look ahead|what to expect|keys to the game|prediction)\b/i],
  ["recap", /\b(recap|result|final score|post-?game|wrap-?up|highlights|summary)\b/i],
  ["trend", /\b(trend(?:ing)?|streak|form|run of|consecutive|winning streak|losing streak|momentum)\b/i],
  ["ranking", /\b(rank(?:ing|ed|s)?|power ranking|top \d+|standings|playoff|seeding|bracket)\b/i],
  ["breaking", /\b(breaking|just in|report(?:ed|s)?|sources? say|per\s+\w+|according to)\b/i],
];

// ---------------------------------------------------------------------------
// Sport detection from text (lightweight, for tagging)
// ---------------------------------------------------------------------------

const SPORT_TAG_PATTERNS: [string, RegExp][] = [
  ["nba", /\b(nba|lakers|celtics|warriors|bucks|heat|knicks|76ers|nets|clippers|cavaliers|bulls|mavericks|nuggets|suns)\b/i],
  ["nfl", /\b(nfl|chiefs|eagles|cowboys|49ers|packers|ravens|bills|bengals|dolphins|lions|super ?bowl)\b/i],
  ["mlb", /\b(mlb|yankees|dodgers|astros|braves|mets|phillies|padres|baseball|world series)\b/i],
  ["nhl", /\b(nhl|avalanche|bruins|canadiens|oilers|penguins|lightning|hockey|stanley cup)\b/i],
  ["football", /\b(premier league|la liga|bundesliga|serie a|ligue 1|mls|champions league|soccer|f[uú]tbol)\b/i],
  ["tennis", /\b(tennis|atp|wta|wimbledon|french open|australian open|us open)\b/i],
  ["golf", /\b(golf|pga|lpga|masters|the open championship)\b/i],
  ["f1", /\b(formula ?1|f1|grand prix)\b/i],
  ["wnba", /\b(wnba)\b/i],
  ["cfb", /\b(college football|cfb|ncaa football|heisman)\b/i],
  ["cbb", /\b(college basketball|cbb|march madness|final four)\b/i],
];

function detectSportFromText(text: string): string {
  for (const [sport, pattern] of SPORT_TAG_PATTERNS) {
    if (pattern.test(text)) return sport;
  }
  return "general";
}

// ---------------------------------------------------------------------------
// Headline extraction
// ---------------------------------------------------------------------------

/**
 * Extract a headline from raw news text.
 * Tries: first line, first sentence, or truncated first 120 chars.
 */
function extractHeadline(text: string): string {
  const trimmed = text.trim();

  // First non-empty line
  const firstLine = trimmed.split("\n").find((l) => l.trim().length > 0);
  if (firstLine) {
    const clean = firstLine.replace(/^#+\s*/, "").replace(/^\*+\s*/, "").trim();
    if (clean.length > 0 && clean.length <= 200) return clean;
    if (clean.length > 200) return clean.slice(0, 197) + "...";
  }

  // First sentence
  const sentenceMatch = trimmed.match(/^(.+?[.!?])\s/);
  if (sentenceMatch && sentenceMatch[1].length <= 200) {
    return sentenceMatch[1];
  }

  // Fallback: truncate
  return trimmed.length > 120 ? trimmed.slice(0, 117) + "..." : trimmed;
}

// ---------------------------------------------------------------------------
// Tag extraction
// ---------------------------------------------------------------------------

function extractTags(text: string): string[] {
  const tags: string[] = [];
  for (const [tag, pattern] of TAG_PATTERNS) {
    if (pattern.test(text)) tags.push(tag);
  }
  // Also add the sport as a tag
  const sport = detectSportFromText(text);
  if (sport !== "general") tags.push(sport);
  return tags.length > 0 ? tags : ["news"];
}

// ---------------------------------------------------------------------------
// Confidence scoring
// ---------------------------------------------------------------------------

/**
 * Assign a confidence score based on content quality signals.
 * Higher scores for longer, more structured, and more detailed content.
 */
function scoreConfidence(text: string): number {
  let score = 0.3; // baseline

  // Length-based boost (more text = more substance)
  if (text.length > 500) score += 0.1;
  if (text.length > 1500) score += 0.1;

  // Structure signals (lists, headings, quotes)
  if (/^[-*]\s/m.test(text)) score += 0.05;
  if (/^#{1,3}\s/m.test(text)) score += 0.05;

  // Source attribution
  if (/\b(per|according to|sources?|report)\b/i.test(text)) score += 0.1;

  // Stat-based content
  if (/\d+(\.\d+)?%|\d+-\d+|\d+\.\d+ (ppg|rpg|apg|era|avg)/i.test(text)) score += 0.1;

  return Math.min(score, 1.0);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Normalize raw sports-news text into a strict `CoverageInsight` object.
 *
 * @param rawText  — Raw text output from the sports-news Python skill
 * @param gameId   — IPTC game ID (use "news-<hash>" for non-game articles)
 * @param source   — Source identifier (default: "sports-news")
 */
export function normalizeNews(
  rawText: string,
  gameId?: string,
  source?: string
): CoverageInsight {
  const text = rawText.trim();
  const sport = detectSportFromText(text);

  // Generate a stable game ID if not provided
  const resolvedGameId =
    gameId ?? `news-${hashCode(text).toString(36)}`;

  return {
    "@type": "machina:CoverageInsight",
    gameId: resolvedGameId,
    sport,
    headline: extractHeadline(text),
    body: text,
    confidence: scoreConfidence(text),
    tags: extractTags(text),
    source: source ?? "sports-news",
    createdAt: new Date().toISOString(),
  };
}

/**
 * Normalize raw news text and publish the resulting `CoverageInsight`
 * to the relay `intel` channel in a single call.
 *
 * @returns The published CoverageInsight for downstream use
 */
export async function publishNewsInsight(
  rawText: string,
  gameId?: string,
  source?: string
): Promise<CoverageInsight> {
  const insight = normalizeNews(rawText, gameId, source);
  await relayManager.publish("intel", insight);
  return insight;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Simple string hash for stable IDs (Java-style hashCode) */
function hashCode(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}
