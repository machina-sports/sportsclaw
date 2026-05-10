/**
 * CI integration — end-to-end Gemini smoke. Requires GEMINI_API_KEY (or
 * GOOGLE_GENERATIVE_AI_API_KEY) in env. Stages a stub user, runs engine.run()
 * with a tiny prompt, asserts non-empty response AND that the memory_loaded
 * log fired (proves the observability change still works against a real
 * provider).
 *
 * Exits 0 on success, 1 on failure.
 */

import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { sportsclawEngine } from "../dist/index.js";

const apiKey =
  process.env.GOOGLE_GENERATIVE_AI_API_KEY || process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error(
    "CI integration FAILED: GOOGLE_GENERATIVE_AI_API_KEY (or GEMINI_API_KEY) is not set."
  );
  console.error(
    "Set the secret in repo settings → Secrets and variables → Actions."
  );
  process.exit(1);
}

// Engine reads GOOGLE_GENERATIVE_AI_API_KEY at src/engine.ts:3817 / :3896.
// If only GEMINI_API_KEY was provided, propagate it so the engine resolves.
process.env.GOOGLE_GENERATIVE_AI_API_KEY = apiKey;

const USER_ID = "ci-int-user";
const memDir = join(homedir(), ".sportsclaw", "memory", USER_ID);

mkdirSync(memDir, { recursive: true });
writeFileSync(
  join(memDir, "SOUL.md"),
  "# SOUL\nBorn: 2026-05-10\nExchanges: 1\n\nCI integration test user.\n"
);

const captured = [];
const origError = console.error;
console.error = (...args) => {
  captured.push(args.map(String).join(" "));
};

let response;
let runError;
try {
  const engine = new sportsclawEngine({
    provider: "google",
    model: "gemini-3-flash-preview",
    // verbose:true so the memory_loaded log fires regardless of PR #40's
    // merge status (pre-#40 the log is gated behind verbose). Once #40
    // lands a follow-up can pin verbose:false specifically.
    verbose: true,
  });
  response = await engine.run("Reply with the single word: pong", {
    userId: USER_ID,
  });
} catch (e) {
  runError = e;
} finally {
  console.error = origError;
  rmSync(memDir, { recursive: true, force: true });
}

if (runError) {
  console.error("CI integration FAILED: engine.run threw:");
  console.error(runError instanceof Error ? runError.stack : String(runError));
  console.error("Captured stderr lines:");
  for (const line of captured) console.error(`  ${line}`);
  process.exit(1);
}

if (!response || typeof response !== "string" || response.trim().length === 0) {
  console.error("CI integration FAILED: engine.run returned empty / non-string.");
  console.error(`response: ${JSON.stringify(response)}`);
  process.exit(1);
}

// Same both-formats acceptance as ci-smoke (lands independently of PR #40).
const memoryLogged = captured.some(
  (line) =>
    line.includes(`memory_loaded user=${USER_ID}`) ||
    line.includes(`memory loaded for user ${USER_ID}`)
);
if (!memoryLogged) {
  console.error(
    "CI integration FAILED: memory_loaded log not seen on stderr."
  );
  console.error("Captured stderr lines:");
  for (const line of captured) console.error(`  ${line}`);
  process.exit(1);
}

console.log("CI integration PASSED.");
console.log(`  response (first 80 chars): ${response.slice(0, 80)}`);
console.log(`  memory_loaded log: confirmed`);
process.exit(0);
