import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("../src/engine.ts", import.meta.url), "utf8");

test("partial tool failures stay internal, not user-facing", () => {
  assert(!source.includes("⚠️ Partial data: some live tools failed"));
  assert(!source.includes("Treat related sections as unavailable."));
  assert(source.includes("Do not mention technical failures, tool names, integrations, upstream systems, partial data, or why data was missing."));
  assert(source.includes("skip missing sections silently"));
});

test("evidence fallback does not leak tool names", () => {
  assert(!source.includes("some required tools failed: ${failed}"));
  assert(!source.includes("Retry to get a complete answer."));
  assert(source.includes("I can’t verify that cleanly right now"));
});
