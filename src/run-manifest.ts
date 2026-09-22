/**
 * sportsclaw — Run manifest
 *
 * A run manifest records the configuration a response was produced under, so
 * any result can be traced back to an exact setup and two runs can be checked
 * for comparability.
 *
 * Two parts:
 *   - `config`: fields fixed before the run starts (provider, requested model,
 *     sampling pins, budgets, package versions, caller prompt hash, replay
 *     mode). `config_sha256` hashes exactly this block, so equal hashes mean
 *     comparable configurations.
 *   - `run`: what was observed during the run (served model, main system prompt
 *     hash, tools offered, provider warnings). These vary per prompt and per
 *     day (the system prompt carries the date), so they are excluded from
 *     `config_sha256`.
 *
 * The manifest never contains prompt text, credentials, or tool payloads —
 * only hashes and names.
 */

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import type { LLMProvider, SamplingConfig } from "./types.js";

export const RUN_MANIFEST_VERSION = 1;

const MAX_SEED = 2_147_483_647;

// ---------------------------------------------------------------------------
// Sampling
// ---------------------------------------------------------------------------

/**
 * Validate sampling pins. Throws with a user-facing message on invalid input
 * rather than letting a provider silently clamp or reject the value.
 */
export function validateSampling(sampling: SamplingConfig | undefined): SamplingConfig {
  const out: SamplingConfig = {};
  if (!sampling) return out;
  const { temperature, seed } = sampling;
  if (temperature !== undefined) {
    if (typeof temperature !== "number" || !Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
      throw new Error(`temperature must be a number between 0 and 2 (got ${String(temperature)})`);
    }
    out.temperature = temperature;
  }
  if (seed !== undefined) {
    if (typeof seed !== "number" || !Number.isInteger(seed) || seed < 0 || seed > MAX_SEED) {
      throw new Error(`seed must be an integer between 0 and ${MAX_SEED} (got ${String(seed)})`);
    }
    out.seed = seed;
  }
  return out;
}

/** Only the pins that are set, ready to spread into a generateText call. */
export function samplingCallOptions(sampling: SamplingConfig): { temperature?: number; seed?: number } {
  return {
    ...(sampling.temperature !== undefined ? { temperature: sampling.temperature } : {}),
    ...(sampling.seed !== undefined ? { seed: sampling.seed } : {}),
  };
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** JSON with object keys sorted at every level, so hashes ignore key order. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (typeof v === "function" || v === undefined) continue;
      out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

/**
 * Hash the tool surface offered to the model: each offered tool's name,
 * description and JSON schema (when the tool exposes one). Order-insensitive.
 */
export function hashToolSurface(tools: Record<string, unknown>, offered: readonly string[]): string {
  const surface = [...new Set(offered)].sort().map((name) => {
    const t = (tools[name] ?? {}) as { description?: unknown; inputSchema?: { jsonSchema?: unknown } };
    return {
      name,
      description: typeof t.description === "string" ? t.description : null,
      schema: t.inputSchema && typeof t.inputSchema === "object" ? (t.inputSchema.jsonSchema ?? null) : null,
    };
  });
  return sha256(stableStringify(surface));
}

// ---------------------------------------------------------------------------
// Provider warnings
// ---------------------------------------------------------------------------

/** Flatten AI SDK call warnings into stable, deduplicated strings. */
export function formatProviderWarnings(steps: ReadonlyArray<{ warnings?: unknown }> | undefined): string[] {
  const seen = new Set<string>();
  for (const step of steps ?? []) {
    const warnings = Array.isArray(step?.warnings) ? step.warnings : [];
    for (const w of warnings as Array<Record<string, unknown>>) {
      const kind = typeof w?.type === "string" ? w.type : "warning";
      const subject = w?.feature ?? w?.setting ?? w?.tool ?? w?.message;
      const details = typeof w?.details === "string" ? `: ${w.details}` : "";
      seen.add(`${kind}${subject !== undefined ? ` ${String(subject)}` : ""}${details}`);
    }
  }
  return [...seen].sort();
}

// ---------------------------------------------------------------------------
// Run trace (observed during engine.run)
// ---------------------------------------------------------------------------

export interface RunTrace {
  /** Model id reported by the provider response, when available. */
  servedModelId?: string;
  /** SHA-256 of the effective main-loop system prompt (varies per prompt/day). */
  mainSystemPromptSha256?: string;
  /** Tool names offered to the model in the main loop, sorted. */
  offeredTools: string[];
  /** Hash of offered tool names, descriptions and schemas. */
  toolSurfaceSha256: string;
  /** Deduplicated provider warnings, e.g. an ignored seed or temperature. */
  providerWarnings: string[];
  /** Whether the parallel-agents path produced the response. */
  parallelAgents: boolean;
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

export interface RunManifestConfig {
  sportsclaw_version: string;
  sports_skills_version: string | null;
  provider: LLMProvider;
  model: string;
  sampling: SamplingConfig;
  max_output_tokens: number;
  max_turns: number;
  thinking_budget: number;
  caller_system_prompt_sha256: string | null;
  replay_mode: string;
  tool_allowlist: string[] | null;
}

export interface RunManifest {
  manifest_version: number;
  config_sha256: string;
  config: RunManifestConfig;
  run: {
    served_model_id: string | null;
    main_system_prompt_sha256: string | null;
    offered_tools: string[];
    tool_surface_sha256: string | null;
    provider_warnings: string[];
    parallel_agents: boolean;
  } | null;
}

export interface BuildRunManifestInput {
  sportsclawVersion: string;
  sportsSkillsVersion?: string | null;
  provider: LLMProvider;
  model: string;
  sampling: SamplingConfig;
  maxOutputTokens: number;
  maxTurns: number;
  thinkingBudget: number;
  callerSystemPrompt?: string;
  toolAllowlist?: string[] | null;
  env?: Record<string, string | undefined>;
  trace?: RunTrace | null;
}

export function buildRunManifest(input: BuildRunManifestInput): RunManifest {
  const env = input.env ?? process.env;
  const config: RunManifestConfig = {
    sportsclaw_version: input.sportsclawVersion,
    sports_skills_version: input.sportsSkillsVersion ?? null,
    provider: input.provider,
    model: input.model,
    sampling: samplingCallOptions(input.sampling),
    max_output_tokens: input.maxOutputTokens,
    max_turns: input.maxTurns,
    thinking_budget: input.thinkingBudget,
    caller_system_prompt_sha256: input.callerSystemPrompt ? sha256(input.callerSystemPrompt) : null,
    replay_mode: (env.SPORTS_SKILLS_REPLAY ?? "off").trim().toLowerCase() || "off",
    tool_allowlist: input.toolAllowlist ? [...new Set(input.toolAllowlist)].sort() : null,
  };
  const trace = input.trace;
  return {
    manifest_version: RUN_MANIFEST_VERSION,
    config_sha256: sha256(stableStringify(config)),
    config,
    run: trace
      ? {
          served_model_id: trace.servedModelId ?? null,
          main_system_prompt_sha256: trace.mainSystemPromptSha256 ?? null,
          offered_tools: [...trace.offeredTools],
          tool_surface_sha256: trace.toolSurfaceSha256 ?? null,
          provider_warnings: [...trace.providerWarnings],
          parallel_agents: trace.parallelAgents,
        }
      : null,
  };
}

// ---------------------------------------------------------------------------
// sports-skills version
// ---------------------------------------------------------------------------

/** Installed sports-skills version from the configured interpreter, or null. */
export function readSportsSkillsVersion(pythonPath: string, timeoutMs = 10_000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      pythonPath,
      ["-c", "from sports_skills import __version__; print(__version__)"],
      { encoding: "utf-8", timeout: timeoutMs },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        const version = (stdout ?? "").trim();
        resolve(version || null);
      },
    );
  });
}

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------

/**
 * Remove `--temperature` / `--seed` (either `--flag value` or `--flag=value`)
 * from `args` in place and return the validated pins. Throws on a missing or
 * invalid value.
 */
export function takeSamplingArgs(args: string[]): SamplingConfig {
  const raw: SamplingConfig = {};
  for (const name of ["temperature", "seed"] as const) {
    const flag = `--${name}`;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      let value: string | undefined;
      if (arg === flag) {
        value = args[i + 1];
        if (value === undefined || value.startsWith("--")) {
          throw new Error(`${flag} requires a value`);
        }
        args.splice(i, 2);
      } else if (arg.startsWith(`${flag}=`)) {
        value = arg.slice(flag.length + 1);
        args.splice(i, 1);
      } else {
        continue;
      }
      if (value.trim() === "") throw new Error(`${flag} requires a value`);
      const parsed = Number(value);
      raw[name] = parsed;
      if (Number.isNaN(parsed)) {
        throw new Error(`${flag} must be a number (got ${JSON.stringify(value)})`);
      }
      i--;
    }
  }
  return validateSampling(raw);
}
