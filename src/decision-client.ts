/**
 * Generic client for the TypeSafe Jev decision endpoint.
 *
 * Jev is a *decision* provider: it answers bounded questions about a supplied
 * state. It is not a chat model, it never appears as an `LLMProvider`, and this
 * module deliberately has no dependency on the engine — importing it boots
 * nothing, reads no credential, starts no listener and makes no network call.
 *
 * What this client is:
 *   - one HTTPS request carrying one shared state and a caller-defined map of
 *     Choice / Score / Noul questions, mixed freely;
 *   - schema validation of the request before egress and of the answers after,
 *     against the exact snapshot that was sent;
 *   - sanitized, text-free receipts.
 *
 * The request, answer and result types and the call itself (consent, bounds,
 * deadline, answer checks, receipts) are shared by every `DecisionProvider`; a
 * provider supplies only its wire (`DecisionWire`). Jev is implemented here,
 * Gemini in `gemini-decision-client.ts`.
 *
 * What this client is not:
 *   - an interpreter. Question IDs, option labels and rubric wording belong to
 *     the caller; this module never adds meaning to them, thresholds them, or
 *     turns an answer into an action.
 *
 * Bounded subset of the native API: instructions are strings and criterion
 * descriptions are strings. The native docs also allow structured instructions
 * and structured criteria; those are not supported here and are rejected.
 */

// ---------------------------------------------------------------------------
// Transport surface
// ---------------------------------------------------------------------------

/** HTTP seam for embedders and offline tests. Defaults to global fetch. */
export type DecisionTransport = (url: string, init: RequestInit) => Promise<Response>;

/** Fixed HTTPS endpoint. Callers cannot point this anywhere else. */
export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";

/** Pinned default decision model. */
export const DEFAULT_JEV_MODEL = "jev-1.13.0";

const MODEL_PATTERN = /^jev-\d+\.\d+\.\d+$/;

/**
 * Every finite bound this client enforces. Exported so callers can size their
 * own requests instead of discovering a limit through a refusal.
 */
export const DECISION_LIMITS = {
  /** Questions per request. */
  minQuestions: 1,
  maxQuestions: 32,
  /** Characters in a question ID or a Choice option ID. */
  maxIdChars: 64,
  /** Characters in a question's `instructions`. */
  maxInstructionChars: 4_000,
  /** Characters in one option/level/true-false description. */
  maxDescriptionChars: 1_000,
  /** Characters of state: `state.length` for a string, serialized length otherwise. */
  maxStateChars: 32_000,
  /** Nesting depth and total node count of a non-string state. */
  maxStateDepth: 32,
  maxStateNodes: 20_000,
  /** Choice options per question. */
  minChoiceOptions: 2,
  maxChoiceOptions: 255,
  /** Score levels per question. */
  minScoreLevels: 2,
  maxScoreLevels: 10,
  /** UTF-8 bytes of the serialized request body, not counting images. */
  maxRequestBytes: 128 * 1024,
  /** Images per request, and their total size once decoded. */
  maxImages: 4,
  maxMediaBytes: 5 * 1024 * 1024,
  /** Bytes read from a response before it is refused. */
  maxResponseBytes: 256 * 1024,
  /** A probability distribution may miss 1 by this much. */
  probabilitySumTolerance: 0.02,
  /** A Score may differ from its probability-weighted value by this much. */
  scoreTolerance: 0.05,
  /** Milliseconds: accepted range for the per-request deadline. */
  minTimeoutMs: 250,
  maxTimeoutMs: 60_000,
  defaultTimeoutMs: 8_000,
} as const;

// ---------------------------------------------------------------------------
// Request types
// ---------------------------------------------------------------------------

/** A finite JSON value accepted inside a structured state. */
export type DecisionJsonValue =
  | string
  | number
  | boolean
  | null
  | DecisionJsonValue[]
  | { [key: string]: DecisionJsonValue };

/** The shared state every question is answered against. */
export type DecisionState = string | DecisionJsonValue[] | { [key: string]: DecisionJsonValue };

/** Pick one option. `criteria` maps each offered option ID to its description. */
export interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
}

/** Rate on an ordered scale. `criteria[i]` describes level `i`. */
export interface ScoreQuestion {
  type: "score";
  instructions: string;
  criteria: readonly string[];
}

/** A true/false judgement returned as a probability. Descriptions are optional. */
export interface NoulQuestion {
  type: "noul";
  instructions: string;
  criteria?: { true?: string; false?: string };
}

export type DecisionQuestion = ChoiceQuestion | ScoreQuestion | NoulQuestion;

/** An image the questions are about, beside the state. Base64, no data: prefix. */
export interface DecisionImage {
  kind: "image";
  data: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
}

/** One request: one state, one caller-keyed map of mixed questions, and optionally images. */
export interface DecisionRequest {
  state: DecisionState;
  questions: Record<string, DecisionQuestion>;
  /**
   * Images every question may refer to. Only a provider that reads images accepts them
   * (Gemini); another refuses the request as `media_unsupported` rather than answering
   * without having seen them.
   */
  media?: readonly DecisionImage[];
}

/** Per-call options. Credentials, model and deadline are client config. */
export interface DecisionCallOptions {
  abortSignal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Answer types
// ---------------------------------------------------------------------------

export interface ChoiceAnswer {
  readonly type: "choice";
  /** One of the offered option IDs, exactly as supplied. */
  readonly choice: string;
  /** Provider confidence in [0,1]; validated independently of the distribution. */
  readonly confidence: number;
  /** One entry per offered option ID. */
  readonly probabilities: Readonly<Record<string, number>>;
}

export interface ScoreAnswer {
  readonly type: "score";
  /** Probability-weighted score in [0, levels-1]; often between levels. */
  readonly score: number;
  readonly confidence: number;
  /** Index-keyed echo of the supplied level descriptions. */
  readonly legend: Readonly<Record<string, string>>;
  /** Index-keyed distribution over the supplied levels. */
  readonly probabilities: Readonly<Record<string, number>>;
}

export interface NoulAnswer {
  readonly type: "noul";
  /** Probability in [0,1]. There is no confidence and no boolean decision. */
  readonly noul: number;
}

export type DecisionAnswer = ChoiceAnswer | ScoreAnswer | NoulAnswer;

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/** Sanitized enum. Never a provider message, never caller text. */
export type DecisionReasonCode =
  | "answered"
  | "local_only"
  | "aborted"
  | "invalid_request"
  | "invalid_state"
  | "invalid_questions"
  | "invalid_media"
  | "media_unsupported"
  | "request_too_large"
  | "missing_credential"
  | "redirect_refused"
  | "auth_denied"
  | "rate_limited"
  | "upstream_error"
  | "content_blocked"
  | "timeout"
  | "network_error"
  | "response_too_large"
  | "malformed_response"
  | "model_mismatch"
  | "question_set_mismatch"
  | "answer_type_mismatch"
  | "option_set_mismatch"
  | "probability_invalid"
  | "probability_sum_invalid"
  | "argmax_mismatch"
  | "confidence_invalid"
  | "score_invalid"
  | "score_inconsistent"
  | "legend_invalid"
  | "noul_invalid";

/** The decision services this package can call. */
export type DecisionProviderName = "jev" | "gemini";

export interface DecisionKindCounts {
  choice: number;
  score: number;
  noul: number;
}

/**
 * Measurement record. Carries no state, instructions, question IDs, option
 * labels, rubric text, answers, provider errors or credentials — only closed
 * enums, the models, counts, usage and latency. Values the provider did not
 * supply stay missing rather than becoming zero.
 */
export interface DecisionReceipt {
  provider: DecisionProviderName;
  /** `answered` once answers validated; `blocked` before egress; `failed` after. */
  status: "answered" | "blocked" | "failed";
  reasonCode: DecisionReasonCode;
  /** The model this client asked for, recorded even when nothing was sent. */
  requestedModel: string;
  /** Only set from a validated response that named its model and matched the request. */
  model?: string;
  latencyMs: number;
  /** Counts describe the validated snapshot; a request refused earlier reports 0. */
  questionCount: number;
  kindCounts: DecisionKindCounts;
  /** Images sent with the request, when there were any. */
  images?: number;
  usage?: { inputTokens: number; outputTokens: number };
}

export interface DecisionSuccess {
  ok: true;
  /** The model that answered: the one the response reported and matched, else the one asked for. */
  model: string;
  /** Exactly the question IDs that were sent. */
  answers: Record<string, DecisionAnswer>;
  receipt: DecisionReceipt;
}

export interface DecisionFailure {
  ok: false;
  reasonCode: DecisionReasonCode;
  receipt: DecisionReceipt;
  /** Never present: a non-success result carries no answers. */
  answers?: undefined;
}

/**
 * Success means the answers are schema-valid for the questions that were sent.
 * It is not a statement about business correctness or permission.
 */
export type DecisionResult = DecisionSuccess | DecisionFailure;

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export type DecisionDataPolicy = "local_only" | "cloud_allowed";

/** Trusted, caller-authored configuration. Never model-authored. */
export interface JevDecisionClientConfig {
  /** Cloud consent. Anything but an explicit `cloud_allowed` blocks egress. */
  dataPolicy?: DecisionDataPolicy;
  /** Pinned `jev-X.Y.Z` model. Default: `jev-1.13.0`. */
  model?: string;
  /** Per-request deadline in ms (250–60000). Default: 8000. */
  timeoutMs?: number;
  /** HTTP seam for embedders and offline tests. Defaults to global fetch. */
  transport?: DecisionTransport;
  /** Environment source for the late credential lookup. Defaults to process.env. */
  env?: Record<string, string | undefined>;
}

/** @internal Shared with the other providers in this package. */
export class DecisionError extends Error {
  constructor(readonly reasonCode: DecisionReasonCode) {
    super(reasonCode);
  }
}

/**
 * One decision service behind the shared request and answer types. Code written
 * against this runs on any provider. Which provider's answers to trust for a job
 * is a measurement, not an assumption: see `sportsclaw judge-compare`.
 */
export interface DecisionProvider {
  readonly provider: DecisionProviderName;
  readonly model: string;
  readonly dataPolicy: DecisionDataPolicy;
  /** One bounded attempt. Never retries, never falls back, never throws. */
  decide(request: DecisionRequest, options?: DecisionCallOptions): Promise<DecisionResult>;
}

/** @internal A client's checked configuration. */
export interface DecisionSettings {
  dataPolicy: DecisionDataPolicy;
  model: string;
  timeoutMs: number;
  transport?: DecisionTransport;
  env?: Record<string, string | undefined>;
}

/**
 * @internal The constructor checks every provider shares. Invalid configuration
 * throws here, where the developer who wrote it can see it, rather than degrading
 * into a request against an unintended model.
 */
export function decisionSettings(
  config: JevDecisionClientConfig,
  model: { fallback: string; pattern: RegExp; expected: string }
): DecisionSettings {
  const dataPolicy = config.dataPolicy ?? "local_only";
  if (dataPolicy !== "local_only" && dataPolicy !== "cloud_allowed") {
    throw new TypeError("Invalid dataPolicy: expected local_only or cloud_allowed");
  }
  const name = config.model ?? model.fallback;
  if (typeof name !== "string" || !model.pattern.test(name)) {
    throw new TypeError(`Invalid model: expected ${model.expected}`);
  }
  const timeoutMs = config.timeoutMs ?? DECISION_LIMITS.defaultTimeoutMs;
  if (
    typeof timeoutMs !== "number" ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs < DECISION_LIMITS.minTimeoutMs ||
    timeoutMs > DECISION_LIMITS.maxTimeoutMs
  ) {
    throw new TypeError(
      `Invalid timeoutMs: expected ${DECISION_LIMITS.minTimeoutMs}–${DECISION_LIMITS.maxTimeoutMs}`
    );
  }
  return { dataPolicy, model: name, timeoutMs, transport: config.transport, env: config.env };
}

/** @internal What differs between decision services. Everything else about a call is shared. */
export interface DecisionWire {
  provider: DecisionProviderName;
  /** Fixed HTTPS endpoint. */
  endpoint: string;
  /** The NAMES of the environment variables that may hold the key; the first one set is used. */
  credentialEnv: readonly string[];
  headers(apiKey: string): Record<string, string>;
  /** The request body for a snapshot. Throws a `DecisionError` for a request this service cannot take. */
  body(model: string, snapshot: RequestSnapshot): unknown;
  /** The reason for an error status the shared rules do not name, read from its body. */
  refusal?(status: number, text: string): DecisionReasonCode | undefined;
  /** The checked answers of a 2xx body. `model` only when the service reports it. */
  read(text: string, snapshot: RequestSnapshot, requestedModel: string): ValidatedResponse;
}

const JEV_WIRE: DecisionWire = {
  provider: "jev",
  endpoint: JEV_ENDPOINT,
  credentialEnv: ["TYPESAFE_API_KEY"],
  headers: (apiKey) => ({ authorization: `Bearer ${apiKey}` }),
  body(model, snapshot) {
    // Jev reads text. Answering without the image would be answering a different question.
    if (snapshot.media.length > 0) throw new DecisionError("media_unsupported");
    return { model, state: snapshot.state, questions: snapshot.payload };
  },
  read(text, snapshot, requestedModel) {
    const parsed = parseResponseRecord(text);
    if (typeof parsed.model !== "string") throw new DecisionError("malformed_response");
    if (parsed.model !== requestedModel) throw new DecisionError("model_mismatch");
    return {
      model: parsed.model,
      answers: validateAnswers(parsed.answers, snapshot),
      usage: readUsage(parsed.usage, "input_tokens", "output_tokens"),
    };
  },
};

export class JevDecisionClient implements DecisionProvider {
  readonly provider = "jev";
  readonly dataPolicy: DecisionDataPolicy;
  readonly model: string;
  readonly timeoutMs: number;
  private readonly settings: DecisionSettings;

  constructor(config: JevDecisionClientConfig = {}) {
    this.settings = decisionSettings(config, {
      fallback: DEFAULT_JEV_MODEL,
      pattern: MODEL_PATTERN,
      expected: "a pinned jev-X.Y.Z identifier",
    });
    this.dataPolicy = this.settings.dataPolicy;
    this.model = this.settings.model;
    this.timeoutMs = this.settings.timeoutMs;
  }

  /**
   * One bounded attempt. Never retries, never falls back, never throws: every
   * refusal and failure becomes a typed non-success result with no answers.
   */
  decide(request: DecisionRequest, options: DecisionCallOptions = {}): Promise<DecisionResult> {
    return runDecision(JEV_WIRE, this.settings, request, options);
  }
}

/** @internal One decision call over a provider's wire. */
export async function runDecision(
  wire: DecisionWire,
  settings: DecisionSettings,
  request: DecisionRequest,
  options: DecisionCallOptions
): Promise<DecisionResult> {
  const startedAt = Date.now();
  let questionCount = 0;
  let kindCounts: DecisionKindCounts = { choice: 0, score: 0, noul: 0 };
  let images = 0;

  const refuse = (status: "blocked" | "failed", reasonCode: DecisionReasonCode): DecisionFailure => ({
    ok: false,
    reasonCode,
    receipt: {
      provider: wire.provider,
      status,
      reasonCode,
      requestedModel: settings.model,
      model: undefined,
      latencyMs: Date.now() - startedAt,
      questionCount,
      kindCounts: { ...kindCounts },
      ...(images > 0 ? { images } : {}),
      usage: undefined,
    },
  });

  // Cloud consent is the outermost gate: withheld consent stops before the
  // request is even read, and cannot be re-granted by the request itself.
  if (settings.dataPolicy !== "cloud_allowed") return refuse("blocked", "local_only");
  if (options.abortSignal?.aborted) return refuse("blocked", "aborted");

  // The snapshot is what gets sent *and* what the response is checked
  // against, so mutating the caller's objects during the await changes
  // nothing here.
  let snapshot: RequestSnapshot;
  try {
    snapshot = snapshotRequest(request);
  } catch (err) {
    return refuse("blocked", err instanceof DecisionError ? err.reasonCode : "invalid_request");
  }
  questionCount = snapshot.questions.length;
  kindCounts = snapshot.kindCounts;
  images = snapshot.media.length;

  let body: string;
  try {
    body = JSON.stringify(wire.body(settings.model, snapshot));
  } catch (err) {
    return refuse("blocked", err instanceof DecisionError ? err.reasonCode : "invalid_request");
  }
  // Images have their own limit (checked in the snapshot); the text of the request keeps this one.
  const mediaChars = snapshot.media.reduce((sum, image) => sum + image.data.length, 0);
  if (Buffer.byteLength(body, "utf8") - mediaChars > DECISION_LIMITS.maxRequestBytes) {
    return refuse("blocked", "request_too_large");
  }

  // Resolved at call time and never persisted, logged or put in a receipt.
  const env = settings.env ?? process.env;
  const apiKey = wire.credentialEnv.map((name) => env[name]?.trim()).find((key) => key);
  if (!apiKey) return refuse("blocked", "missing_credential");

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, settings.timeoutMs);
  const onCallerAbort = () => controller.abort();
  options.abortSignal?.addEventListener("abort", onCallerAbort, { once: true });

  let res: Response | undefined;
  try {
    const send = settings.transport ?? ((url: string, init: RequestInit) => fetch(url, init));
    res = await send(wire.endpoint, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/json", ...wire.headers(apiKey) },
      body,
      signal: controller.signal,
    });

    if (res.status >= 300 && res.status < 400) throw new DecisionError("redirect_refused");
    if (res.status === 401 || res.status === 403) throw new DecisionError("auth_denied");
    if (res.status === 429) throw new DecisionError("rate_limited");
    if (!res.ok) throw new DecisionError((await refusalOf(wire, res)) ?? "upstream_error");

    const validated = wire.read(await readBounded(res), snapshot, settings.model);
    return {
      ok: true,
      model: validated.model ?? settings.model,
      answers: validated.answers,
      receipt: {
        provider: wire.provider,
        status: "answered",
        reasonCode: "answered",
        requestedModel: settings.model,
        model: validated.model,
        latencyMs: Date.now() - startedAt,
        questionCount,
        kindCounts: { ...kindCounts },
        ...(images > 0 ? { images } : {}),
        usage: validated.usage,
      },
    };
  } catch (err) {
    if (options.abortSignal?.aborted) return refuse("failed", "aborted");
    if (timedOut) return refuse("failed", "timeout");
    if (err instanceof DecisionError) return refuse("failed", err.reasonCode);
    return refuse("failed", "network_error");
  } finally {
    clearTimeout(timer);
    options.abortSignal?.removeEventListener("abort", onCallerAbort);
    // A status or size exit leaves the body unread; release it rather than
    // holding a response stream open until collection.
    if (res?.body && !res.bodyUsed && !res.body.locked) void res.body.cancel().catch(() => {});
  }
}

/** What a provider says about an error status, when it says anything this package names. */
async function refusalOf(wire: DecisionWire, res: Response): Promise<DecisionReasonCode | undefined> {
  if (!wire.refusal) return undefined;
  try {
    return wire.refusal(res.status, await readBounded(res));
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Request snapshot + validation (no credential, no network)
// ---------------------------------------------------------------------------

/** @internal */
export interface QuestionSnapshot {
  id: string;
  kind: "choice" | "score" | "noul";
  /** Offered option IDs, in the order supplied. Choice only. */
  options?: string[];
  /** Supplied level descriptions, index 0..n-1. Score only. */
  levels?: string[];
  /** Exactly what goes on the wire for this question. */
  payload: Record<string, unknown>;
}

/** @internal */
export interface RequestSnapshot {
  state: DecisionState;
  questions: QuestionSnapshot[];
  payload: Record<string, unknown>;
  kindCounts: DecisionKindCounts;
  media: { data: string; mimeType: string }[];
}

/** @internal */
export function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Records are built prototype-free so a caller-defined `__proto__` or
 * `constructor` key stays an ordinary, exactly-preserved key instead of
 * reaching an inherited setter.
 */
export function emptyRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

function snapshotRequest(request: DecisionRequest): RequestSnapshot {
  if (!isRecord(request)) throw new DecisionError("invalid_request");
  // The request carries a state and questions and nothing else: model,
  // endpoint, credentials and deadlines are client config and cannot be
  // smuggled in beside them.
  for (const key of Object.keys(request)) {
    if (key !== "state" && key !== "questions" && key !== "media") throw new DecisionError("invalid_request");
  }
  const state = snapshotState((request as Record<string, unknown>).state);
  const questions = snapshotQuestions((request as Record<string, unknown>).questions);
  const media = snapshotMedia((request as Record<string, unknown>).media);
  return { state, ...questions, media };
}

const IMAGE_TYPES: ReadonlySet<unknown> = new Set(["image/png", "image/jpeg", "image/webp"]);
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function snapshotMedia(raw: unknown): RequestSnapshot["media"] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > DECISION_LIMITS.maxImages) throw new DecisionError("invalid_media");
  let bytes = 0;
  return raw.map((item: unknown) => {
    if (!isRecord(item) || item.kind !== "image" || !IMAGE_TYPES.has(item.mimeType)) throw new DecisionError("invalid_media");
    const { data } = item;
    if (typeof data !== "string" || data.length === 0 || data.length % 4 !== 0 || !BASE64.test(data)) {
      throw new DecisionError("invalid_media");
    }
    bytes += (data.length / 4) * 3;
    if (bytes > DECISION_LIMITS.maxMediaBytes) throw new DecisionError("request_too_large");
    return { data, mimeType: item.mimeType as string };
  });
}

function snapshotState(raw: unknown): DecisionState {
  if (typeof raw === "string") {
    // Never truncated: a cut state could drop the very thing under judgement
    // and still come back answered.
    if (raw.length > DECISION_LIMITS.maxStateChars) throw new DecisionError("request_too_large");
    return raw;
  }
  if (!isRecord(raw) && !Array.isArray(raw)) throw new DecisionError("invalid_state");
  const clone = cloneJson(raw, 0, {
    nodes: DECISION_LIMITS.maxStateNodes,
    chars: DECISION_LIMITS.maxStateChars,
  }, new Set<object>());
  const serialized = JSON.stringify(clone);
  if (serialized.length > DECISION_LIMITS.maxStateChars) throw new DecisionError("request_too_large");
  return clone as DecisionState;
}

/**
 * Deep-copy a finite JSON value. Depth and node budgets are spent during the
 * walk, so a cyclic or pathologically large input is refused before any
 * serialization attempt rather than during one.
 */
function cloneJson(
  value: unknown,
  depth: number,
  budget: { nodes: number; chars: number },
  ancestors: Set<object>
): DecisionJsonValue {
  if (budget.nodes-- <= 0) throw new DecisionError("invalid_state");
  const kind = typeof value;
  if (kind === "string") {
    budget.chars -= (value as string).length;
    if (budget.chars < 0) throw new DecisionError("request_too_large");
    return value as string;
  }
  if (value === null) return null;
  if (kind === "boolean") return value as boolean;
  if (kind === "number") {
    if (!Number.isFinite(value as number)) throw new DecisionError("invalid_state");
    return value as number;
  }
  if (kind !== "object") throw new DecisionError("invalid_state");

  const container = value as object;
  if (ancestors.has(container)) throw new DecisionError("invalid_state");
  if (depth >= DECISION_LIMITS.maxStateDepth) throw new DecisionError("invalid_state");
  ancestors.add(container);
  try {
    if (Array.isArray(container)) {
      const out: DecisionJsonValue[] = [];
      for (let i = 0; i < container.length; i++) {
        out.push(cloneJson(container[i], depth + 1, budget, ancestors));
      }
      return out;
    }
    if (!isRecord(container)) throw new DecisionError("invalid_state");
    const out = emptyRecord<DecisionJsonValue>();
    for (const key of Object.keys(container)) {
      budget.chars -= key.length;
      if (budget.chars < 0) throw new DecisionError("request_too_large");
      out[key] = cloneJson(container[key], depth + 1, budget, ancestors);
    }
    return out;
  } finally {
    ancestors.delete(container);
  }
}

function snapshotQuestions(raw: unknown): Omit<RequestSnapshot, "state" | "media"> {
  if (!isRecord(raw)) throw new DecisionError("invalid_questions");
  const ids = Object.keys(raw);
  if (ids.length < DECISION_LIMITS.minQuestions || ids.length > DECISION_LIMITS.maxQuestions) {
    throw new DecisionError("invalid_questions");
  }
  const questions: QuestionSnapshot[] = [];
  const payload = emptyRecord<unknown>();
  const kindCounts: DecisionKindCounts = { choice: 0, score: 0, noul: 0 };
  for (const id of ids) {
    if (id.length === 0 || id.length > DECISION_LIMITS.maxIdChars) {
      throw new DecisionError("invalid_questions");
    }
    const question = snapshotQuestion(id, (raw as Record<string, unknown>)[id]);
    questions.push(question);
    payload[id] = question.payload;
    kindCounts[question.kind] += 1;
  }
  return { questions, payload, kindCounts };
}

function requireOnlyKeys(raw: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) throw new DecisionError("invalid_questions");
  }
}

function boundedText(value: unknown, maxChars: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxChars) {
    throw new DecisionError("invalid_questions");
  }
  return value;
}

const QUESTION_KEYS = ["type", "instructions", "criteria"] as const;

function snapshotQuestion(id: string, raw: unknown): QuestionSnapshot {
  if (!isRecord(raw)) throw new DecisionError("invalid_questions");
  requireOnlyKeys(raw, QUESTION_KEYS);
  const instructions = boundedText(raw.instructions, DECISION_LIMITS.maxInstructionChars);

  switch (raw.type) {
    case "choice": {
      const criteria = raw.criteria;
      if (!isRecord(criteria)) throw new DecisionError("invalid_questions");
      const options = Object.keys(criteria);
      if (
        options.length < DECISION_LIMITS.minChoiceOptions ||
        options.length > DECISION_LIMITS.maxChoiceOptions
      ) {
        throw new DecisionError("invalid_questions");
      }
      const wire = emptyRecord<string>();
      for (const option of options) {
        if (option.length === 0 || option.length > DECISION_LIMITS.maxIdChars) {
          throw new DecisionError("invalid_questions");
        }
        wire[option] = boundedText(criteria[option], DECISION_LIMITS.maxDescriptionChars);
      }
      return { id, kind: "choice", options, payload: { type: "choice", instructions, criteria: wire } };
    }
    case "score": {
      const criteria = raw.criteria;
      if (!Array.isArray(criteria)) throw new DecisionError("invalid_questions");
      if (
        criteria.length < DECISION_LIMITS.minScoreLevels ||
        criteria.length > DECISION_LIMITS.maxScoreLevels
      ) {
        throw new DecisionError("invalid_questions");
      }
      const levels: string[] = [];
      for (let i = 0; i < criteria.length; i++) {
        levels.push(boundedText(criteria[i], DECISION_LIMITS.maxDescriptionChars));
      }
      return {
        id,
        kind: "score",
        levels,
        payload: { type: "score", instructions, criteria: [...levels] },
      };
    }
    case "noul": {
      const payload: Record<string, unknown> = { type: "noul", instructions };
      if (raw.criteria !== undefined) {
        const criteria = raw.criteria;
        if (!isRecord(criteria)) throw new DecisionError("invalid_questions");
        const keys = Object.keys(criteria);
        if (keys.length === 0 || keys.length > 2) throw new DecisionError("invalid_questions");
        const wire = emptyRecord<string>();
        for (const key of keys) {
          // The native criteria keys for this primitive are the strings
          // "true" and "false"; nothing else is meaningful.
          if (key !== "true" && key !== "false") throw new DecisionError("invalid_questions");
          wire[key] = boundedText(criteria[key], DECISION_LIMITS.maxDescriptionChars);
        }
        payload.criteria = wire;
      }
      return { id, kind: "noul", payload };
    }
    default:
      throw new DecisionError("invalid_questions");
  }
}

// ---------------------------------------------------------------------------
// Response reading + validation
// ---------------------------------------------------------------------------

/** Read a response body with a hard byte cap so a hostile size cannot land. */
async function readBounded(res: Response): Promise<string> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > DECISION_LIMITS.maxResponseBytes) {
    throw new DecisionError("response_too_large");
  }
  if (!res.body) throw new DecisionError("malformed_response");
  const reader = res.body.getReader();
  try {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > DECISION_LIMITS.maxResponseBytes) throw new DecisionError("response_too_large");
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    // Also covers the oversize exit: the rest of the stream is dropped.
    await reader.cancel().catch(() => {});
  }
}

/** @internal */
export interface ValidatedResponse {
  model?: string;
  answers: Record<string, DecisionAnswer>;
  usage?: { inputTokens: number; outputTokens: number };
}

/** @internal A response body as a plain JSON object. */
export function parseResponseRecord(text: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new DecisionError("malformed_response");
  }
  if (!isRecord(parsed)) throw new DecisionError("malformed_response");
  return parsed;
}

/**
 * @internal Structural validation against the snapshot that was actually sent.
 * Anything unexpected raises, which the call turns into a non-success result —
 * never into a partially trusted answer set.
 */
export function validateAnswers(rawAnswers: unknown, snapshot: RequestSnapshot): Record<string, DecisionAnswer> {
  if (!isRecord(rawAnswers)) throw new DecisionError("malformed_response");
  const expectedIds = snapshot.questions.map((question) => question.id).sort();
  const actualIds = Object.keys(rawAnswers).sort();
  if (
    actualIds.length !== expectedIds.length ||
    actualIds.some((id, index) => id !== expectedIds[index])
  ) {
    throw new DecisionError("question_set_mismatch");
  }

  const answers = emptyRecord<DecisionAnswer>();
  for (const question of snapshot.questions) {
    answers[question.id] = validateAnswer(question, rawAnswers[question.id]);
  }
  return answers;
}

function validateAnswer(question: QuestionSnapshot, raw: unknown): DecisionAnswer {
  if (!isRecord(raw)) throw new DecisionError("malformed_response");
  if (raw.type !== question.kind) throw new DecisionError("answer_type_mismatch");
  switch (question.kind) {
    case "choice":
      return validateChoiceAnswer(question.options ?? [], raw);
    case "score":
      return validateScoreAnswer(question.levels ?? [], raw);
    default:
      return validateNoulAnswer(raw);
  }
}

/** Exactly the supplied keys, each a finite probability, summing to about 1. */
function readDistribution(raw: unknown, keys: readonly string[]): Record<string, number> {
  if (!isRecord(raw)) throw new DecisionError("malformed_response");
  if (Object.keys(raw).length !== keys.length) throw new DecisionError("option_set_mismatch");
  const distribution = emptyRecord<number>();
  let sum = 0;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) throw new DecisionError("option_set_mismatch");
    const probability = raw[key];
    if (typeof probability !== "number" || !Number.isFinite(probability) || probability < 0 || probability > 1) {
      throw new DecisionError("probability_invalid");
    }
    distribution[key] = probability;
    sum += probability;
  }
  if (Math.abs(sum - 1) > DECISION_LIMITS.probabilitySumTolerance) {
    throw new DecisionError("probability_sum_invalid");
  }
  return distribution;
}

/**
 * Confidence is its own signal, not a copy of the winning probability: the
 * published example pairs a top probability of 0.88 with a confidence of 0.81.
 * Only the range is ours to enforce.
 */
function readConfidence(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0 || raw > 1) {
    throw new DecisionError("confidence_invalid");
  }
  return raw;
}

function validateChoiceAnswer(options: readonly string[], raw: Record<string, unknown>): ChoiceAnswer {
  const choice = raw.choice;
  if (typeof choice !== "string" || !options.includes(choice)) {
    throw new DecisionError("option_set_mismatch");
  }
  const probabilities = readDistribution(raw.probabilities, options);
  let highest = Number.NEGATIVE_INFINITY;
  for (const option of options) {
    if (probabilities[option] > highest) highest = probabilities[option];
  }
  // Ties are allowed: the chosen option only has to be *at* a maximum.
  if (probabilities[choice] < highest) throw new DecisionError("argmax_mismatch");
  return { type: "choice", choice, confidence: readConfidence(raw.confidence), probabilities };
}

function validateScoreAnswer(levels: readonly string[], raw: Record<string, unknown>): ScoreAnswer {
  const indexes = levels.map((_level, index) => String(index));
  const probabilities = readDistribution(raw.probabilities, indexes);

  const rawLegend = raw.legend;
  if (!isRecord(rawLegend)) throw new DecisionError("legend_invalid");
  if (Object.keys(rawLegend).length !== levels.length) throw new DecisionError("legend_invalid");
  const legend = emptyRecord<string>();
  for (let index = 0; index < levels.length; index++) {
    // The legend must describe the levels that were supplied, not a rubric of
    // the provider's own.
    if (rawLegend[indexes[index]] !== levels[index]) throw new DecisionError("legend_invalid");
    legend[indexes[index]] = levels[index];
  }

  const score = raw.score;
  if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > levels.length - 1) {
    throw new DecisionError("score_invalid");
  }
  // A Score is probability-weighted and legitimately lands between levels, so
  // it is checked against the distribution it came with — not against the
  // highest-probability level.
  let weighted = 0;
  for (let index = 0; index < levels.length; index++) {
    weighted += index * probabilities[indexes[index]];
  }
  if (Math.abs(weighted - score) > DECISION_LIMITS.scoreTolerance) {
    throw new DecisionError("score_inconsistent");
  }
  return { type: "score", score, confidence: readConfidence(raw.confidence), legend, probabilities };
}

function validateNoulAnswer(raw: Record<string, unknown>): NoulAnswer {
  const noul = raw.noul;
  if (typeof noul !== "number" || !Number.isFinite(noul) || noul < 0 || noul > 1) {
    throw new DecisionError("noul_invalid");
  }
  // Noul carries no confidence and no boolean verdict; neither is invented here.
  return { type: "noul", noul };
}

/** @internal Token counts are only recorded when they are plain nonnegative integers. */
export function readUsage(
  usage: unknown,
  inputField: string,
  outputField: string
): { inputTokens: number; outputTokens: number } | undefined {
  if (!isRecord(usage)) return undefined;
  const count = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  const inputTokens = count(usage[inputField]);
  const outputTokens = count(usage[outputField]);
  return inputTokens === undefined || outputTokens === undefined
    ? undefined
    : { inputTokens, outputTokens };
}
