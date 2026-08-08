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

/**
 * Raised locally — before the AI SDK / provider call — when the explicit
 * `activeTools` list itself exceeds the provider ceiling. Truncating it would
 * silently drop tools the turn (or its history) depends on, so the turn fails
 * loudly instead.
 */
export class ProviderToolCeilingError extends Error {
  readonly ceiling = PROVIDER_TOOL_CEILING;
  readonly count: number;

  constructor(count: number) {
    super(
      `activeTools carries ${count} tools, above the ${PROVIDER_TOOL_CEILING}-tool provider ceiling. ` +
        `Refusing to truncate: narrow the routed skills or reduce the installed tool registry.`
    );
    this.name = "ProviderToolCeilingError";
    this.count = count;
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
 *
 * Above the ceiling the result is always an explicit array — even when routing
 * produced no filter at all — because `undefined` there means "send all 291
 * tools" and the provider rejects that outright. If the explicit list itself
 * cannot fit the ceiling, the turn fails locally with
 * `ProviderToolCeilingError` rather than being silently truncated.
 */
export function finalizeActiveTools(
  input: FinalizeActiveToolsInput
): string[] | undefined {
  const registryFitsProvider = input.totalToolCount <= PROVIDER_TOOL_CEILING;
  let active =
    input.isFollowUp && input.lowConfidence && registryFitsProvider
      ? undefined
      : input.routedActiveTools;

  // Fail closed: an oversized registry must never resolve to `undefined`. A
  // first turn gets an empty list; a follow-up is widened with history below,
  // so its historical tool calls stay defined.
  if (active === undefined && !registryFitsProvider) active = [];

  if (active && input.isFollowUp && input.historyToolNames.length > 0) {
    const merged = new Set(active);
    for (const name of input.historyToolNames) merged.add(name);
    active = Array.from(merged);
  }

  if (active && active.length > PROVIDER_TOOL_CEILING) {
    throw new ProviderToolCeilingError(active.length);
  }

  return active;
}
