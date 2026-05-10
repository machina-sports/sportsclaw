/**
 * SportsClaw — prompt fragments + system prompt builder
 *
 * Pluggable text fragments composed into the system prompt at engine init,
 * keyed by execution context (cron / interactive / etc.). Adapted from
 * Hermes' `PLATFORM_HINTS` + tool-use discipline pattern (see external
 * review notes).
 *
 * The cron-mode autonomy fragment and tool-discipline fragment together
 * stop a Gemini-class model from rambling instead of dispatching tools —
 * this is the small-LOC fix with the largest behavioural win for the
 * autonomous operator daemon.
 *
 * The `[SILENT]` sentinel fragment teaches the model to vote "no useful
 * broadcast this tick" instead of forcing us to ship empty narration.
 *
 * No I/O. Pure string composition.
 */

// ---------------------------------------------------------------------------
// Fragments
// ---------------------------------------------------------------------------

export const CRON_AUTONOMY_FRAGMENT = `
# Autonomous mode

You are running on a scheduler, not in a chat. There is no human present.

- Do not ask clarifying questions. There is no one to answer.
- Do not request approvals. The cron contract is your approval to act.
- Execute the task fully and autonomously. If the task is ambiguous,
  pick the safer path — lean on fallback content, return [SILENT], or
  reduce the scope rather than escalate.
- Your final response is broadcast/telemetry, not a chat reply. Treat
  every word as on-air content.
`.trim();

export const TOOL_DISCIPLINE_FRAGMENT = `
# Tool use discipline

- Make tool calls in parallel when they are independent. Do not serialise.
- Do not narrate the plan. Execute it.
- Do not ask permission to call a tool. The user is not here to grant it.
- If a tool fails: classify the error. Retry only when the error is
  transient. Otherwise fall through to a safer path or return [SILENT].
- The final assistant text must be ONLY the broadcast/telemetry summary
  suitable for the on-air reasoning trail. No prefatory "Here is what I
  did", no trailing "Let me know if you want changes". Just the summary.
`.trim();

export const SILENT_SENTINEL_FRAGMENT = `
# The [SILENT] sentinel

If a tick has nothing meaningful to broadcast — no new data, no editorial
change, no fan signal worth surfacing — return EXACTLY \`[SILENT]\` as
your final response. The runtime suppresses delivery; nothing pollutes
the trail; no tokens are wasted on empty narration.

Use [SILENT] when:
- Nothing has changed since the previous brief on this job.
- An upstream dependency is unavailable and you have no useful fallback.
- The wake-gate fired but inspection shows no editorial action is due.

Do not use [SILENT] to avoid hard work. If the cron contract says "plan
the next 60 minutes," plan it.
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
