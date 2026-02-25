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

// ---------------------------------------------------------------------------
// Default skills — the 14 sports-skills that ship with sportsclaw
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
] as const;

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

/** Load all saved schemas from the schema directory */
export function loadAllSchemas(): SportSchema[] {
  const dir = getSchemaDir();
  if (!existsSync(dir)) return [];

  const schemas: SportSchema[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
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

/** List all sport names that have saved schemas */
export function listSchemas(): string[] {
  const dir = getSchemaDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(".json", ""));
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

  if (baseReady && !f1Ready) {
    console.error(
      "[sportsclaw] sports-skills is installed but F1 support is unavailable. Attempting repair..."
    );
  } else {
    console.error("[sportsclaw] sports-skills not found. Installing...");
  }

  // Determine pip command: prefer pip3 alongside the configured python
  const pipCandidates = ["pip3", "pip"];
  let pipPath: string | undefined;
  for (const pip of pipCandidates) {
    try {
      execFileSync(pip, ["--version"], { timeout: 5_000, stdio: "pipe" });
      pipPath = pip;
      break;
    } catch {
      // try next
    }
  }

  if (!pipPath) {
    // Last resort: python -m pip
    pipPath = pythonPath;
  }

  const installAttempts =
    pipPath === pythonPath
      ? [
          ["-m", "pip", "install", "--upgrade", "sports-skills"],
          ["-m", "pip", "install", "--upgrade", "sports-skills", "--break-system-packages"],
          ["-m", "pip", "install", "--upgrade", "sports-skills", "--user"],
        ]
      : [
          ["install", "--upgrade", "sports-skills"],
          ["install", "--upgrade", "sports-skills", "--break-system-packages"],
          ["install", "--upgrade", "sports-skills", "--user"],
        ];

  let lastInstallError: unknown;
  try {
    for (const installArgs of installAttempts) {
      try {
        execFileSync(pipPath, installArgs, {
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
    "[sportsclaw] Repair command: python3 -m pip install --upgrade sports-skills"
  );
  console.error(
    "[sportsclaw] If global install is blocked: python3 -m pip install --upgrade --user sports-skills"
  );
  return false;
}

// ---------------------------------------------------------------------------
// Bootstrap default schemas
// ---------------------------------------------------------------------------

/**
 * Fetch and save schemas for all 14 default sports-skills.
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

  for (const skill of DEFAULT_SKILLS) {
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
