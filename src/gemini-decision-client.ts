/**
 * Gemini decision provider: Google's Decisions API behind the shared decision types.
 *
 * Same request, same answer shape, same consent, bounds, deadline and answer checks as
 * `JevDecisionClient` (they live in `decision-client.ts`). This module is only the wire:
 *
 *   - the state travels as `input`: a string as it is, a structured state as its JSON text;
 *   - a true/false question's descriptions are `true_description` / `false_description`;
 *   - question keys are limited to letters, digits, `_` and `-`;
 *   - the service does not report which model answered, so a receipt's `model` stays unset;
 *   - it returns a confidence with a true/false answer; the shared answer carries the
 *     probability only, as it does for Jev;
 *   - input the service's safety filters block is `content_blocked`.
 *
 * `DECISION_LIMITS` applies unchanged, although this service accepts more (1,000
 * questions, 255 score levels): a request that is valid for one provider is valid for both.
 *
 * Wire shapes follow Google's published guide. Media input (image, audio, video, PDF) is
 * part of that API and not of this client.
 */

import {
  DecisionError,
  decisionSettings,
  emptyRecord,
  isRecord,
  parseResponseRecord,
  readUsage,
  runDecision,
  validateAnswers,
  type DecisionCallOptions,
  type DecisionDataPolicy,
  type DecisionProvider,
  type DecisionRequest,
  type DecisionResult,
  type DecisionSettings,
  type DecisionWire,
  type JevDecisionClientConfig,
} from "./decision-client.js";

/** Fixed HTTPS endpoint. Callers cannot point this anywhere else. */
export const GEMINI_DECISIONS_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/decisions";

export const DEFAULT_GEMINI_DECISION_MODEL = "gemini-decision-1";

const MODEL_PATTERN = /^gemini-decision-[a-z0-9][a-z0-9.-]*$/;

/** Question keys the service accepts. Length is already bounded by `DECISION_LIMITS.maxIdChars`. */
const QUESTION_KEY = /^[A-Za-z0-9_-]+$/;

/** `error.code` values of a 400 that mean the input was blocked, not that the request was wrong. */
const BLOCK_CODES: ReadonlySet<unknown> = new Set([
  "safety",
  "prohibited_content",
  "blocklist",
  "image_safety",
  "content_blocked",
]);

/** Trusted, caller-authored configuration. The key is read from `GEMINI_API_KEY` at call time. */
export interface GeminiDecisionClientConfig extends Omit<JevDecisionClientConfig, "model"> {
  /** A `gemini-decision-*` model. Default: `gemini-decision-1`. */
  model?: string;
}

const GEMINI_WIRE: DecisionWire = {
  provider: "gemini",
  endpoint: GEMINI_DECISIONS_ENDPOINT,
  credentialEnv: "GEMINI_API_KEY",
  headers: (apiKey) => ({ "x-goog-api-key": apiKey }),
  body(model, snapshot) {
    const input = typeof snapshot.state === "string" ? snapshot.state : JSON.stringify(snapshot.state);
    if (input === "") throw new DecisionError("invalid_state");
    const questions = emptyRecord<unknown>();
    for (const question of snapshot.questions) {
      if (!QUESTION_KEY.test(question.id)) throw new DecisionError("invalid_questions");
      const criteria = question.payload.criteria;
      questions[question.id] =
        question.kind === "noul" && isRecord(criteria)
          ? {
              ...question.payload,
              criteria: {
                ...(criteria.true === undefined ? {} : { true_description: criteria.true }),
                ...(criteria.false === undefined ? {} : { false_description: criteria.false }),
              },
            }
          : question.payload;
    }
    return { model, input, questions };
  },
  refusal(status, text) {
    if (status !== 400) return undefined;
    const error = parseResponseRecord(text).error;
    return isRecord(error) && BLOCK_CODES.has(error.code) ? "content_blocked" : undefined;
  },
  read(text, snapshot) {
    const parsed = parseResponseRecord(text);
    // The API reference also describes a block as a 2xx with no answers and a stated reason.
    const feedback = parsed.prompt_feedback;
    if (isRecord(feedback) && typeof feedback.block_reason === "string" && feedback.block_reason !== "") {
      throw new DecisionError("content_blocked");
    }
    return {
      answers: validateAnswers(parsed.answers, snapshot),
      usage: readUsage(parsed.usage, "total_input_tokens", "total_output_tokens"),
    };
  },
};

export class GeminiDecisionClient implements DecisionProvider {
  readonly provider = "gemini";
  readonly dataPolicy: DecisionDataPolicy;
  readonly model: string;
  readonly timeoutMs: number;
  private readonly settings: DecisionSettings;

  constructor(config: GeminiDecisionClientConfig = {}) {
    this.settings = decisionSettings(config, {
      fallback: DEFAULT_GEMINI_DECISION_MODEL,
      pattern: MODEL_PATTERN,
      expected: "a gemini-decision-* identifier",
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
    return runDecision(GEMINI_WIRE, this.settings, request, options);
  }
}
