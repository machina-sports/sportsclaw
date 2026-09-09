import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("../src/engine.ts", import.meta.url), "utf8");

test("partial tool failures hide plumbing but preserve editorial coverage gaps", () => {
  assert(!source.includes("⚠️ Partial data: some live tools failed"));
  assert(!source.includes("Treat related sections as unavailable."));
  assert(!source.includes("skip missing sections silently"));
  assert(source.includes("Keep material uncertainty explicit beside affected claims"));
  assert(source.includes("do not append an empty unavailable section to a useful brief"));
});

test("evidence fallback does not leak tool names", () => {
  assert(!source.includes("some required tools failed: ${failed}"));
  assert(!source.includes("Retry to get a complete answer."));
  assert(source.includes("I can’t verify that cleanly right now"));
});
