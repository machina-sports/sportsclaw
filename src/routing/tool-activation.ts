/**
 * Final activeTools decision for a turn.
 *
 * The Vercel AI SDK only sends the tool definitions named in `activeTools` to
 * the provider. Returning `undefined` therefore means "send the entire tool
 * registry", which is only safe while the registry is small.
 */

/**
 * Largest tool array accepted by the providers with a known request ceiling.
 */
export const PROVIDER_TOOL_CEILING = 128;

import type { LLMProvider } from "../types.js";

/** Return the provider's tool ceiling, or `undefined` for unlimited legacy behavior. */
export function providerToolCeiling(provider: LLMProvider): number | undefined {
  return provider === "openai" || provider === "azure-foundry"
    ? PROVIDER_TOOL_CEILING
    : undefined;
}

/**
 * Raised locally — before the AI SDK / provider call — when the explicit
 * `activeTools` list itself exceeds the provider ceiling. Truncating it would
 * silently drop tools the turn (or its history) depends on, so the turn fails
 * loudly instead.
 */
export class ProviderToolCeilingError extends Error {
  readonly ceiling: number;
  readonly count: number;

  constructor(count: number, ceiling: number = PROVIDER_TOOL_CEILING) {
    super(
      `activeTools carries ${count} tools, above the ${ceiling}-tool provider ceiling. ` +
        `Refusing to truncate. Run /compact or start a fresh session, and narrow the routed skills if the overflow remains.`
    );
    this.name = "ProviderToolCeilingError";
    this.count = count;
    this.ceiling = ceiling;
  }
}

export interface FinalizeActiveToolsInput {
  /** Filtered tool names from skill routing (`undefined` = no filter produced). */
  routedActiveTools: string[] | undefined;
  /** Whether this is a follow-up turn in an existing session. */
  isFollowUp: boolean;
  /** Whether routing confidence fell below the clarify threshold. */
  lowConfidence: boolean;
  /** Tool names referenced by tool calls already in the session history. */
  historyToolNames: readonly string[];
  /** Size of the full tool registry for this turn. */
  totalToolCount: number;
  /** Provider ceiling (`undefined` preserves unlimited legacy behavior). */
  ceiling?: number;
}

/**
 * Resolve the `activeTools` value passed to the AI SDK.
 *
 * On low-confidence follow-ups the filter is dropped so the LLM can reach any
 * tool from conversation context — but only when the whole registry fits under
 * a configured ceiling. Above the ceiling, dropping the filter would send a
 * tool array the provider rejects outright, so the routed filter is kept
 * instead. Any surviving filter is widened with the tools referenced by history
 * so historical tool_use blocks still resolve. Nothing is ever truncated:
 * the routed filter plus history is the minimum the request needs to be valid.
 *
 * For capped providers, above the ceiling the result is always an explicit array — even when routing
 * produced no filter at all — because `undefined` there means "send all 291
 * tools" and the provider rejects that outright. If the explicit list itself
 * cannot fit the ceiling, the turn fails locally with
 * `ProviderToolCeilingError` rather than being silently truncated.
 */
export function finalizeActiveTools(
  input: FinalizeActiveToolsInput
): string[] | undefined {
  const registryFitsProvider =
    input.ceiling === undefined || input.totalToolCount <= input.ceiling;
  let active =
    input.isFollowUp && input.lowConfidence && registryFitsProvider
      ? undefined
      : input.routedActiveTools;

  // Fail closed: an oversized registry must never resolve to `undefined`. A
  // first turn gets an empty list; a follow-up is widened with history below,
  // so its historical tool calls stay defined.
  if (active === undefined && input.ceiling !== undefined && !registryFitsProvider) {
    active = [];
  }

  if (active && input.isFollowUp && input.historyToolNames.length > 0) {
    const merged = new Set(active);
    for (const name of input.historyToolNames) merged.add(name);
    active = Array.from(merged);
  }

  if (active && input.ceiling !== undefined && active.length > input.ceiling) {
    throw new ProviderToolCeilingError(active.length, input.ceiling);
  }

  return active;
}
