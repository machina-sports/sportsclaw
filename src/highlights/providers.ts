/**
 * Provider payload normalization for the highlights core (86ak32k1w).
 *
 * The core's HighlightsRequest takes typed PBPAction[] — this module turns
 * RAW provider payloads into that shape so the same workflow source accepts
 * canonical/PBP fixtures from more than one provider (spec DoD). Nothing
 * here synthesizes events: unknown shapes return an empty array and the
 * caller fails closed upstream (planCandidateWindows requires actions).
 *
 * Supported payload shapes (auto-detected, or forced via `provider`):
 *   espn      — { plays: [{ id, type:{text}, text, clock:{displayValue},
 *               period:{number} }] } as returned by sports-skills
 *               `playbyplay` (possibly nested under a `data` wrapper).
 *   canonical — { events: [{ id, type, description|text,
 *               match_time|clock: "MM:SS", period }] } — the provider-native
 *               canonical feed shape used by the Broadcast AI seam.
 */

import { SUPPORTED_CLOCK_SEMANTICS, type PBPAction } from "./types.js";

/** Deterministic editorial importance per normalized action type. */
const TYPE_IMPORTANCE: Record<string, number> = {
  goal: 100,
  penalty: 90,
  "red-card": 85,
  var: 70,
  "shot-on-target": 60,
  chance: 55,
  "yellow-card": 50,
  substitution: 15,
  other: 20,
};

/** Normalize a raw provider type/description pair into one action type. */
export function classifyActionType(rawType: string, rawText: string): string {
  const t = `${rawType} ${rawText}`.toLowerCase();
  if (/(^|\W)(goal|gol|golo)(\W|$)/.test(t) && !/own goal disallowed|no goal/.test(t)) return "goal";
  if (/penalty (kick|awarded|scored)|pênalti|penalti/.test(t)) return "penalty";
  if (/red card|cartão vermelho|second yellow/.test(t)) return "red-card";
  if (/\bvar\b|video assistant/.test(t)) return "var";
  if (/shot on target|on goal|saved|defesa/.test(t)) return "shot-on-target";
  if (/attempt|shot|chance|close|post|crossbar|trave/.test(t)) return "chance";
  if (/yellow card|cartão amarelo|booking/.test(t)) return "yellow-card";
  if (/substitution|substituição/.test(t)) return "substitution";
  return "other";
}

export function importanceOfType(type: string): number {
  return TYPE_IMPORTANCE[type] ?? TYPE_IMPORTANCE.other;
}

/** "45", "45:30", "45'+2", "05:10" → seconds shown on the clock. */
function clockStringToSec(raw: string): number {
  const plus = raw.match(/^(\d+)'?\s*\+\s*(\d+)/);
  if (plus) return (Number(plus[1]) + Number(plus[2])) * 60;
  const mmss = raw.match(/^(\d+):(\d{1,2})/);
  if (mmss) return Number(mmss[1]) * 60 + Number(mmss[2]);
  const mmOnly = raw.match(/^(\d+)'?$/);
  if (mmOnly) return Number(mmOnly[1]) * 60;
  return 0;
}

/**
 * Clock seconds → elapsed-ascending seconds. ESPN soccer clocks are already
 * absolute across periods ("52:10" in period 2); per-period clocks
 * (canonical "07:10" in period 2) get the elapsed periods added.
 */
export function toElapsedSec(clockSec: number, period: number, periodMinutes = 45): number {
  const periodBase = (period - 1) * periodMinutes * 60;
  return clockSec >= periodBase ? clockSec : periodBase + clockSec;
}

export interface NormalizeOptions {
  /** Force a shape instead of auto-detecting. */
  provider?: "espn" | "canonical";
  /** Regulation minutes per period for per-period → elapsed lifting. */
  periodMinutes?: number;
  /** Provenance string recorded on every action (feed name / capture ref). */
  provenance?: string;
}

/** Parse a raw provider PBP payload into typed PBPAction[]. */
export function normalizeProviderPayload(
  payload: unknown,
  opts: NormalizeOptions = {},
): PBPAction[] {
  if (payload == null || typeof payload !== "object") return [];
  let root = payload as Record<string, unknown>;
  if (root.data && typeof root.data === "object" && !Array.isArray(root.data)) {
    root = root.data as Record<string, unknown>; // sports-skills bridge wrapper
  }

  const detected: "espn" | "canonical" | undefined =
    opts.provider ??
    (Array.isArray(root.plays) ? "espn" : Array.isArray(root.events) ? "canonical" : undefined);
  const periodMinutes = opts.periodMinutes ?? 45;

  if (detected === "espn" && Array.isArray(root.plays)) {
    const provenance = opts.provenance ?? "espn:sports-skills playbyplay";
    return (root.plays as Array<Record<string, unknown>>).map((pl, i) => {
      const typeObj = (pl.type ?? {}) as Record<string, unknown>;
      const clockObj = (pl.clock ?? {}) as Record<string, unknown>;
      const periodObj = (pl.period ?? {}) as Record<string, unknown>;
      const text = String(pl.text ?? typeObj.text ?? "event");
      const period = Number(periodObj.number ?? 1) || 1;
      const type = classifyActionType(String(typeObj.text ?? ""), text);
      const clockSec = clockStringToSec(String(clockObj.displayValue ?? "0:00").replace(/'/g, ""));
      return {
        actionId: String(pl.id ?? `espn-${i}`),
        provider: "espn",
        period,
        clock: {
          semantics: SUPPORTED_CLOCK_SEMANTICS,
          elapsedSec: toElapsedSec(clockSec, period, periodMinutes),
        },
        label: text,
        type,
        importance: importanceOfType(type),
        provenance,
      };
    });
  }

  if (detected === "canonical" && Array.isArray(root.events)) {
    const provenance = opts.provenance ?? "canonical:provider-native feed";
    return (root.events as Array<Record<string, unknown>>).map((ev, i) => {
      const text = String(ev.description ?? ev.text ?? "event");
      const period = Number(ev.period ?? 1) || 1;
      const type = classifyActionType(String(ev.type ?? ""), text);
      const clockSec = clockStringToSec(String(ev.match_time ?? ev.clock ?? "0:00"));
      return {
        actionId: String(ev.id ?? `canonical-${i}`),
        provider: "canonical",
        period,
        clock: {
          semantics: SUPPORTED_CLOCK_SEMANTICS,
          elapsedSec: toElapsedSec(clockSec, period, periodMinutes),
        },
        label: text,
        type,
        importance: importanceOfType(type),
        provenance,
      };
    });
  }

  return [];
}

/** Map a free-text highlight intent onto the action types it asks for. */
export function intentToActionTypes(intent: string): string[] | "all" {
  const t = intent.toLowerCase();
  const types = new Set<string>();
  if (/goal|gol|golo|score/.test(t)) types.add("goal").add("penalty");
  if (/penalty|pênalti|penalti/.test(t)) types.add("penalty");
  // Card precedence: an explicit color narrows the type; only the generic
  // "cards" asks for both.
  if (/red card|expuls|vermelho/.test(t)) types.add("red-card");
  else if (/yellow|amarelo/.test(t)) types.add("yellow-card");
  else if (/card|cartão/.test(t)) types.add("yellow-card").add("red-card");
  if (/\bvar\b/.test(t)) types.add("var");
  if (/chance|shot|attempt|finaliza|perigo/.test(t)) types.add("chance").add("shot-on-target");
  if (types.size === 0) return "all";
  return [...types];
}

/**
 * Filter normalized actions by intent before building a HighlightsRequest.
 * "all" keeps actions with importance ≥ 50 (editorially relevant baseline).
 */
export function filterActionsByIntent(actions: PBPAction[], intent: string): PBPAction[] {
  const wanted = intentToActionTypes(intent);
  const filtered =
    wanted === "all"
      ? actions.filter((a) => (a.importance ?? importanceOfType(a.type)) >= 50)
      : actions.filter((a) => wanted.includes(a.type));
  return filtered
    .slice()
    .sort((a, b) => a.clock.elapsedSec - b.clock.elapsedSec);
}
