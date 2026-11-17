/**
 * Rights check — an operator-level switch, not a per-request field.
 * Default is "require". Only the exact string "off" turns it off.
 */

import type { RightsCheckMode } from "./types.js";

export const RIGHTS_CHECK_ENV = "SPORTSCLAW_MEDIA_RIGHTS_CHECK";
export const RIGHTS_OFF_NOTE = "off (operator)";

/** Config wins over env; any value other than the exact string "off" is "require". */
export function resolveRightsCheck(
  config?: { rightsCheck?: unknown },
  env: Record<string, string | undefined> = process.env,
): RightsCheckMode {
  const configured = config?.rightsCheck;
  if (configured !== undefined) return configured === "off" ? "off" : "require";
  return env[RIGHTS_CHECK_ENV] === "off" ? "off" : "require";
}
