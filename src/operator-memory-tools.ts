/**
 * Editorial Memory tools — let the LLM extend its own cross-tick memory.
 *
 * The operator daemon loads EditorialMemory as a FROZEN snapshot at the
 * top of each tick (prompt-prefix cache stability). Writes during the
 * tick update the on-disk file but NOT the in-prompt snapshot — the new
 * lessons appear in the NEXT tick's system prompt. This is by design.
 *
 * Three tools:
 *   add_lesson(body)              append a new lesson
 *   replace_lesson(needle, body)  replace the first lesson containing `needle`
 *   remove_lesson(needle)         remove the first lesson containing `needle`
 *
 * All three return short outcome strings to the LLM so it can chain
 * follow-up calls deterministically (e.g. add → if cap exceeded → replace).
 * Threat-pattern + char-cap rejections surface as clean strings, not
 * thrown errors.
 */

import { tool as defineToolRaw, jsonSchema } from "ai";
import type { ToolSet } from "ai";

import type { EditorialMemory } from "./editorial-memory.js";

// AI SDK's `tool` factory fights our Record<string, unknown> execute
// signatures; the cast is the same workaround engine.ts + sinks use.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const defineTool = defineToolRaw as any;

/**
 * Build the three memory-writeback tools bound to a specific
 * EditorialMemory instance. Returns a fresh ToolSet ready to merge with
 * the daemon's other tools.
 */
export function buildMemoryTools(memory: EditorialMemory): ToolSet {
  const tools: ToolSet = {};

  tools["add_lesson"] = defineTool({
    description:
      "Append a new editorial lesson to your cross-tick memory. Use when " +
      "you've learned something worth carrying forward: a rule of thumb, " +
      "a confirmed pattern, an operator preference. The lesson is persisted " +
      "to disk immediately but appears in the SYSTEM PROMPT on the NEXT " +
      "tick (this tick's prompt is frozen). Bodies are checked against " +
      "prompt-injection patterns — \"ignore previous instructions\" and " +
      "similar phrasings will be rejected. Total memory is capped at 4096 " +
      "chars; if exceeded, replace or remove an existing lesson first.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        body: {
          type: "string",
          description:
            "The lesson body (markdown ok). One coherent thought per call. " +
            "Be concrete: \"Brazil-related leads outperform admin/ticket " +
            "stories — pivot to player narrative when the headline is " +
            "logistics\" beats \"prefer Brazil stories.\"",
        },
      },
      required: ["body"],
    }),
    execute: async (args: Record<string, unknown>) => {
      const body = typeof args.body === "string" ? args.body : "";
      if (!body.trim()) return "Cannot add: body is empty.";
      try {
        await memory.add(body);
        return `Added lesson (${body.length} chars). Will appear in next tick's prompt.`;
      } catch (err) {
        return `Cannot add: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });

  tools["replace_lesson"] = defineTool({
    description:
      "Replace the first existing lesson whose text contains `needle` " +
      "with a new body. Use when a prior lesson needs to evolve — too " +
      "narrow, an exception emerged, the pattern flipped. If no lesson " +
      "matches, returns \"no match\" without writing. Same prompt-injection " +
      "+ char-cap guards as add_lesson.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        needle: {
          type: "string",
          description:
            "Substring identifying the lesson to replace. Match is " +
            "case-sensitive and matches the FIRST lesson containing the " +
            "substring (in insertion order). Use a unique phrase from the " +
            "original lesson.",
        },
        body: {
          type: "string",
          description: "Replacement lesson body. Same shape as add_lesson.",
        },
      },
      required: ["needle", "body"],
    }),
    execute: async (args: Record<string, unknown>) => {
      const needle = typeof args.needle === "string" ? args.needle : "";
      const body = typeof args.body === "string" ? args.body : "";
      if (!needle) return "Cannot replace: needle is empty.";
      if (!body.trim()) return "Cannot replace: body is empty.";
      try {
        const replaced = await memory.replace(needle, body);
        return replaced
          ? `Replaced lesson matching "${needle.slice(0, 40)}". Will appear in next tick's prompt.`
          : `No match for "${needle.slice(0, 40)}" — nothing replaced.`;
      } catch (err) {
        return `Cannot replace: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });

  tools["remove_lesson"] = defineTool({
    description:
      "Remove the first existing lesson whose text contains `needle`. Use " +
      "to retract a lesson that turned out to be wrong or no longer applies. " +
      "If no lesson matches, returns \"no match\" without writing.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        needle: {
          type: "string",
          description:
            "Substring identifying the lesson to remove. Same match rules as replace_lesson.",
        },
      },
      required: ["needle"],
    }),
    execute: async (args: Record<string, unknown>) => {
      const needle = typeof args.needle === "string" ? args.needle : "";
      if (!needle) return "Cannot remove: needle is empty.";
      try {
        const removed = await memory.remove(needle);
        return removed
          ? `Removed lesson matching "${needle.slice(0, 40)}". Will disappear from next tick's prompt.`
          : `No match for "${needle.slice(0, 40)}" — nothing removed.`;
      } catch (err) {
        return `Cannot remove: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });

  return tools;
}

/** Names of the tools this module registers. Useful for diagnostics + tests. */
export const MEMORY_TOOL_NAMES = [
  "add_lesson",
  "replace_lesson",
  "remove_lesson",
] as const;
