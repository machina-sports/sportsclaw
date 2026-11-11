/**
 * sportsclaw — reader for the Machina Sports Schema envelope.
 *
 * The schema is owned by machina-templates (tools/iptc/canonical) and produced by
 * sports-skills (`--format machina-canonical`, `sports_skills.canonical`). This module
 * only READS the envelope a producer wrote:
 *
 *   { "machina_sports_schema": { schema_version, profile, sport_schema_graph,
 *     event_view, provenance, provider_ids, capabilities, rights } }
 *
 * It never computes a schema id, maps a status or decides who may use the data: those
 * rules live with the schema, and a second copy here would be a second definition of
 * one contract. Values come back exactly as the envelope states them (a score is the
 * text "101", a status is "closed"), and the rights block is passed on for the caller
 * to respect.
 *
 * `src/schema/iptc.ts` and `src/schema/machina.ts` are older types for the relay's
 * live-game channels. They are not this schema and use different names for things.
 */

/** The single top-level key of an envelope. */
export const MACHINA_SPORTS_SCHEMA_KEY = "machina_sports_schema";

/**
 * Envelope versions this reader was checked against, with real envelopes. Any other
 * version is refused: add one here together with a fixture the schema's own code produced.
 */
export const MACHINA_SPORTS_SCHEMA_VERSIONS = ["machina-sports-schema/1"] as const;

/** A schema id: `urn:machina:sports:<kind>:x<32 hex>`. Opaque here: read, compared and stored, never built. */
const MACHINA_ID = /^urn:machina:sports:([a-z][a-z-]*):x[0-9a-f]{32}$/;

/** The kind named in a schema id ("event", "team", "action", ...), or undefined when it is not one. */
export function machinaIdKind(id: unknown): string | undefined {
  return typeof id === "string" ? MACHINA_ID.exec(id)?.[1] : undefined;
}

/** A named thing the event belongs to: its competition, season, phase or site. */
export interface MachinaRef {
  id: string;
  name?: string;
}

/** A team in the event. `role` is its alignment ("home", "away"). */
export interface MachinaParticipant {
  id: string;
  role?: string;
  name?: string;
  score?: string;
  outcome?: string;
}

/** One play-by-play action. `id` is set when the envelope's graph carries the action. */
export interface MachinaAction {
  id?: string;
  /** The provider's sequence value for the action; with the event id it names the action even without `id`. */
  ordinal: string;
  class?: string;
  label?: string;
  /** The game clock as the provider wrote it ("11:35", "7.1", "67"). */
  minute?: string;
  period?: string;
  time?: string;
}

/** Who may use the data, as the producer stated it. This reader passes it on and decides nothing. */
export interface MachinaRights {
  dataClass: string;
  prototypeOnly: boolean;
  commercialUse: boolean;
}

/** One event as its envelope states it. */
export interface MachinaSportsEvent {
  schemaVersion: string;
  profile: string;
  eventId: string;
  label?: string;
  sport?: string;
  status?: string;
  startTime?: string;
  endTime?: string;
  clock?: { minute?: string; period?: string };
  competition?: MachinaRef;
  season?: MachinaRef;
  phase?: MachinaRef;
  site?: MachinaRef;
  participants: MachinaParticipant[];
  actions: MachinaAction[];
  provider: { namespace: string; family?: string };
  observedAt?: string;
  rights: MachinaRights;
}

type Row = Record<string, unknown>;
const isRow = (value: unknown): value is Row => typeof value === "object" && value !== null && !Array.isArray(value);

/** Signals a member that is present but not in the shape the schema writes. */
const INVALID = Symbol("invalid");

/** The envelope writes every scalar as text: absent stays absent, anything else is invalid. */
function text(value: unknown): string | undefined | typeof INVALID {
  return value === undefined ? undefined : typeof value === "string" ? value : INVALID;
}

/** `{name: value}` for the members that are present; INVALID when any is not text. */
function texts<K extends string>(row: Row, names: readonly [string, K][]): Partial<Record<K, string>> | typeof INVALID {
  const out: Partial<Record<K, string>> = {};
  for (const [from, to] of names) {
    const value = text(row[from]);
    if (value === INVALID) return INVALID;
    if (value !== undefined) out[to] = value;
  }
  return out;
}

/** An `{id, name}` block of the given id kind; undefined when absent, INVALID when malformed. */
function ref(value: unknown, kind: string): MachinaRef | undefined | typeof INVALID {
  if (value === undefined) return undefined;
  if (!isRow(value) || machinaIdKind(value.id) !== kind) return INVALID;
  const rest = texts(value, [["name", "name"]]);
  return rest === INVALID ? INVALID : { id: value.id as string, ...rest };
}

/** Action ids by sequence value, from the graph's `sport:Action` nodes. */
function actionIds(graph: unknown): Map<string, string> {
  const ids = new Map<string, string>();
  const nodes = isRow(graph) && Array.isArray(graph["@graph"]) ? graph["@graph"] : [];
  for (const node of nodes) {
    if (!isRow(node) || node["@type"] !== "sport:Action") continue;
    const sequence = node["sport:sequenceNumber"];
    if (typeof sequence === "string" && machinaIdKind(node["@id"]) === "action") ids.set(sequence, node["@id"] as string);
  }
  return ids;
}

/**
 * The event an envelope states, or undefined when `document` is not an envelope this
 * reader knows: another schema version, an id that is not a schema id, a value the
 * schema writes as text given as something else, or a missing rights block.
 */
export function readMachinaSportsEvent(document: unknown): MachinaSportsEvent | undefined {
  const block = isRow(document) ? document[MACHINA_SPORTS_SCHEMA_KEY] : undefined;
  if (!isRow(block) || !isRow(block.event_view)) return undefined;
  const { schema_version: schemaVersion, profile } = block;
  if (typeof schemaVersion !== "string" || !(MACHINA_SPORTS_SCHEMA_VERSIONS as readonly string[]).includes(schemaVersion)) return undefined;
  if (typeof profile !== "string") return undefined;

  const rights = block.rights;
  if (!isRow(rights) || typeof rights.data_class !== "string" || typeof rights.prototype_only !== "boolean" || typeof rights.commercial_use !== "boolean") {
    return undefined;
  }

  const view = block.event_view;
  if (machinaIdKind(view.event_id) !== "event") return undefined;
  const provider = view.provider;
  if (!isRow(provider) || typeof provider.namespace !== "string" || !provider.namespace) return undefined;
  const family = text(provider.family);

  const scalars = texts(view, [["label", "label"], ["sport", "sport"], ["status", "status"], ["start_time", "startTime"], ["end_time", "endTime"]]);
  const clock = view.clock === undefined ? undefined : isRow(view.clock) ? texts(view.clock, [["minute", "minute"], ["period", "period"]]) : INVALID;
  const competition = ref(view.competition, "competition");
  const season = ref(view.season, "competition"); // a season is a competition in the schema
  const phase = ref(view.phase, "phase");
  const site = ref(view.site, "site");
  if ([family, scalars, clock, competition, season, phase, site].includes(INVALID)) return undefined;

  const participants: MachinaParticipant[] = [];
  for (const item of view.participants === undefined ? [] : Array.isArray(view.participants) ? view.participants : [INVALID]) {
    if (!isRow(item) || machinaIdKind(item.id) !== "team") return undefined;
    const rest = texts(item, [["role", "role"], ["name", "name"], ["score", "score"], ["outcome", "outcome"]]);
    if (rest === INVALID) return undefined;
    participants.push({ id: item.id as string, ...rest });
  }

  const ids = actionIds(block.sport_schema_graph);
  const actions: MachinaAction[] = [];
  for (const item of view.actions === undefined ? [] : Array.isArray(view.actions) ? view.actions : [INVALID]) {
    if (!isRow(item) || typeof item.ordinal !== "string" || !item.ordinal) return undefined;
    const rest = texts(item, [["class", "class"], ["label", "label"], ["minute", "minute"], ["period", "period"], ["time", "time"]]);
    if (rest === INVALID) return undefined;
    const id = ids.get(item.ordinal);
    actions.push({ ...(id ? { id } : {}), ordinal: item.ordinal, ...rest });
  }

  const observedAt = isRow(block.provenance) ? text(block.provenance.observed_at) : undefined;
  if (observedAt === INVALID) return undefined;

  return {
    schemaVersion,
    profile,
    eventId: view.event_id as string,
    ...(scalars as Partial<Record<"label" | "sport" | "status" | "startTime" | "endTime", string>>),
    ...(clock && Object.keys(clock).length > 0 ? { clock: clock as { minute?: string; period?: string } } : {}),
    ...(competition ? { competition: competition as MachinaRef } : {}),
    ...(season ? { season: season as MachinaRef } : {}),
    ...(phase ? { phase: phase as MachinaRef } : {}),
    ...(site ? { site: site as MachinaRef } : {}),
    participants,
    actions,
    provider: { namespace: provider.namespace, ...(family ? { family: family as string } : {}) },
    ...(observedAt ? { observedAt } : {}),
    rights: { dataClass: rights.data_class, prototypeOnly: rights.prototype_only, commercialUse: rights.commercial_use },
  };
}
