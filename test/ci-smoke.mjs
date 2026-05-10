/**
 * CI smoke — proves the engine boots, memory loads, and the
 * `[sportsclaw] memory_loaded user=…` log fires on stderr WITHOUT any API
 * key configured. Intentionally expects engine.run() to throw on missing
 * key — the log fires before that throw.
 *
 * Exits 0 on success, 1 on failure with captured stderr context.
 */

import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { sportsclawEngine } from "../dist/index.js";

const USER_ID = "ci-smoke-user";
const memDir = join(homedir(), ".sportsclaw", "memory", USER_ID);

// Stage stub memory so buildMemoryBlock returns non-empty and the log fires.
mkdirSync(memDir, { recursive: true });
writeFileSync(
  join(memDir, "SOUL.md"),
  "# SOUL\nBorn: 2026-05-10\nExchanges: 1\n\nCI smoke test user.\n"
);

const captured = [];
const origError = console.error;
console.error = (...args) => {
  captured.push(args.map(String).join(" "));
};

try {
  // verbose:true so the memory_loaded log fires on every branch state (pre- or
  // post-PR-#40). PR #40 drops the verbose gate; until it lands, verbose:true
  // is the only way the log emits. Once #40 merges, this smoke continues to
  // pass — and a follow-up can pin verbose:false to assert the new behavior
  // specifically.
  const engine = new sportsclawEngine({ verbose: true });
  try {
    await engine.run("hi", { userId: USER_ID });
  } catch {
    // Expected — engine.run() throws on missing API key after the memory log fires.
  }
} finally {
  console.error = origError;
  rmSync(memDir, { recursive: true, force: true });
}

// Accept both the new key=value format (post-PR-#40) and the old free-text
// format (pre-merge), so this CI lands independently of PR #40's status.
const found = captured.find(
  (line) =>
    line.includes(`memory_loaded user=${USER_ID}`) ||
    line.includes(`memory loaded for user ${USER_ID}`)
);
if (!found) {
  console.error("CI smoke FAILED: memory_loaded log not seen on stderr.");
  console.error("Captured stderr lines:");
  for (const line of captured) console.error(`  ${line}`);
  process.exit(1);
}

console.log(`CI smoke PASSED: ${found}`);
process.exit(0);
