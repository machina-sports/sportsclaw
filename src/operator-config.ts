/**
 * Operator Job Config — schema + loader for `~/.sportsclaw/operator/<jobId>.json`.
 *
 * One file per autonomous job. Read by `sportsclaw operate --job <jobId>`
 * and by the supervised form (`sportsclaw start operator <jobId>`).
 *
 * Required: jobId, intervalMs.
 * Persona: exactly one of `persona` (MCP-resolved by name) or `personaText`.
 *
 * No I/O outside `loadOperatorJobConfig` / `listOperatorJobs`. All other
 * helpers are pure validators so they're easy to test.
 */

import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

import type { LLMProvider, OpenShellConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OperatorJobConfig {
  /** Unique job id. Must match the filename basename. */
  jobId: string;
  /** Human-readable label, shown in logs + supervisor. Defaults to jobId. */
  label?: string;
  /** Tick interval in ms. Must be > 0. */
  intervalMs: number;
  /** EITHER an MCP-resolvable prompt name (resolved at runtime via get_prompt_by_name)... */
  persona?: string;
  /** ...OR inline persona text. One of these two is required. */
  personaText?: string;
  /** AI SDK model id. Defaults to sportsclaw config. */
  model?: string;
  /** Provider override. Defaults to sportsclaw config. */
  provider?: LLMProvider;
  /** Persistence + brief root. Defaults to ~/.sportsclaw/operator/<jobId>/. */
  rootDir?: string;
  /**
   * Domain-specific endpoint URL — sinks read this from `ctx.cfg.tailServer`
   * to know where to POST telemetry events. The bundled sportsclaw daemon
   * doesn't interpret this field directly; the resolved sink does.
   */
  tailServer?: string;
  /**
   * Domain plugin that hooks into the daemon's events. One of:
   *   - "noop"             → no-op sink (TickEvents stream to stdout)
   *   - "./path/to/sink"   → filesystem path (resolved against cwd)
   *   - "/abs/path/sink"   → absolute filesystem path
   *   - "@scope/package"   → npm package name (dynamic import)
   * Omit for the noop sink default.
   */
  sink?: string;
  /**
   * Extra system-prompt fragments. Each string is resolved against
   * prompts.ts exports first (e.g. "broadcast-directive" →
   * BROADCAST_DIRECTIVE_FRAGMENT) and used as inline text otherwise.
   */
  extraFragments?: string[];
  /** Tool guardrail overrides — passed through to ToolGuardController. */
  guardOptions?: Record<string, unknown>;
  /**
   * Free-form sink role flag. sportsclaw doesn't interpret it; the resolved
   * sink reads it via `ctx.cfg.sinkRole` to branch behaviour (e.g. the tv
   * broadcast sink switches between "broadcast" anchor mode and
   * "video-producer" cadence mode). Keep it short and slugged.
   *
   * Named `sinkRole` (not `role`) to avoid collision with
   * `OperatorDaemonConfig.role`, which holds the persona/system-prompt text.
   */
  sinkRole?: string;
  /**
   * Register the daemon-owned memory writeback tools (add_lesson,
   * replace_lesson, remove_lesson). The LLM can call these to evolve its
   * own cross-tick memory. Writes appear in the NEXT tick's system prompt
   * — the current tick sees a frozen snapshot. Default: true.
   */
  enableMemoryTools?: boolean;
  /**
   * Opt in to routing LLM calls through NVIDIA OpenShell's Privacy Router.
   * Absent block = default direct LLM calls; nothing changes. When present
   * and enabled, the launcher constructs the AI SDK provider with a
   * `baseURL` pointing at `inference.local` (or the configured `baseUrl`).
   * See `openshell/README.md` for the deployment runbook.
   */
  openshell?: OpenShellConfig;
}

export interface ValidationIssue {
  field: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
  /** Populated only when valid. */
  config?: OperatorJobConfig;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Directory holding all operator job configs. */
export function operatorConfigDir(): string {
  return path.join(homedir(), ".sportsclaw", "operator");
}

/** Path to the JSON file for a given jobId. */
export function operatorConfigPath(jobId: string): string {
  return path.join(operatorConfigDir(), `${jobId}.json`);
}

/** Default rootDir for a job — used by HeartbeatService persistence + briefs. */
export function defaultRootDir(jobId: string): string {
  return path.join(operatorConfigDir(), jobId);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const VALID_PROVIDERS: ReadonlySet<LLMProvider> = new Set<LLMProvider>([
  "anthropic",
  "openai",
  "google",
]);

const JOB_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * Validate a parsed JSON object against the OperatorJobConfig schema.
 * Returns line-precise field errors via `issues`. `valid: true` guarantees
 * `config` is populated and safe to cast.
 */
export function validateOperatorJobConfig(
  input: unknown,
  opts: { sourcePath?: string } = {},
): ValidationResult {
  const issues: ValidationIssue[] = [];
  const push = (field: string, message: string) => issues.push({ field, message });

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    push("", "expected a JSON object at the top level");
    return { valid: false, issues };
  }
  const raw = input as Record<string, unknown>;

  // jobId
  if (typeof raw.jobId !== "string" || !raw.jobId) {
    push("jobId", "missing required string");
  } else if (!JOB_ID_PATTERN.test(raw.jobId)) {
    push(
      "jobId",
      `must match ${JOB_ID_PATTERN.source} (got ${JSON.stringify(raw.jobId)})`,
    );
  } else if (opts.sourcePath) {
    const expected = path.basename(opts.sourcePath, ".json");
    if (raw.jobId !== expected) {
      push(
        "jobId",
        `jobId "${raw.jobId}" must match filename basename "${expected}"`,
      );
    }
  }

  // intervalMs
  if (typeof raw.intervalMs !== "number" || !Number.isFinite(raw.intervalMs)) {
    push("intervalMs", "missing required number");
  } else if (raw.intervalMs <= 0) {
    push("intervalMs", `must be > 0 (got ${raw.intervalMs})`);
  }

  // persona / personaText — exactly one required
  const hasPersona = typeof raw.persona === "string" && raw.persona.length > 0;
  const hasPersonaText =
    typeof raw.personaText === "string" && raw.personaText.length > 0;
  if (!hasPersona && !hasPersonaText) {
    push("persona|personaText", "exactly one of 'persona' or 'personaText' is required");
  } else if (hasPersona && hasPersonaText) {
    push(
      "persona|personaText",
      "exactly one of 'persona' or 'personaText' may be set, not both",
    );
  }
  if (raw.persona !== undefined && typeof raw.persona !== "string") {
    push("persona", "must be a string (MCP prompt name)");
  }
  if (raw.personaText !== undefined && typeof raw.personaText !== "string") {
    push("personaText", "must be a string");
  }

  // label
  if (raw.label !== undefined && typeof raw.label !== "string") {
    push("label", "must be a string");
  }

  // model
  if (raw.model !== undefined && typeof raw.model !== "string") {
    push("model", "must be a string");
  }

  // provider
  if (raw.provider !== undefined) {
    if (typeof raw.provider !== "string" || !VALID_PROVIDERS.has(raw.provider as LLMProvider)) {
      push(
        "provider",
        `must be one of ${[...VALID_PROVIDERS].join(", ")} (got ${JSON.stringify(raw.provider)})`,
      );
    }
  }

  // rootDir
  if (raw.rootDir !== undefined && typeof raw.rootDir !== "string") {
    push("rootDir", "must be a string");
  }

  // tailServer
  if (raw.tailServer !== undefined) {
    if (typeof raw.tailServer !== "string") {
      push("tailServer", "must be a string URL");
    } else {
      try {
        const url = new URL(raw.tailServer);
        if (url.protocol !== "http:" && url.protocol !== "https:") {
          push("tailServer", "must be http(s)");
        }
      } catch {
        push("tailServer", `not a valid URL: ${JSON.stringify(raw.tailServer)}`);
      }
    }
  }

  // sink
  if (raw.sink !== undefined && (typeof raw.sink !== "string" || !raw.sink.trim())) {
    push("sink", "must be a non-empty string (e.g. \"noop\", \"broadcast\", or a package/path)");
  }

  // extraFragments
  if (raw.extraFragments !== undefined) {
    if (!Array.isArray(raw.extraFragments)) {
      push("extraFragments", "must be an array of strings");
    } else {
      for (let i = 0; i < raw.extraFragments.length; i++) {
        if (typeof raw.extraFragments[i] !== "string") {
          push(`extraFragments[${i}]`, "must be a string");
        }
      }
    }
  }

  // guardOptions
  if (
    raw.guardOptions !== undefined &&
    (typeof raw.guardOptions !== "object" || raw.guardOptions === null || Array.isArray(raw.guardOptions))
  ) {
    push("guardOptions", "must be an object");
  }

  // enableMemoryTools
  if (raw.enableMemoryTools !== undefined && typeof raw.enableMemoryTools !== "boolean") {
    push("enableMemoryTools", "must be a boolean");
  }

  // openshell — optional opt-in routing block
  let parsedOpenShell: OpenShellConfig | undefined;
  if (raw.openshell !== undefined) {
    if (typeof raw.openshell !== "object" || raw.openshell === null || Array.isArray(raw.openshell)) {
      push("openshell", "must be an object");
    } else {
      const os = raw.openshell as Record<string, unknown>;
      if (os.enabled !== undefined && typeof os.enabled !== "boolean") {
        push("openshell.enabled", "must be a boolean");
      }
      if (os.baseUrl !== undefined) {
        if (typeof os.baseUrl !== "string") {
          push("openshell.baseUrl", "must be a string URL");
        } else {
          try {
            const url = new URL(os.baseUrl);
            if (url.protocol !== "http:" && url.protocol !== "https:") {
              push("openshell.baseUrl", "must be http(s)");
            }
          } catch {
            push("openshell.baseUrl", `not a valid URL: ${JSON.stringify(os.baseUrl)}`);
          }
        }
      }
      // D1 — Gemini cannot route through the Privacy Router (Google's API
      // shape is neither OpenAI-compatible nor Anthropic-compatible). Fail
      // fast at config-load time rather than at the first generateText.
      const openShellEnabled = os.enabled !== false; // default true when block present
      if (openShellEnabled && raw.provider === "google") {
        push(
          "openshell",
          "provider \"google\" is not supported under openshell — the Privacy Router doesn't speak Google's protocol. Drop the openshell block or pick provider \"anthropic\" / \"openai\".",
        );
      }
      parsedOpenShell = {
        enabled: os.enabled as boolean | undefined,
        baseUrl: os.baseUrl as string | undefined,
      };
    }
  }

  if (issues.length > 0) {
    return { valid: false, issues };
  }

  return {
    valid: true,
    issues: [],
    config: {
      jobId: raw.jobId as string,
      label: raw.label as string | undefined,
      intervalMs: raw.intervalMs as number,
      persona: raw.persona as string | undefined,
      personaText: raw.personaText as string | undefined,
      model: raw.model as string | undefined,
      provider: raw.provider as LLMProvider | undefined,
      rootDir: raw.rootDir as string | undefined,
      tailServer: raw.tailServer as string | undefined,
      sink: raw.sink as string | undefined,
      extraFragments: raw.extraFragments as string[] | undefined,
      guardOptions: raw.guardOptions as Record<string, unknown> | undefined,
      sinkRole: raw.sinkRole as string | undefined,
      enableMemoryTools: raw.enableMemoryTools as boolean | undefined,
      openshell: parsedOpenShell,
    },
  };
}

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

/** Load + validate a job config by id. Throws with line-precise errors on failure. */
export function loadOperatorJobConfig(jobId: string): { config: OperatorJobConfig; path: string } {
  if (!jobId || !JOB_ID_PATTERN.test(jobId)) {
    throw new Error(
      `Invalid jobId ${JSON.stringify(jobId)} — must match ${JOB_ID_PATTERN.source}`,
    );
  }
  const filePath = operatorConfigPath(jobId);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Operator job config not found: ${filePath}`);
  }
  let parsed: unknown;
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Failed to read ${filePath}: ${err instanceof Error ? err.message : err}`,
    );
  }
  const result = validateOperatorJobConfig(parsed, { sourcePath: filePath });
  if (!result.valid || !result.config) {
    const lines = result.issues.map((i) => `  - ${i.field || "<root>"}: ${i.message}`);
    throw new Error(
      `Operator job config invalid: ${filePath}\n${lines.join("\n")}`,
    );
  }
  return { config: result.config, path: filePath };
}

/** List all job config files in `~/.sportsclaw/operator/`. */
export function listOperatorJobs(): Array<{ jobId: string; path: string }> {
  const dir = operatorConfigDir();
  if (!fs.existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const jobId = f.slice(0, -".json".length);
      return { jobId, path: path.join(dir, f) };
    })
    // Operator-controlled filenames may not match JOB_ID_PATTERN — quietly hide
    // those rather than fail listing.
    .filter(({ jobId }) => JOB_ID_PATTERN.test(jobId))
    .sort((a, b) => (a.jobId < b.jobId ? -1 : a.jobId > b.jobId ? 1 : 0));
}
