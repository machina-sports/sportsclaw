/**
 * Final activeTools decision for a turn.
 *
 * The Vercel AI SDK only sends the tool definitions named in `activeTools` to
 * the provider. Returning `undefined` therefore means "send the entire tool
 * registry", which is only safe while the registry is small.
 */

/**
 * Largest tool array providers accept in one request. Azure Foundry / OpenAI
 * reject anything above it ("Invalid tools: array too long. Expected maximum
 * 128, got 291").
 */
export const PROVIDER_TOOL_CEILING = 128;

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
}

/**
 * Resolve the `activeTools` value passed to the AI SDK.
 *
 * On low-confidence follow-ups the filter is dropped so the LLM can reach any
 * tool from conversation context — but only when the whole registry fits under
 * `PROVIDER_TOOL_CEILING`. Above the ceiling, dropping the filter would send a
 * tool array the provider rejects outright, so the routed filter is kept
 * instead. Any surviving filter is widened with the tools referenced by history
 * so historical tool_use blocks still resolve. Nothing is ever truncated:
 * the routed filter plus history is the minimum the request needs to be valid.
 */
export function finalizeActiveTools(
  input: FinalizeActiveToolsInput
): string[] | undefined {
  const registryFitsProvider = input.totalToolCount <= PROVIDER_TOOL_CEILING;
  let active =
    input.isFollowUp && input.lowConfidence && registryFitsProvider
      ? undefined
      : input.routedActiveTools;

  if (active && input.isFollowUp && input.historyToolNames.length > 0) {
    const merged = new Set(active);
    for (const name of input.historyToolNames) merged.add(name);
    active = Array.from(merged);
  }

  return active;
}
