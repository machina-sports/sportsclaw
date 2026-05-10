/**
 * SportsClaw — prompt fragments + system prompt builder
 *
 * Pluggable text fragments composed into the system prompt at engine init,
 * keyed by execution context (cron / interactive / etc.). Adapted from
 * Hermes' `PLATFORM_HINTS` + tool-use discipline pattern (see external
 * review notes).
 *
 * The cron-autonomy fragment and tool-discipline fragment together stop a
 * Gemini-class model from rambling instead of dispatching tools — this is
 * the small-LOC fix with the largest behavioural win for any autonomous
 * worker, not just the broadcast operator.
 *
 * The `[SILENT]` sentinel fragment teaches the model to vote "no useful
 * action this tick" instead of forcing us to ship empty work.
 *
 * Domain coupling: CRON_AUTONOMY, TOOL_DISCIPLINE, and SILENT_SENTINEL are
 * deliberately written in domain-neutral language so betting / scouting /
 * fan-engagement / other autonomous workers can reuse them unchanged.
 * Broadcast-specific framing lives in BROADCAST_DIRECTIVE_FRAGMENT — pass
 * it via `extras` (or via the daemon's `extraFragments`) when the worker
 * IS a broadcast operator.
 *
 * No I/O. Pure string composition.
 */

// ---------------------------------------------------------------------------
// Fragments — domain-neutral
// ---------------------------------------------------------------------------

export const CRON_AUTONOMY_FRAGMENT = `
# Autonomous mode

You are running on a scheduler, not in a chat. There is no human present.

- Do not ask clarifying questions. There is no one to answer.
- Do not request approvals. The cron contract is your approval to act.
- Execute the task fully and autonomously. If the task is ambiguous,
  pick the safer path — lean on a fallback, return [SILENT], or reduce
  the scope rather than escalate.
- Your final response is the work product, not a chat reply. Treat
  every word as the final output for this tick.
`.trim();

export const TOOL_DISCIPLINE_FRAGMENT = `
# Tool use discipline

- Make tool calls in parallel when they are independent. Do not serialise.
- Do not narrate the plan. Execute it.
- Do not ask permission to call a tool. The user is not here to grant it.
- If a tool fails: classify the error. Retry only when the error is
  transient. Otherwise fall through to a safer path or return [SILENT].
- The final assistant text must be ONLY the output summary for this
  tick. No prefatory "Here is what I did", no trailing "Let me know if
  you want changes". Just the summary.
`.trim();

export const SILENT_SENTINEL_FRAGMENT = `
# The [SILENT] sentinel

If a tick has nothing worth surfacing — no new data, no state change, no
signal worth acting on — return EXACTLY \`[SILENT]\` as your final
response. The runtime suppresses delivery; nothing pollutes the trail;
no tokens are wasted on empty output.

Use [SILENT] when:
- Nothing has changed since the previous brief on this job.
- An upstream dependency is unavailable and you have no useful fallback.
- The wake-gate fired but inspection shows no action is due.

Do not use [SILENT] to avoid hard work. If the cron contract specifies a
task, complete it.
`.trim();

// ---------------------------------------------------------------------------
// Fragments — domain-specific (opt-in via extras)
// ---------------------------------------------------------------------------

/**
 * Broadcast-specific framing for the SportsClaw TV operator. Pass via
 * `extras` (or `OperatorDaemonConfig.extraFragments`) when the daemon's
 * role IS a broadcast editor. Non-broadcast domains (betting / scouting /
 * fan-engagement) supply their own directive fragments instead.
 */
export const BROADCAST_DIRECTIVE_FRAGMENT = `
# Broadcast directive

Your output for this tick is on-air content for a 24/7 sports channel.

- Treat every word as broadcast/telemetry — viewers will read or hear it.
- [SILENT] here maps to "no editorial action is due this tick" — use it
  when there is no new data, no editorial change, and no fan signal
  worth surfacing.
- Hard rules: no dead air, no invented live facts, fallback before
  hallucination.
`.trim();

export const EDITORIAL_MEMORY_FRAGMENT_HEADER = `
# Editorial memory (frozen snapshot)

Lessons and operator preferences accumulated across sessions. Treat as
ground truth. Updates to this memory happen via the memory tool; mid-tick
writes do not change this snapshot — that is by design, to keep the
prompt prefix stable for cache hits.
`.trim();

export const TICK_BRIEF_FRAGMENT_HEADER = `
# Previous tick brief

What the previous tick on this job decided / surfaced. Use this to avoid
repeating yourself, to continue work-in-progress, and to detect when
nothing has changed (in which case return [SILENT]).
`.trim();

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

const SECTION_DELIMITER = "\n\n---\n\n";

export interface BuildSystemPromptOptions {
  /**
   * The base SportsClaw role fragment — typically the "You are SportsClaw…"
   * paragraph. Required. Always lives at the top of the system prompt.
   */
  role: string;
  /** Include the cron-autonomy fragment. Default false. */
  isCron?: boolean;
  /** Include the tool-use discipline fragment. Default false. */
  toolDiscipline?: boolean;
  /** Include the [SILENT] sentinel fragment. Default false. */
  silentSentinel?: boolean;
  /**
   * Frozen snapshot from EditorialMemory. Pass the result of
   * `editorialMemory.snapshot()` here. When non-empty, gets a labelled
   * header + body section. Empty/whitespace-only values are skipped.
   */
  editorialMemorySnapshot?: string;
  /**
   * Optional handoff context from the previous tick(s) on this job —
   * typically the result of `lastTickBrief.contextFrom([jobId])`. Empty
   * values are skipped.
   */
  recentTickBrief?: string;
  /**
   * Optional extra fragments appended at the end (operator-specific
   * directives, e.g. project-specific framework documents). Empty entries
   * are skipped.
   */
  extras?: string[];
}

/**
 * Compose the system prompt from fragments. Sections are delimited by
 * `\n\n---\n\n`. Order is fixed: role → cron-autonomy → tool-discipline
 * → silent-sentinel → editorial-memory → tick-brief → extras. Empty
 * sections are dropped so the prompt prefix is short when nothing is on.
 */
export function buildSystemPrompt(options: BuildSystemPromptOptions): string {
  const parts: string[] = [];
  if (options.role.trim()) parts.push(options.role.trim());
  if (options.isCron) parts.push(CRON_AUTONOMY_FRAGMENT);
  if (options.toolDiscipline) parts.push(TOOL_DISCIPLINE_FRAGMENT);
  if (options.silentSentinel) parts.push(SILENT_SENTINEL_FRAGMENT);
  if (options.editorialMemorySnapshot && options.editorialMemorySnapshot.trim()) {
    parts.push(`${EDITORIAL_MEMORY_FRAGMENT_HEADER}\n\n${options.editorialMemorySnapshot.trim()}`);
  }
  if (options.recentTickBrief && options.recentTickBrief.trim()) {
    parts.push(`${TICK_BRIEF_FRAGMENT_HEADER}\n\n${options.recentTickBrief.trim()}`);
  }
  if (options.extras) {
    for (const extra of options.extras) {
      if (extra && extra.trim()) parts.push(extra.trim());
    }
  }
  return parts.join(SECTION_DELIMITER);
}

/**
 * The literal sentinel string. Hoisted here so callers do not duplicate it.
 * Mirror of `SILENT_SENTINEL` in last-tick-brief.ts; kept in sync by tests.
 */
export const SILENT_SENTINEL_TOKEN = "[SILENT]";
