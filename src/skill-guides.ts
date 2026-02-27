/**
 * sportsclaw Engine — Skill Guides Loader
 *
 * Recursively scans SPORTSCLAW_SKILL_GUIDES_DIR for subdirectories containing
 * `skill.yml` + `SKILL.md` pairs and loads them as behavioral guides for the LLM.
 *
 * Skill guides are injected into the system prompt so the LLM can follow
 * step-by-step workflows when the user's request matches a guide's triggers.
 *
 * Backward-compatible: if the env var is unset or the dir doesn't exist,
 * returns an empty array.
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import type { SkillGuide } from "./types.js";

// ---------------------------------------------------------------------------
// Minimal YAML parser for skill.yml (avoids adding a YAML dependency)
// ---------------------------------------------------------------------------

/**
 * Parse a simple YAML file with top-level scalar keys (name, description, category).
 * Does NOT handle nested objects, arrays, or multiline strings — but skill.yml
 * files are flat by convention.
 */
function parseSimpleYaml(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx < 1) continue;
    const key = trimmed.slice(0, colonIdx).trim();
    let value = trimmed.slice(colonIdx + 1).trim();
    // Strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * Recursively scan a directory for skill guide pairs (skill.yml + SKILL.md).
 * Returns an array of SkillGuide objects.
 */
function scanDir(dir: string, guides: SkillGuide[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }

  const hasSkillYml = entries.includes("skill.yml");
  const hasSkillMd = entries.includes("SKILL.md");

  if (hasSkillYml && hasSkillMd) {
    try {
      const ymlContent = readFileSync(join(dir, "skill.yml"), "utf-8");
      const mdContent = readFileSync(join(dir, "SKILL.md"), "utf-8");
      const meta = parseSimpleYaml(ymlContent);

      const id = basename(dir);
      guides.push({
        id,
        name: meta.name || id,
        description: meta.description || "",
        body: mdContent.trim(),
      });
    } catch {
      // Skip malformed guides
    }
  }

  // Recurse into subdirectories
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    try {
      if (statSync(fullPath).isDirectory()) {
        scanDir(fullPath, guides);
      }
    } catch {
      // Skip inaccessible entries
    }
  }
}

/**
 * Load skill guides from the configured directory.
 *
 * Reads SPORTSCLAW_SKILL_GUIDES_DIR env var. If unset or dir doesn't exist,
 * returns an empty array (backward-compatible).
 */
export function loadSkillGuides(verbose = false): SkillGuide[] {
  const dir = process.env.SPORTSCLAW_SKILL_GUIDES_DIR;
  if (!dir) return [];

  if (!existsSync(dir)) {
    if (verbose) {
      console.error(`[sportsclaw] skill-guides: dir "${dir}" does not exist, skipping`);
    }
    return [];
  }

  const guides: SkillGuide[] = [];
  scanDir(dir, guides);

  if (verbose && guides.length > 0) {
    console.error(
      `[sportsclaw] skill-guides: loaded ${guides.length} guide(s): ${guides.map((g) => g.id).join(", ")}`
    );
  }

  return guides;
}
