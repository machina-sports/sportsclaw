/**
 * sportsclaw — the judge: which decision provider answers typed questions.
 *
 * The model roles (`eyes`, `brain`, `hands`, `writer`) write: they are reached through
 * `invokeModelRole` and return text or media. A judge answers bounded questions (pick one,
 * rate, true/false) and returns probabilities, so it is not a fifth role and never goes
 * through a chat route. It is configured in the same block, as `inference.judge`, and built
 * here into a `DecisionProvider`.
 *
 * The key is never in config: Jev reads `TYPESAFE_API_KEY`, Gemini reads `GEMINI_API_KEY`,
 * each at call time.
 */

import {
  JevDecisionClient,
  type DecisionDataPolicy,
  type DecisionProvider,
  type DecisionProviderName,
  type DecisionTransport,
} from "../decision-client.js";
import { GeminiDecisionClient } from "../gemini-decision-client.js";

export const JUDGE_PROVIDERS = ["jev", "gemini"] as const satisfies readonly DecisionProviderName[];

export interface JudgeConfig {
  provider: DecisionProviderName;
  /** Default: the provider's own (`jev-1.13.0`, `gemini-decision-1`). */
  model?: string;
  /** Cloud consent. Anything but an explicit `cloud_allowed` sends nothing. */
  dataPolicy?: DecisionDataPolicy;
  /** Per-request deadline in ms (250–60000). Default: 8000. */
  timeoutMs?: number;
}

/** Seams for embedders and offline tests. */
export interface JudgeSeams {
  transport?: DecisionTransport;
  env?: Record<string, string | undefined>;
}

const JUDGE_KEYS: readonly string[] = ["provider", "model", "dataPolicy", "timeoutMs"];

/** The provider a judge entry names. Throws a `TypeError` for an entry no provider accepts. */
export function createDecisionProvider(judge: JudgeConfig, seams: JudgeSeams = {}): DecisionProvider {
  const { provider, ...settings } = judge;
  if (provider === "jev") return new JevDecisionClient({ ...settings, ...seams });
  if (provider === "gemini") return new GeminiDecisionClient({ ...settings, ...seams });
  throw new TypeError(`Judge provider must be one of ${JUDGE_PROVIDERS.join(", ")}.`);
}

/** What is wrong with a `judge` config entry, or undefined when it is usable. */
export function judgeConfigIssue(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "Judge config must be an object with a provider.";
  }
  const unknown = Object.keys(value).filter((key) => !JUDGE_KEYS.includes(key));
  if (unknown.length > 0) {
    return `Judge config has no ${unknown.join(", ")}: it takes ${JUDGE_KEYS.join(", ")}, and the key comes from the environment.`;
  }
  try {
    // The providers own their model, consent and deadline rules; ask them.
    createDecisionProvider(value as JudgeConfig);
  } catch (err) {
    return err instanceof TypeError ? `Judge config: ${err.message}` : "Judge config is not usable.";
  }
  return undefined;
}
