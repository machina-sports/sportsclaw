/**
 * sportsclaw — Response Evaluator
 *
 * Soft post-generation quality gate. Checks whether the response aligns with
 * the detected query intent. Pure string/set operations — no LLM calls.
 *
 * This is diagnostic, not blocking: failures are logged in verbose mode but
 * do not modify the user-facing response. The data helps identify patterns
 * where the prompt injection or tool routing needs tuning.
 */

import { getTemplate, type QueryIntent } from "./response-templates.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EvalResult {
  passed: boolean;
  /** Required keywords absent from the response */
  missingKeywords: string[];
  /** Expected tool patterns that had no matching tool calls */
  toolsNotCalled: string[];
}

// ---------------------------------------------------------------------------
// evaluateResponse
// ---------------------------------------------------------------------------

/**
 * Evaluate a final response against the expected shape for its query intent.
 *
 * @param response    The final response text returned to the user.
 * @param toolsUsed   Names of tools that succeeded this turn.
 * @param intent      The query intent detected by the router.
 */
export function evaluateResponse(
  response: string,
  toolsUsed: string[],
  intent: QueryIntent
): EvalResult {
  const template = getTemplate(intent);
  const lower = response.toLowerCase();

  // Check required keywords (only for intents that specify them)
  const missingKeywords = template.requiredKeywords.filter(
    (kw) => !lower.includes(kw.toLowerCase())
  );

  // Check that at least one expected tool pattern matched
  const toolsNotCalled = template.expectedToolPatterns.filter(
    (pattern) => !toolsUsed.some((t) => t.toLowerCase().includes(pattern))
  );

  // Pass if: no required keywords missing, OR at least one tool was called
  // (A response can be valid even without keyword matches if tools ran and
  // returned data — the LLM may phrase things differently across sports.)
  const passed =
    missingKeywords.length === 0 ||
    toolsUsed.length > 0;

  return { passed, missingKeywords, toolsNotCalled };
}
