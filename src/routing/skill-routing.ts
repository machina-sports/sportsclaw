/**
 * Opt-in skill routing over the generic `CapabilityRouter`.
 *
 * This is the only place the engine's skill vocabulary meets the generic
 * routing primitive. It is off by default: with no `routing` config and no
 * `SPORTSCLAW_ROUTING_*` environment variable the generative router in
 * `router.ts` runs exactly as before.
 *
 * When it is on, it *replaces* the generative router call rather than adding a
 * second one, and there is no generative fallback: a withheld data policy, a
 * missing credential, a denied auth, a timeout or a cancellation is reported as
 * `unavailable`, never as a weaker selection. An ambiguous or unsupported
 * request survives to the engine as itself.
 *
 * What is never sent: the memory block, the fan profile, tool arguments,
 * credentials and — unless `includeRecentContext` is explicitly true — the
 * recent conversation.
 */

import { CapabilityRouter, ROUTING_LIMITS, type CapabilityCandidate } from "./capability-router.js";
import type {
  ResolvedSkillRoutingSettings,
  RouteOutcome,
  SkillRoutingConfig,
  SkillRoutingMeta,
  ToolSpec,
} from "../types.js";

const DEFAULT_MODEL = "jev-1.13.0";
const DEFAULT_TIMEOUT_MS = 8_000;
const MIN_TIMEOUT_MS = 250;
const MAX_TIMEOUT_MS = 60_000;
const MODEL_PATTERN = /^jev-\d+\.\d+\.\d+$/;

/** Operation names per candidate description, so one skill stays one short line. */
const MAX_OPERATIONS_PER_SKILL = 8;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/**
 * Explicit configuration always wins over the environment. An out-of-range or
 * unknown value is recorded as a diagnostic and never silently switches the
 * provider: `routeSkillsWithJev` turns any diagnostic into `unavailable`.
 */
export function resolveSkillRoutingSettings(
  config?: SkillRoutingConfig
): ResolvedSkillRoutingSettings {
  const env = config?.env ?? process.env;
  const diagnostics: string[] = [];

  const pick = <T extends string>(
    field: string,
    explicit: string | undefined,
    envValue: string | undefined,
    allowed: readonly T[],
    fallback: T
  ): T => {
    const value = explicit ?? envValue;
    if (value === undefined || value === "") return fallback;
    if (typeof value !== "string") {
      diagnostics.push(`invalid_${field}`);
      return fallback;
    }
    const raw = value.trim().toLowerCase();
    if ((allowed as readonly string[]).includes(raw)) return raw as T;
    diagnostics.push(`invalid_${field}`);
    return fallback;
  };

  const number = (field: string, value: unknown, min: number, max: number, fallback: number): number => {
    if (value === undefined) return fallback;
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
      diagnostics.push(`invalid_${field}`);
      return fallback;
    }
    return value;
  };

  const provider = pick(
    "provider",
    config?.provider,
    env.SPORTSCLAW_ROUTING_PROVIDER,
    ["generative", "jev"] as const,
    "generative"
  );
  const dataPolicy = pick(
    "dataPolicy",
    config?.dataPolicy,
    env.SPORTSCLAW_ROUTING_DATA_POLICY,
    ["local_only", "cloud_allowed"] as const,
    "local_only"
  );

  const rawModel = config?.model;
  let model = DEFAULT_MODEL;
  if (rawModel !== undefined) {
    if (typeof rawModel === "string" && MODEL_PATTERN.test(rawModel)) model = rawModel;
    else diagnostics.push("invalid_model");
  }

  let maxSelected: number = ROUTING_LIMITS.defaultMaxSelected;
  if (config?.maxSelected !== undefined) {
    const requested = config.maxSelected;
    if (Number.isInteger(requested) && requested >= 1 && requested <= ROUTING_LIMITS.maxCandidates) {
      maxSelected = requested;
    } else {
      diagnostics.push("invalid_maxSelected");
    }
  }

  return {
    provider,
    dataPolicy,
    model,
    timeoutMs: number("timeoutMs", config?.timeoutMs, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    confidenceThreshold: number(
      "confidenceThreshold",
      config?.confidenceThreshold,
      ROUTING_LIMITS.minConfidenceThreshold,
      1,
      ROUTING_LIMITS.defaultConfidenceThreshold
    ),
    marginThreshold: number(
      "marginThreshold",
      config?.marginThreshold,
      0,
      1,
      ROUTING_LIMITS.defaultMarginThreshold
    ),
    maxSelected,
    includeRecentContext: config?.includeRecentContext === true,
    transport: config?.transport,
    env: config?.env,
    diagnostics,
  };
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

/**
 * One candidate per installed skill, described by its own ID and the operation
 * names its tools expose. No argument schema, no credential, no memory and no
 * context document: a description says what a skill can fetch, nothing else.
 */
export function buildSkillCandidates(
  installedSkills: readonly string[],
  toolSpecs: readonly ToolSpec[]
): CapabilityCandidate[] {
  const operations = new Map<string, string[]>();
  for (const skill of installedSkills) operations.set(skill, []);

  for (const spec of toolSpecs) {
    const splitIdx = spec.name.indexOf("_");
    if (splitIdx <= 0) continue;
    const bucket = operations.get(spec.name.slice(0, splitIdx));
    if (!bucket) continue;
    const operation = spec.name.slice(splitIdx + 1).replace(/_/g, " ").trim();
    if (operation.length > 0 && !bucket.includes(operation)) bucket.push(operation);
  }

  return installedSkills.map((skill) => {
    const ops = (operations.get(skill) ?? []).slice(0, MAX_OPERATIONS_PER_SKILL);
    let description = describeSkill(skill, ops);
    // Drop whole operation names rather than cutting one in half.
    while (description.length > ROUTING_LIMITS.maxDescriptionChars && ops.length > 0) {
      ops.pop();
      description = describeSkill(skill, ops);
    }
    return { id: skill, description };
  });
}

function describeSkill(skill: string, operations: readonly string[]): string {
  return operations.length > 0
    ? `Sports data skill "${skill}". Available operations: ${operations.join(", ")}.`
    : `Sports data skill "${skill}". No operation names published.`;
}

// ---------------------------------------------------------------------------
// Deterministic fast path
// ---------------------------------------------------------------------------

/** Exact, unambiguous aliases only. A partial or fuzzy hit is not a match. */
const SPORT_ALIASES: Record<string, string> = {
  soccer: "football",
  "formula 1": "f1",
  "formula one": "f1",
  "college football": "cfb",
  ncaaf: "cfb",
  "college basketball": "cbb",
  ncaab: "cbb",
};

const INTENT_WORDS = new Set(["score", "scores", "standings", "schedule", "schedules"]);
const TIME_WORDS = new Set(["today", "tonight"]);

/**
 * Matches only a *whole* request of the shape `<sport>[ and <sport>…] <intent>
 * [today|tonight]`, e.g. "NBA scores", "NFL standings tonight", "NBA and NFL
 * scores". Anything else — an extra clause, another intent, an unsupported
 * word, a date this cannot pin down — returns undefined so the model decides.
 *
 * A named sport somewhere in a longer sentence is deliberately NOT a match:
 * recognising one token is not understanding the request.
 */
export function deterministicSkillMatch(
  prompt: string,
  installedSkills: readonly string[]
): string[] | undefined {
  const installed = new Set(installedSkills);
  const normalized = prompt.toLowerCase().replace(/[?.!]+$/, "").replace(/\s+/g, " ").trim();
  if (normalized.length === 0) return undefined;

  const words = normalized.split(" ");
  if (TIME_WORDS.has(words[words.length - 1])) words.pop();
  const intent = words.pop();
  if (intent === undefined || !INTENT_WORDS.has(intent) || words.length === 0) return undefined;

  const selected: string[] = [];
  for (const part of words.join(" ").split(/\s*,\s*|\s+and\s+|\s*&\s*|\s*\/\s*/)) {
    const term = part.trim();
    if (term.length === 0) return undefined;
    const skill = installed.has(term) ? term : SPORT_ALIASES[term];
    if (skill === undefined || !installed.has(skill)) return undefined;
    if (!selected.includes(skill)) selected.push(skill);
  }
  return selected.length > 0 ? selected : undefined;
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

export interface JevSkillRouteInput {
  prompt: string;
  installedSkills: string[];
  toolSpecs: ToolSpec[];
  /** Deterministically inferred helper skills (news, markets, …). */
  helperSkills: readonly string[];
  /** Only forwarded when the caller opted into `includeRecentContext`. */
  recentContext?: string;
  abortSignal?: AbortSignal;
}

/**
 * One bounded routing decision. Never throws: every refusal and failure becomes
 * a typed `RouteMeta.routing` outcome, and only `selected` carries skills.
 */
export async function routeSkillsWithJev(
  input: JevSkillRouteInput,
  settings: ResolvedSkillRoutingSettings
): Promise<RouteOutcome> {
  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;

  if (settings.diagnostics.length > 0) {
    // A misconfigured decision router is reported, not quietly replaced by the
    // generative one the caller opted out of.
    return refusal({ status: "unavailable", source: "jev", reasonCode: settings.diagnostics[0], latencyMs: elapsed() });
  }

  const deterministic = deterministicSkillMatch(input.prompt, input.installedSkills);
  if (deterministic && deterministic.length > settings.maxSelected) {
    // The request is understood and needs more skills than the cap allows;
    // dropping one would silently answer a narrower question.
    return refusal({
      status: "clarify",
      source: "deterministic",
      reasonCode: "too_many_required",
      latencyMs: elapsed(),
    });
  }

  let router: CapabilityRouter;
  try {
    router = new CapabilityRouter({
      provider: "jev",
      dataPolicy: settings.dataPolicy,
      model: settings.model,
      timeoutMs: settings.timeoutMs,
      confidenceThreshold: settings.confidenceThreshold,
      marginThreshold: settings.marginThreshold,
      maxSelected: settings.maxSelected,
      ...(settings.transport ? { transport: settings.transport } : {}),
      ...(settings.env ? { env: settings.env } : {}),
    });
  } catch {
    return refusal({ status: "unavailable", source: "jev", reasonCode: "invalid_config", latencyMs: elapsed() });
  }

  const outcome = await router.route(
    {
      prompt: input.prompt,
      candidates: buildSkillCandidates(input.installedSkills, input.toolSpecs),
      ...(settings.includeRecentContext && input.recentContext ? { recentContext: input.recentContext } : {}),
      ...(deterministic ? { deterministicSelectedIds: deterministic } : {}),
    },
    { ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}) }
  );

  const meta: SkillRoutingMeta = {
    status: outcome.status,
    source: outcome.source,
    reasonCode: outcome.reasonCode,
    ...(outcome.model ? { model: outcome.model } : {}),
    ...(outcome.confidence === undefined ? {} : { confidence: outcome.confidence }),
    ...(outcome.margin === undefined ? {} : { margin: outcome.margin }),
    latencyMs: elapsed(),
  };

  if (outcome.status !== "selected") return refusal(meta);

  // Every validated ID survives — the selection is not squeezed into the
  // legacy focused slice — and deterministic helper skills are still unioned.
  const selectedSkills = [...outcome.selectedIds];
  for (const helper of input.helperSkills) {
    if (!input.installedSkills.includes(helper)) {
      return refusal({ ...meta, status: "unavailable", reasonCode: "invalid_helper" });
    }
    if (!selectedSkills.includes(helper)) selectedSkills.push(helper);
  }
  if (selectedSkills.length > settings.maxSelected) {
    return refusal({ ...meta, status: "clarify", reasonCode: "too_many_required" });
  }

  return {
    decision: {
      selectedSkills,
      mode: outcome.selectedIds.length > 1 ? "ambiguous" : "focused",
      // Legacy confidence for the existing gates. The model's own number, when
      // there is one; a rule decision reports no model confidence in `routing`.
      confidence: outcome.confidence ?? 0.95,
      reason: `Jev routing: ${outcome.reasonCode}`,
      needsClarification: false,
    },
    meta: legacyMeta(meta),
  };
}

function refusal(routing: SkillRoutingMeta): RouteOutcome {
  return {
    decision: {
      selectedSkills: [],
      mode: "ambiguous",
      confidence: 0,
      reason: `Jev routing ${routing.status}: ${routing.reasonCode}`,
      needsClarification: routing.status === "clarify",
    },
    meta: legacyMeta(routing),
  };
}

/**
 * The generative telemetry fields stay literally true: no generative router was
 * attempted, so `llmAttempted` is false and the decision detail lives in
 * `routing` instead of being disguised as a main-model call.
 */
function legacyMeta(routing: SkillRoutingMeta) {
  return {
    modelUsed: null,
    llmAttempted: false,
    llmSucceeded: false,
    llmDurationMs: 0,
    routing,
  };
}
