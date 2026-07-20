/**
 * sportsclaw — shared runtime helpers for the Momentum Explainer pipeline and
 * its demo/live/replay runners. Extracted so the bridge-envelope contract and
 * the runner boilerplate live in ONE place (they were copy-pasted across the
 * three runners and re-implemented inline in the explainer).
 */

import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The sportsclaw repo root, resolved from this module's built location. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", ".."); // dist/intelligence -> <sportsclaw>

/** Positive-integer env var with a fallback (ignores blank/invalid/<=0). */
export function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * The macOS cert fix: certifi bundle path for Python urllib, or undefined.
 * execFileSync with an argv array (never a shell string) so a pythonPath
 * carrying shell metacharacters can't be interpolated into a command.
 */
export function certifiPath(pythonPath: string): string | undefined {
  try {
    return execFileSync(pythonPath, ["-c", "import certifi; print(certifi.where())"], {
      encoding: "utf8",
    }).trim();
  } catch {
    return undefined;
  }
}

/**
 * Unwrap a Python-bridge result, enforcing the sports-skills
 * `{status, data, message}` envelope — NOT just the process-level `success`
 * flag. The bridge exits 0 and reports `success: true` for any parseable
 * stdout, so a skill that returned `status: false` (or an empty-but-valid
 * envelope) would otherwise be read as a valid empty payload. Throws with the
 * skill's own message on `status !== true` or missing data; `what` labels the
 * call site.
 */
export function unwrapBridge(
  result: { success: boolean; data?: unknown; error?: string },
  what: string,
): Record<string, unknown> {
  const envelope =
    result.success && result.data && typeof result.data === "object"
      ? (result.data as Record<string, unknown>)
      : null;
  if (!envelope || envelope.status !== true) {
    const msg =
      (envelope && String(envelope.message ?? "")) || result.error || "unknown error";
    throw new Error(`${what} failed: ${msg}`);
  }
  const data = envelope.data;
  if (!data || typeof data !== "object") {
    throw new Error(`${what} returned no data`);
  }
  return data as Record<string, unknown>;
}
