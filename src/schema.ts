/**
 * sportsclaw Engine — Schema Injection (Phase 3)
 *
 * Handles fetching sport-specific tool schemas from the Python `sports-skills`
 * package, persisting them to disk, and loading them at engine startup.
 *
 * Flow:
 *   1. `sportsclaw add nfl`
 *   2. Runs `python3 -m sports_skills nfl schema` → JSON tool definitions
 *   3. Saves to ~/.sportsclaw/schemas/nfl.json
 *   4. On next engine run, schemas are loaded and injected into the tool registry
 */

import { execFile, execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { SportSchema, sportsclawConfig } from "./types.js";
import { buildSubprocessEnv } from "./tools.js";
import { buildSportsSkillsRepairCommand, checkPythonVersion, MIN_PYTHON_VERSION } from "./python.js";

// ---------------------------------------------------------------------------
// Default skills — the sports-skills that ship with sportsclaw
// See https://sports-skills.sh
// ---------------------------------------------------------------------------

export const DEFAULT_SKILLS = [
  "football",
  "nfl",
  "nba",
  "nhl",
  "mlb",
  "wnba",
  "tennis",
  "cfb",
  "cbb",
  "golf",
  "f1",
  "kalshi",
  "polymarket",
  "news",
  "betting",
  "markets",
] as const;

// ---------------------------------------------------------------------------
// Human-readable skill descriptions (used in config flow + system prompt)
// ---------------------------------------------------------------------------

export const SKILL_DESCRIPTIONS: Record<string, string> = {
  football: "Football (soccer) — Transfermarkt & FBref data across 13 leagues",
  nfl: "NFL — scores, standings, rosters, play-by-play via ESPN",
  nba: "NBA — scores, standings, rosters, play-by-play via ESPN",
  nhl: "NHL — scores, standings, rosters, play-by-play via ESPN",
  mlb: "MLB — scores, standings, rosters, play-by-play via ESPN",
  wnba: "WNBA — scores, standings, rosters, play-by-play via ESPN",
  tennis: "Tennis — ATP & WTA scores, rankings, player profiles via ESPN",
  cfb: "College Football — NCAA Division I FBS via ESPN",
  cbb: "College Basketball — NCAA Division I via ESPN",
  golf: "Golf — PGA Tour, LPGA, DP World Tour via ESPN",
  f1: "Formula 1 — race results, lap timing, strategy via FastF1",
  kalshi: "Kalshi — CFTC-regulated prediction markets & event contracts",
  polymarket: "Polymarket — decentralized prediction markets & odds",
  news: "Sports News — headlines & articles via RSS feeds & Google News",
  betting: "Betting Analysis — odds conversion, de-vigging, edge detection, Kelly criterion",
  markets: "Markets — unified prediction market dashboard connecting ESPN with Kalshi & Polymarket",
};

// ---------------------------------------------------------------------------
// Skill filter — restrict active skills via SPORTSCLAW_SKILLS env var
// ---------------------------------------------------------------------------

/**
 * Parse the SPORTSCLAW_SKILLS env var (comma-separated) into a Set.
 * Returns null when unset → means "all skills active" (no filter).
 *
 * Example: SPORTSCLAW_SKILLS=football,nba,betting → Set(["football","nba","betting"])
 */
function getSkillFilter(): Set<string> | null {
  const raw =
    process.env.SPORTSCLAW_SKILLS || process.env.sportsclaw_SKILLS;
  if (!raw) return null;
  const skills = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return skills.length > 0 ? new Set(skills) : null;
}

// ---------------------------------------------------------------------------
// Installed vs available diffing
// ---------------------------------------------------------------------------

/**
 * Compare schemas on disk against DEFAULT_SKILLS to determine which
 * sports are installed and which are available but not yet installed.
 */
export function getInstalledVsAvailable(): {
  installed: string[];
  available: string[];
} {
  const installed = listSchemas();
  const installedSet = new Set(installed);
  const available = DEFAULT_SKILLS.filter((s) => !installedSet.has(s));
  return { installed, available };
}

// ---------------------------------------------------------------------------
// Schema directory management
// ---------------------------------------------------------------------------

/** Resolve the directory where sport schemas are stored */
export function getSchemaDir(): string {
  const dir =
    process.env.sportsclaw_SCHEMA_DIR ||
    join(homedir(), ".sportsclaw", "schemas");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

// ---------------------------------------------------------------------------
// Fetch schema from Python package
// ---------------------------------------------------------------------------

/**
 * Execute `python3 -m sports_skills <sport> schema` and parse the JSON output.
 *
 * Throws with a descriptive error if the package isn't installed, the sport
 * isn't supported, or the output isn't valid JSON.
 */
export function fetchSportSchema(
  sport: string,
  config?: Partial<sportsclawConfig>
): Promise<SportSchema> {
  const pythonPath = config?.pythonPath ?? "python3";
  const timeout = config?.timeout ?? 30_000;

  return new Promise((resolve, reject) => {
    execFile(
      pythonPath,
      ["-m", "sports_skills", sport, "schema"],
      {
        encoding: "utf-8",
        timeout,
        maxBuffer: 10 * 1024 * 1024,
        env: buildSubprocessEnv(config?.env),
      },
      (error, stdout, stderr) => {
        if (error) {
          const msg = [
            `Failed to fetch schema for "${sport}".`,
            "",
            error.message,
            "",
            "Possible causes:",
            "  1. The sports-skills Python package is not installed.",
            '     → pip install sports-skills',
            `  2. The sport "${sport}" is not supported by the installed version.`,
            "  3. Python 3 is not available at the configured path.",
            `     → Current path: ${pythonPath}`,
          ];
          if (stderr) {
            msg.push("", `stderr: ${stderr.trim()}`);
          }
          reject(new Error(msg.join("\n")));
          return;
        }

        const trimmed = (stdout ?? "").trim();
        if (!trimmed) {
          reject(
            new Error(
              `No schema output for sport "${sport}". ` +
                "The sport may not be supported by the installed sports-skills version."
            )
          );
          return;
        }

        try {
          const schema = JSON.parse(trimmed) as SportSchema;
          if (!schema.sport || !Array.isArray(schema.tools)) {
            reject(
              new Error(
                `Invalid schema format for "${sport}": ` +
                  'response must contain "sport" (string) and "tools" (array) fields.'
              )
            );
            return;
          }
          resolve(schema);
        } catch {
          reject(
            new Error(
              `Invalid JSON in schema output for "${sport}":\n${trimmed.slice(0, 300)}`
            )
          );
        }
      }
    );
  });
}

// ---------------------------------------------------------------------------
// Persist / load schemas
// ---------------------------------------------------------------------------

/** Save a sport schema to disk */
export function saveSchema(schema: SportSchema): void {
  const dir = getSchemaDir();
  const filePath = join(dir, `${schema.sport}.json`);
  writeFileSync(filePath, JSON.stringify(schema, null, 2), "utf-8");
}

/**
 * Load all saved schemas from the schema directory.
 *
 * When the SPORTSCLAW_SKILLS env var is set (comma-separated list),
 * only schemas matching the filter are returned. This enables per-user
 * skill selection in multi-tenant relay deployments.
 */
export function loadAllSchemas(): SportSchema[] {
  const dir = getSchemaDir();
  if (!existsSync(dir)) return [];

  const filter = getSkillFilter();
  const schemas: SportSchema[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    const sport = file.replace(".json", "");
    if (filter && !filter.has(sport)) continue;
    try {
      const content = readFileSync(join(dir, file), "utf-8");
      const schema = JSON.parse(content) as SportSchema;
      if (schema.sport && Array.isArray(schema.tools)) {
        schemas.push(schema);
      }
    } catch {
      // Skip malformed schema files silently
    }
  }
  return schemas;
}

/** Remove a sport schema from disk. Returns true if found and deleted. */
export function removeSchema(sport: string): boolean {
  const dir = getSchemaDir();
  const filePath = join(dir, `${sport}.json`);
  if (existsSync(filePath)) {
    unlinkSync(filePath);
    return true;
  }
  return false;
}

/**
 * List all sport names that have saved schemas.
 * Respects SPORTSCLAW_SKILLS filter when set.
 */
export function listSchemas(): string[] {
  const dir = getSchemaDir();
  if (!existsSync(dir)) return [];
  const filter = getSkillFilter();
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(".json", ""))
    .filter((sport) => !filter || filter.has(sport));
}

// ---------------------------------------------------------------------------
// Auto-install sports-skills Python package
// ---------------------------------------------------------------------------

/**
 * Check if the `sports-skills` Python package is installed. If not,
 * install or repair it automatically via pip.
 *
 * Returns true only when both base package and F1 module are importable.
 */
export async function ensureSportsSkills(
  config?: Partial<sportsclawConfig>
): Promise<boolean> {
  const pythonPath = config?.pythonPath ?? "python3";

  // Preflight: ensure Python >= 3.10 before attempting any imports
  const pyCheck = checkPythonVersion(pythonPath);
  if (!pyCheck.ok) {
    if (pyCheck.version) {
      console.error(
        `[sportsclaw] Python ${pyCheck.version} is too old. ` +
        `sports-skills requires Python ${MIN_PYTHON_VERSION.major}.${MIN_PYTHON_VERSION.minor}+.`
      );
    } else {
      console.error(
        `[sportsclaw] Python not found at "${pythonPath}". ` +
        `Install Python ${MIN_PYTHON_VERSION.major}.${MIN_PYTHON_VERSION.minor}+ or run: sportsclaw config`
      );
    }
    console.error(
      `[sportsclaw] Upgrade Python and re-run, or set PYTHON_PATH to a valid interpreter.`
    );
    return false;
  }

  const canImportBase = (): boolean => {
    try {
      execFileSync(pythonPath, ["-c", "import sports_skills"], {
        timeout: 10_000,
        stdio: "pipe",
      });
      return true;
    } catch {
      return false;
    }
  };

  const canImportF1 = (): boolean => {
    try {
      execFileSync(
        pythonPath,
        ["-c", "from sports_skills import f1\nimport sys\nsys.exit(0 if f1 is not None else 1)"],
        {
          timeout: 10_000,
          stdio: "pipe",
        }
      );
      return true;
    } catch {
      return false;
    }
  };

  let baseReady = canImportBase();
  let f1Ready = baseReady && canImportF1();

  if (baseReady && f1Ready) {
    return true;
  }

  console.error(`[sportsclaw] Preflight Python interpreter: ${pythonPath}`);

  if (baseReady && !f1Ready) {
    console.error(
      "[sportsclaw] sports-skills is installed but F1 support is unavailable. Attempting repair..."
    );
  } else {
    console.error("[sportsclaw] sports-skills not found. Installing...");
  }

  const installAttempts: Array<{ bin: string; args: string[] }> = [
    {
      bin: pythonPath,
      args: ["-m", "pip", "install", "--upgrade", "sports-skills"],
    },
    {
      bin: pythonPath,
      args: [
        "-m",
        "pip",
        "install",
        "--upgrade",
        "sports-skills",
        "--break-system-packages",
      ],
    },
    {
      bin: pythonPath,
      args: ["-m", "pip", "install", "--upgrade", "sports-skills", "--user"],
    },
  ];

  // Fallbacks only if python -m pip is unavailable.
  for (const pip of ["pip3", "pip"]) {
    try {
      execFileSync(pip, ["--version"], { timeout: 5_000, stdio: "pipe" });
      installAttempts.push(
        { bin: pip, args: ["install", "--upgrade", "sports-skills"] },
        {
          bin: pip,
          args: [
            "install",
            "--upgrade",
            "sports-skills",
            "--break-system-packages",
          ],
        },
        {
          bin: pip,
          args: ["install", "--upgrade", "sports-skills", "--user"],
        }
      );
      break;
    } catch {
      // try next
    }
  }

  let lastInstallError: unknown;
  try {
    for (const attempt of installAttempts) {
      try {
        execFileSync(attempt.bin, attempt.args, {
          timeout: 120_000,
          stdio: "inherit",
        });
        lastInstallError = undefined;
        break;
      } catch (err) {
        lastInstallError = err;
      }
    }
  } catch (err) {
    lastInstallError = err;
  }

  baseReady = canImportBase();
  f1Ready = baseReady && canImportF1();
  if (baseReady && f1Ready) {
    console.error("[sportsclaw] sports-skills installed successfully.");
    return true;
  }

  console.error(
    `[sportsclaw] Failed to ensure sports-skills with F1 support: ${
      lastInstallError instanceof Error ? lastInstallError.message : lastInstallError
    }`
  );
  console.error(
    `[sportsclaw] Repair command: ${buildSportsSkillsRepairCommand(pythonPath)}`
  );
  console.error(
    `[sportsclaw] If global install is blocked: ${buildSportsSkillsRepairCommand(
      pythonPath,
      true
    )}`
  );
  return false;
}

// ---------------------------------------------------------------------------
// Installed version detection
// ---------------------------------------------------------------------------

/**
 * Get the installed sports-skills package version by running Python.
 * Returns the version string (e.g., "0.9.6") or null if unavailable.
 */
export function getInstalledSportsSkillsVersion(
  config?: Partial<sportsclawConfig>
): string | null {
  const pythonPath = config?.pythonPath ?? "python3";
  try {
    const output = execFileSync(
      pythonPath,
      ["-c", "from sports_skills import __version__; print(__version__)"],
      { timeout: 10_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
    );
    return output.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Get the version stored in cached schemas.
 * Reads the first cached schema that has a version field.
 */
export function getCachedSchemaVersion(): string | null {
  const schemas = loadAllSchemas();
  for (const schema of schemas) {
    if (schema.version) return schema.version;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Dynamic discovery — ask sports-skills for its module catalog
// ---------------------------------------------------------------------------

interface SkillCatalog {
  version: string;
  modules: string[];
}

/**
 * Run `python3 -m sports_skills catalog` and return the list of available
 * modules. Returns `null` when the command fails (e.g. older sports-skills
 * versions that don't support `catalog`).
 */
export function discoverAvailableSkills(
  config?: Partial<sportsclawConfig>
): SkillCatalog | null {
  const pythonPath = config?.pythonPath ?? "python3";
  try {
    const output = execFileSync(
      pythonPath,
      ["-m", "sports_skills", "catalog"],
      { timeout: 15_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
    );
    const parsed = JSON.parse(output.trim()) as SkillCatalog;
    if (Array.isArray(parsed.modules) && parsed.modules.length > 0) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Bootstrap default schemas
// ---------------------------------------------------------------------------

/**
 * Fetch and save schemas for all default sports-skills.
 *
 * Attempts dynamic discovery via `catalog` first. Falls back to the
 * hardcoded `DEFAULT_SKILLS` list when discovery is unavailable (e.g.
 * older sports-skills versions).
 *
 * By default, skips skills that already have a schema on disk.
 * Pass `force: true` to re-fetch everything (useful for upgrades).
 *
 * Returns the number of schemas successfully installed (including
 * previously existing ones that were skipped).
 */
export async function bootstrapDefaultSchemas(
  config?: Partial<sportsclawConfig>,
  options?: { verbose?: boolean; force?: boolean }
): Promise<number> {
  const verbose = options?.verbose ?? false;
  const force = options?.force ?? false;
  const existing = new Set(listSchemas());
  let succeeded = 0;

  // Try dynamic discovery; fall back to hardcoded list
  const catalog = discoverAvailableSkills(config);
  const skills: readonly string[] = catalog?.modules ?? DEFAULT_SKILLS;

  if (verbose && catalog) {
    console.error(
      `[sportsclaw] discovered ${catalog.modules.length} skills from sports-skills v${catalog.version}`
    );
  }

  for (const skill of skills) {
    if (!force && existing.has(skill)) {
      if (verbose) {
        console.error(`[sportsclaw] skip: "${skill}" already installed`);
      }
      succeeded++;
      continue;
    }

    try {
      if (verbose) {
        console.error(`[sportsclaw] fetching: ${skill}...`);
      }
      const schema = await fetchSportSchema(skill, config);
      saveSchema(schema);
      succeeded++;
      if (verbose) {
        console.error(
          `[sportsclaw] installed: ${skill} (${schema.tools.length} tools)`
        );
      }
    } catch {
      console.error(
        `[sportsclaw] warning: could not fetch schema for "${skill}"`
      );
    }
  }

  return succeeded;
}
