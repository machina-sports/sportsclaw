/**
 * SportsClaw Engine — Schema Injection (Phase 3)
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

import { execFile } from "node:child_process";
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
import type { SportSchema, SportsClawConfig } from "./types.js";
import { buildSubprocessEnv } from "./tools.js";

// ---------------------------------------------------------------------------
// Schema directory management
// ---------------------------------------------------------------------------

/** Resolve the directory where sport schemas are stored */
export function getSchemaDir(): string {
  const dir =
    process.env.SPORTSCLAW_SCHEMA_DIR ||
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
  config?: Partial<SportsClawConfig>
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
