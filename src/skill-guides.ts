/**
 * sportsclaw Engine — Skill Guides Loader
 *
 * Recursively scans SPORTSCLAW_SKILL_GUIDES_DIR for skill directories and
 * loads them as behavioral guides for the LLM:
 *   - legacy: `skill.yml` + `SKILL.md` (skill.yml metadata, full SKILL.md body)
 *   - portable: `SKILL.md` with YAML frontmatter `name` + `description`
 *
 * Skill guides are injected into the system prompt so the LLM can follow
 * step-by-step workflows when the user's request matches a guide's triggers.
 *
 * The scan never follows symlinks, is depth- and size-bounded, and drops
 * guides whose directory id is ambiguous. Metadata never grants permissions.
 *
 * Backward-compatible: if the env var is unset or the dir doesn't exist,
 * returns an empty array.
 */

import { readFileSync, readdirSync, existsSync, lstatSync, realpathSync, type Dirent } from "node:fs";
import { join, basename } from "node:path";
import { parseDocument } from "yaml";
import type { SkillGuide } from "./types.js";

const MAX_SCAN_DEPTH = 8;
const MAX_GUIDE_FILE_BYTES = 256 * 1024;

// ---------------------------------------------------------------------------
// YAML
// ---------------------------------------------------------------------------

/**
 * Line-based fallback for legacy skill.yml files that were never strict YAML
 * (e.g. `description: Use when: x`). Top-level scalar keys only.
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

/** Strict YAML mapping, or null when the YAML is invalid or not a mapping. */
function parseYamlMapping(content: string): Record<string, unknown> | null {
  try {
    const doc = parseDocument(content);
    if (doc.errors.length > 0) return null;
    const value: unknown = doc.toJS();
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    // Alias resolution/expansion can fail during toJS, after successful parsing.
    return null;
  }
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/** Read a regular (non-symlink) file under the size bound, else null. */
function readGuideFile(path: string): string | null {
  try {
    const st = lstatSync(path);
    if (!st.isFile() || st.size > MAX_GUIDE_FILE_BYTES) return null;
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

function loadGuide(dir: string, files: Set<string>): SkillGuide | null {
  if (!files.has("SKILL.md")) return null;
  const md = readGuideFile(join(dir, "SKILL.md"));
  if (md === null) return null;
  const id = basename(dir);

  if (files.has("skill.yml")) {
    const yml = readGuideFile(join(dir, "skill.yml"));
    if (yml === null) return null;
    const meta = parseYamlMapping(yml) ?? parseSimpleYaml(yml);
    return {
      id,
      name: nonEmptyString(meta.name) ?? id,
      description: nonEmptyString(meta.description) ?? "",
      body: md.trim(),
      dir,
    };
  }

  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(md);
  if (!match) return null;
  const meta = parseYamlMapping(match[1]);
  const name = nonEmptyString(meta?.name);
  const description = nonEmptyString(meta?.description);
  if (!name || !description) return null;
  return { id, name, description, body: match[2].trim(), dir };
}

/**
 * Scan a directory tree for skill guides. Symlinked entries are never
 * followed (Dirent types come from lstat), so the scan cannot leave the root
 * or loop.
 */
function scanDir(dir: string, depth: number, guides: SkillGuide[]): void {
  if (depth > MAX_SCAN_DEPTH) return;
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  const files = new Set(entries.filter((e) => e.isFile()).map((e) => e.name));
  const guide = loadGuide(dir, files);
  if (guide) guides.push(guide);

  for (const entry of entries) {
    if (entry.isDirectory()) scanDir(join(dir, entry.name), depth + 1, guides);
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

  const found: SkillGuide[] = [];
  scanDir(realpathSync(dir), 0, found);

  // The directory id is the invocation identifier: an ambiguous id loads nothing.
  const counts = new Map<string, number>();
  for (const g of found) counts.set(g.id, (counts.get(g.id) ?? 0) + 1);
  const guides = found
    .filter((g) => counts.get(g.id) === 1)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  if (verbose) {
    const dupes = [...counts].filter(([, n]) => n > 1).map(([id]) => id);
    if (dupes.length > 0) {
      console.error(`[sportsclaw] skill-guides: skipping duplicate id(s): ${dupes.join(", ")}`);
    }
    if (guides.length > 0) {
      console.error(
        `[sportsclaw] skill-guides: loaded ${guides.length} guide(s): ${guides.map((g) => g.id).join(", ")}`
      );
    }
  }

  return guides;
}
