/**
 * Rights check — an operator-level switch, not a per-request field.
 * Default is "require". Only the exact string "off" turns it off.
 *
 * Under "require", a source is cleared only by a MediaClearance for its exact sha256, from
 * operator config (media.clearances) or the app starting the run (RunOptions.mediaClearances).
 */

import type { MediaClearance, RightsCheckMode } from "./types.js";

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

const SHA_RE = /^[0-9a-f]{64}$/;
const CLEARANCE_KEYS = new Set(["sourceSha256", "rightsHolder", "licenseRef", "clearedForClipping", "territories"]);

/**
 * Validates clearances from operator config or run options. Throws on anything malformed: a bad
 * clearance is a configuration error, never silently dropped. `where` names the setting in the message.
 */
export function parseClearances(value: unknown, where: string): MediaClearance[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${where} must be a list of clearances`);
  return value.map((c, i) => {
    const at = `${where}[${i}]`;
    if (!c || typeof c !== "object" || Array.isArray(c)) throw new Error(`${at} must be an object`);
    const o = c as Record<string, unknown>;
    for (const key of Object.keys(o)) if (!CLEARANCE_KEYS.has(key)) throw new Error(`${at} has an unknown field "${key}"`);
    if (typeof o.sourceSha256 !== "string" || !SHA_RE.test(o.sourceSha256)) {
      throw new Error(`${at}.sourceSha256 must be 64 lowercase hex characters (the source file's sha256)`);
    }
    if (typeof o.rightsHolder !== "string" || o.rightsHolder.trim() === "") throw new Error(`${at}.rightsHolder must be a non-empty string`);
    if (typeof o.licenseRef !== "string" || o.licenseRef.trim() === "") throw new Error(`${at}.licenseRef must be a non-empty string`);
    if (typeof o.clearedForClipping !== "boolean") throw new Error(`${at}.clearedForClipping must be true or false`);
    if (o.territories !== undefined && (!Array.isArray(o.territories) || !o.territories.every((t) => typeof t === "string"))) {
      throw new Error(`${at}.territories must be a list of strings`);
    }
    return {
      sourceSha256: o.sourceSha256,
      rightsHolder: o.rightsHolder,
      licenseRef: o.licenseRef,
      clearedForClipping: o.clearedForClipping,
      ...(o.territories !== undefined ? { territories: [...(o.territories as string[])] } : {}),
    };
  });
}
