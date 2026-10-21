/**
 * Which process.env entries SportsClaw itself filled from ~/.sportsclaw/.env or
 * config.json (`applyConfigToEnv`). OpenShell credentials and the sandbox
 * marker must come from the workload's real environment, so the OpenShell
 * resolver ignores values recorded here. Direct-mode auth never consults it.
 *
 * Holds only what hydration itself wrote; an entry stops counting as hydrated
 * as soon as the live value differs (e.g. a caller set it explicitly).
 */

const hydrated = new Map<string, string>();

/** Record that `key` was set to `value` by config hydration. */
export function markHydrated(key: string, value: string): void {
  hydrated.set(key, value);
}

/**
 * The value of `key` as provided by the workload. For `process.env`, a value
 * that config hydration wrote (and nobody has changed since) reads as unset.
 * An explicitly passed env object is trusted as-is.
 */
export function workloadEnvValue(key: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env[key];
  if (value !== undefined && env === process.env && hydrated.get(key) === value) return undefined;
  return value;
}
