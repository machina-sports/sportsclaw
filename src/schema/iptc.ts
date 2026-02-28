/**
 * sportsclaw — IPTC Sport Schema (Semantic Web / JSON-LD)
 *
 * Pure interfaces modeled on the IPTC SportsML / NewsML-G2 sport ontology.
 * Uses JSON-LD conventions (@id, @type, @context) and IPTC controlled
 * vocabulary URNs (urn:iptc:sport:*, cv.iptc.org newscodes).
 *
 * This module contains ONLY standard IPTC types — no proprietary extensions.
 * For Machina Sports AI extensions (win probability, market odds, predictions,
 * coverage insights), see ./machina-alpha.ts.
 *
 * @see https://iptc.org/standards/sportsml/
 * @see https://cv.iptc.org/newscodes/sport/
 */

// ---------------------------------------------------------------------------
// JSON-LD Context
// ---------------------------------------------------------------------------

export interface IPTCContext {
  "@vocab": "http://iptc.org/std/nar/2006-10-01/";
  sport: "http://cv.iptc.org/newscodes/sport/";
  spstat: "http://cv.iptc.org/newscodes/spstattype/";
}

export const IPTC_CONTEXT: IPTCContext = {
  "@vocab": "http://iptc.org/std/nar/2006-10-01/",
  sport: "http://cv.iptc.org/newscodes/sport/",
  spstat: "http://cv.iptc.org/newscodes/spstattype/",
};

// ---------------------------------------------------------------------------
// Base JSON-LD entity
// ---------------------------------------------------------------------------

export interface IPTCEntity {
  /** Unique resource identifier (URN or IRI) */
  "@id": string;
  /** RDF type from the IPTC sport vocabulary */
  "@type": string;
}

// ---------------------------------------------------------------------------
// Sport discipline (basketball, football, baseball, etc.)
// ---------------------------------------------------------------------------

export interface IPTCSportDiscipline extends IPTCEntity {
  "@type": "sport:SportDiscipline";
  /** Human-readable name (e.g. "Basketball", "Ice Hockey") */
  "sport:name": string;
  /** Machine code matching sportsclaw sport key (e.g. "nba", "nfl") */
  "sport:code": string;
}

// ---------------------------------------------------------------------------
// Competitor (team or individual)
// ---------------------------------------------------------------------------

export interface IPTCCompetitor extends IPTCEntity {
  "@type": "sport:Competitor";
  /** Full team/player name */
  "sport:name": string;
  /** Short abbreviation (e.g. "LAL", "BOS") */
  "sport:code": string;
  /** Designator within the event */
  "sport:alignment": "home" | "away";
  /** Team/player logo URL */
  "sport:logo"?: string;
  /** Current aggregate score */
  "spstat:score"?: number;
  /** Period-by-period breakdown (quarters, innings, sets, etc.) */
  "spstat:periodScore"?: number[];
}

// ---------------------------------------------------------------------------
// Venue
// ---------------------------------------------------------------------------

export interface IPTCVenue extends IPTCEntity {
  "@type": "sport:Venue";
  "sport:name": string;
}

// ---------------------------------------------------------------------------
// Event status — IPTC controlled vocabulary URNs
// ---------------------------------------------------------------------------

export type IPTCEventStatus =
  | "urn:iptc:sport:event-status:scheduled"
  | "urn:iptc:sport:event-status:in-progress"
  | "urn:iptc:sport:event-status:halftime"
  | "urn:iptc:sport:event-status:final"
  | "urn:iptc:sport:event-status:delayed"
  | "urn:iptc:sport:event-status:postponed";

// ---------------------------------------------------------------------------
// IPTCSportEvent — the canonical event payload
// ---------------------------------------------------------------------------

export interface IPTCSportEvent extends IPTCEntity {
  "@context": IPTCContext;
  "@type": "sport:SportEvent";

  // ---- IPTC core fields ----

  "sport:discipline": IPTCSportDiscipline;
  "sport:eventStatus": IPTCEventStatus;
  /** Human-readable status line: "4th 2:31", "TOP 7th", "2nd Half 67'" */
  "sport:statusDetail": string;
  /** Game clock or period indicator */
  "sport:clock"?: string;
  /** [home, away] competitors */
  "sport:competitor": [IPTCCompetitor, IPTCCompetitor];
  "sport:venue"?: IPTCVenue;
  /** ISO scheduled start date */
  "sport:startDate"?: string;
  /** ISO timestamp of last data refresh */
  "sport:lastUpdated": string;
}

// ---------------------------------------------------------------------------
// Relay envelope — wraps IPTCSportEvent for pub/sub transport
// ---------------------------------------------------------------------------

export type IPTCEventType =
  | "GAME_UPDATE"
  | "GAME_START"
  | "GAME_END"
  | "SCORE_CHANGE"
  | "STATUS_CHANGE";

export interface IPTCSportEventEnvelope {
  event: IPTCEventType;
  data: IPTCSportEvent;
  /** What changed from the previous state (for presenters to highlight) */
  delta?: {
    homeScoreDelta?: number;
    awayScoreDelta?: number;
    previousStatus?: IPTCEventStatus;
  };
  /** ISO timestamp of emission */
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Helpers — status mapping
// ---------------------------------------------------------------------------

/** Simple status label used internally before IPTC migration */
export type LegacyGameStatus =
  | "scheduled"
  | "in_progress"
  | "halftime"
  | "final"
  | "delayed"
  | "postponed";

const STATUS_TO_IPTC: Record<LegacyGameStatus, IPTCEventStatus> = {
  scheduled: "urn:iptc:sport:event-status:scheduled",
  in_progress: "urn:iptc:sport:event-status:in-progress",
  halftime: "urn:iptc:sport:event-status:halftime",
  final: "urn:iptc:sport:event-status:final",
  delayed: "urn:iptc:sport:event-status:delayed",
  postponed: "urn:iptc:sport:event-status:postponed",
};

const IPTC_TO_STATUS: Record<IPTCEventStatus, LegacyGameStatus> = {
  "urn:iptc:sport:event-status:scheduled": "scheduled",
  "urn:iptc:sport:event-status:in-progress": "in_progress",
  "urn:iptc:sport:event-status:halftime": "halftime",
  "urn:iptc:sport:event-status:final": "final",
  "urn:iptc:sport:event-status:delayed": "delayed",
  "urn:iptc:sport:event-status:postponed": "postponed",
};

/** Convert a legacy status string to an IPTC event-status URN */
export function toIPTCStatus(status: LegacyGameStatus): IPTCEventStatus {
  return STATUS_TO_IPTC[status];
}

/** Extract the simple status label from an IPTC event-status URN */
export function fromIPTCStatus(urn: IPTCEventStatus): LegacyGameStatus {
  return IPTC_TO_STATUS[urn];
}

// ---------------------------------------------------------------------------
// Helpers — discipline lookup
// ---------------------------------------------------------------------------

/** Human-readable discipline names keyed by sportsclaw sport code */
const DISCIPLINE_NAMES: Record<string, string> = {
  nfl: "American Football",
  nba: "Basketball",
  mlb: "Baseball",
  nhl: "Ice Hockey",
  wnba: "Basketball",
  cfb: "American Football",
  cbb: "Basketball",
  soccer: "Football",
  football: "Football",
  tennis: "Tennis",
  golf: "Golf",
  f1: "Formula 1",
};

/** Build an IPTCSportDiscipline from a sportsclaw sport code */
export function toIPTCDiscipline(sportCode: string): IPTCSportDiscipline {
  return {
    "@id": `urn:iptc:sport:discipline:${sportCode}`,
    "@type": "sport:SportDiscipline",
    "sport:name": DISCIPLINE_NAMES[sportCode] ?? sportCode,
    "sport:code": sportCode,
  };
}

// ---------------------------------------------------------------------------
// Helpers — data extraction (convenience for presenters)
// ---------------------------------------------------------------------------

/** Extract the game ID (last segment of the @id URN) */
export function iptcGameId(event: IPTCSportEvent): string {
  const segments = event["@id"].split(":");
  return segments[segments.length - 1];
}

/** Extract the sport code from the discipline */
export function iptcSportCode(event: IPTCSportEvent): string {
  return event["sport:discipline"]["sport:code"];
}

/** Get the home competitor (index 0 by convention) */
export function iptcHome(event: IPTCSportEvent): IPTCCompetitor {
  return event["sport:competitor"][0];
}

/** Get the away competitor (index 1 by convention) */
export function iptcAway(event: IPTCSportEvent): IPTCCompetitor {
  return event["sport:competitor"][1];
}

/** Get the simple status label */
export function iptcStatus(event: IPTCSportEvent): LegacyGameStatus {
  return fromIPTCStatus(event["sport:eventStatus"]);
}
