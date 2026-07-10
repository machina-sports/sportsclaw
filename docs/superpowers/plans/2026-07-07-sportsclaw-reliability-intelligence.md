# sportsclaw Reliability + Intelligence Upgrade — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add generic, non-proprietary reliability plumbing to the sportsclaw engine (failure classification + clean user messages, a `selftest` command, persistent entity cache, complexity-aware routing, and a consolidated safe-execute wrapper with redacted logs), plus one gated server-side fix for the World Cup market-state workflow.

**Architecture:** Extend existing modules rather than fork them. Failure classification composes `bridge.ts::classifyBridgeError` and `mcp.ts::classifyError`. Entity persistence sits behind the existing in-memory `EntityResolver`. Complexity routing layers onto `router.ts`. The safe-execute wrapper consolidates the sanitize→cache→bridge→circuit-breaker chain already present in `ToolRegistry`. Proprietary market-ID normalization stays out of the MIT client and lives server-side in the hosted `worldcup-get-market-state` MCP workflow.

**Tech Stack:** Node.js / TypeScript / ESM, `discord.js`, Vercel AI SDK, `node:test` + `node:assert/strict` for tests (run against compiled `dist/`), Python `sports-skills` backend via subprocess bridge.

## Global Constraints

- Language: TypeScript / ESM only. Local imports MUST use explicit `.js` extensions. No new Python. No SQLite dependency.
- Files: kebab-case. Variables/functions: camelCase. Types/classes: PascalCase.
- License is MIT and `dist/` ships publicly to npm — NO proprietary kalshi/polymarket normalization logic in `src/`.
- Tests: `node:test` (`describe`/`it`) + `node:assert/strict`, importing from `../dist/<module>.js`. Each test gets a `test:<name>` script in `package.json` of the exact form `npm run build && node --test test/<name>.test.mjs`.
- Follow house style: prefer `export type X = "a" | "b"` string unions over TS `enum` (see `BridgeErrorCode` in `src/bridge.ts:29`).
- Build success = `npm run build` (tsc, no emit errors).
- Commit after each task; do not push.

## Existing types (verbatim, do not redefine)

```typescript
// src/bridge.ts
export interface ToolCallInput { [key: string]: any; }
export interface ToolCallResult { content: string; isError?: boolean; }
export type BridgeErrorCode =
  | "timeout" | "dependency_missing" | "network_dns" | "rate_limited"
  | "python_version_incompatible" | "circuit_open" | "tool_execution_failed";
export function classifyBridgeError(error?: string, stderr?: string):
  { errorCode: BridgeErrorCode; hint: string };
```

## File Structure

- Create `src/failures/types.ts` — `FailureCategory`, `ClassifiedFailure` (Phase 1b).
- Create `src/failures/classifier.ts` — `classifyFailure()`, `renderUserMessage()` (Phase 1b/§8).
- Create `src/selftest/cases.ts` — `SmokeTestCase`, `SMOKE_TESTS` (Phase 2).
- Create `src/selftest/runner.ts` — `runSelftest()`, `SelfTestReport` (Phase 2).
- Create `src/selftest/report.ts` — markdown/JSON rendering (Phase 2).
- Modify `src/index.ts` — add `cmdSelftest` + arg dispatch (Phase 2).
- Create `src/cache/entity-store.ts` — JSON persistence + TTL (Phase 3).
- Modify `src/intelligence/entity-resolver.ts` — load/save hooks (Phase 3).
- Create `src/routing/complexity.ts` — `classifyQueryComplexity()`, `planSkillCaps()` (Phase 4).
- Modify `src/router.ts` — consume complexity plan (Phase 4).
- Create `src/tools/executor.ts` — `executeToolSafely()` (Phase 5).
- Modify `src/analytics.ts` — `logToolExecution()` with redaction (Phase 5).

---

### Task 1: Failure classification types + classifier (Phase 1b)

**Files:**
- Create: `src/failures/types.ts`
- Create: `src/failures/classifier.ts`
- Test: `test/failure-classifier.test.mjs`

**Interfaces:**
- Consumes: `classifyBridgeError` from `src/bridge.ts`.
- Produces:
  - `type FailureCategory = "user_input" | "data_not_ready" | "provider_error" | "rate_limited" | "permission_config" | "auth_error" | "tool_contract" | "agent_planning" | "unknown"`
  - `interface ClassifiedFailure { category: FailureCategory; severity: "low" | "medium" | "high"; retryable: boolean; userMessage: string; developerMessage: string; suggestedFix?: string; rawError?: string; }`
  - `function classifyFailure(error: string | { message?: string } | undefined, toolName?: string): ClassifiedFailure`

- [ ] **Step 1: Write the failing test**

```javascript
// test/failure-classifier.test.mjs
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { classifyFailure } from "../dist/failures/classifier.js";

describe("classifyFailure", () => {
  it("classifies a rate-limit error as retryable rate_limited", () => {
    const f = classifyFailure("HTTP 429 Too Many Requests");
    assert.equal(f.category, "rate_limited");
    assert.equal(f.retryable, true);
  });

  it("classifies a storage permission error as non-retryable permission_config", () => {
    const f = classifyFailure("403 storage.objects.create denied");
    assert.equal(f.category, "permission_config");
    assert.equal(f.retryable, false);
  });

  it("classifies a not-ready fixture error as retryable data_not_ready", () => {
    const f = classifyFailure("Not enough knockout matches to build a bracket (0).");
    assert.equal(f.category, "data_not_ready");
    assert.equal(f.retryable, true);
  });

  it("classifies a 401 as non-retryable auth_error", () => {
    const f = classifyFailure("401 Unauthorized");
    assert.equal(f.category, "auth_error");
    assert.equal(f.retryable, false);
  });

  it("always produces a non-empty userMessage and developerMessage", () => {
    const f = classifyFailure("some totally unknown failure");
    assert.equal(f.category, "unknown");
    assert.ok(f.userMessage.length > 0);
    assert.ok(f.developerMessage.length > 0);
  });

  it("accepts an object with a message field", () => {
    const f = classifyFailure({ message: "circuit breaker open" });
    assert.equal(f.category, "provider_error");
    assert.equal(f.retryable, true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/failure-classifier.test.mjs`
Expected: FAIL — build error / `Cannot find module '../dist/failures/classifier.js'`.

- [ ] **Step 3: Write `src/failures/types.ts`**

```typescript
// src/failures/types.ts

/** Structured failure categories for tool/workflow errors. */
export type FailureCategory =
  | "user_input"
  | "data_not_ready"
  | "provider_error"
  | "rate_limited"
  | "permission_config"
  | "auth_error"
  | "tool_contract"
  | "agent_planning"
  | "unknown";

export interface ClassifiedFailure {
  category: FailureCategory;
  severity: "low" | "medium" | "high";
  retryable: boolean;
  /** Clean, human-facing explanation: what failed, why, whether retry helps, what to do next. */
  userMessage: string;
  /** Technical detail for logs/developers. */
  developerMessage: string;
  suggestedFix?: string;
  rawError?: string;
}
```

- [ ] **Step 4: Write `src/failures/classifier.ts`**

```typescript
// src/failures/classifier.ts
import { classifyBridgeError } from "../bridge.js";
import type { ClassifiedFailure, FailureCategory } from "./types.js";

interface Rule {
  category: FailureCategory;
  severity: "low" | "medium" | "high";
  retryable: boolean;
  match: (h: string) => boolean;
  userMessage: string;
  suggestedFix?: string;
}

// Generic, non-proprietary pattern rules. Order matters: first match wins.
const RULES: Rule[] = [
  {
    category: "rate_limited",
    severity: "low",
    retryable: true,
    match: (h) => h.includes("429") || h.includes("rate limit") || h.includes("too many requests"),
    userMessage: "The data provider rate-limited the request. Retrying shortly should work.",
    suggestedFix: "Honor retry_after if present; otherwise back off and retry.",
  },
  {
    category: "permission_config",
    severity: "high",
    retryable: false,
    match: (h) =>
      h.includes("storage.objects.create denied") ||
      (h.includes("403") && h.includes("storage")) ||
      h.includes("permission denied"),
    userMessage: "The action ran but a storage/permission check rejected it (403). Retrying won't help.",
    suggestedFix: "Grant the missing permission to the service account or use a writable target.",
  },
  {
    category: "auth_error",
    severity: "high",
    retryable: false,
    match: (h) => h.includes("401") || h.includes("unauthorized") || h.includes("invalid api key"),
    userMessage: "Authentication failed for this provider. Retrying won't help until credentials are fixed.",
    suggestedFix: "Check the provider API key / auth configuration.",
  },
  {
    category: "data_not_ready",
    severity: "low",
    retryable: true,
    match: (h) =>
      h.includes("not enough") ||
      h.includes("not ready") ||
      h.includes("no fixtures") ||
      h.includes("no data available yet"),
    userMessage: "The underlying data isn't populated yet, so the result would be unreliable.",
    suggestedFix: "Wait until the required data is available, then retry.",
  },
  {
    category: "user_input",
    severity: "medium",
    retryable: false,
    match: (h) =>
      h.includes("must be prefixed") ||
      h.includes("looks like a name, not a valid") ||
      h.includes("invalid argument") ||
      h.includes("required parameter"),
    userMessage: "The request needs a corrected or resolved input before it can run.",
    suggestedFix: "Resolve/normalize the offending argument, then retry.",
  },
];

function toHaystack(error: string | { message?: string } | undefined): string {
  if (!error) return "";
  if (typeof error === "string") return error;
  return String(error.message ?? "");
}

/**
 * Turn a raw tool/workflow error into a structured, user-safe classification.
 * Composes the generic pattern rules above with the bridge classifier for
 * Python-subprocess-specific codes (timeout, dependency_missing, circuit_open, …).
 */
export function classifyFailure(
  error: string | { message?: string } | undefined,
  toolName?: string,
): ClassifiedFailure {
  const raw = toHaystack(error);
  const h = raw.toLowerCase();

  for (const rule of RULES) {
    if (rule.match(h)) {
      return {
        category: rule.category,
        severity: rule.severity,
        retryable: rule.retryable,
        userMessage: rule.userMessage,
        developerMessage: toolName ? `[${toolName}] ${raw}` : raw,
        suggestedFix: rule.suggestedFix,
        rawError: raw,
      };
    }
  }

  // Fall back to the bridge classifier for subprocess-specific codes.
  const { errorCode, hint } = classifyBridgeError(raw);
  const mapping: Record<string, { category: FailureCategory; retryable: boolean; severity: "low" | "medium" | "high" }> = {
    timeout: { category: "provider_error", retryable: true, severity: "medium" },
    dependency_missing: { category: "permission_config", retryable: false, severity: "high" },
    network_dns: { category: "provider_error", retryable: true, severity: "medium" },
    rate_limited: { category: "rate_limited", retryable: true, severity: "low" },
    python_version_incompatible: { category: "permission_config", retryable: false, severity: "high" },
    circuit_open: { category: "provider_error", retryable: true, severity: "medium" },
    tool_execution_failed: { category: "unknown", retryable: false, severity: "medium" },
  };
  const m = mapping[errorCode] ?? { category: "unknown" as FailureCategory, retryable: false, severity: "medium" as const };

  return {
    category: m.category,
    severity: m.severity,
    retryable: m.retryable,
    userMessage: hint,
    developerMessage: toolName ? `[${toolName}] ${raw}` : raw,
    suggestedFix: hint,
    rawError: raw,
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run build && node --test test/failure-classifier.test.mjs`
Expected: PASS — 6 tests.

- [ ] **Step 6: Add the test script**

In `package.json` scripts, add:
```json
"test:failure-classifier": "npm run build && node --test test/failure-classifier.test.mjs"
```

- [ ] **Step 7: Commit**

```bash
git add src/failures/ test/failure-classifier.test.mjs package.json
git commit -m "feat(failures): generic failure classifier composing bridge/mcp classifiers"
```

---

### Task 2: Wire `classifyFailure` into the tool execution failure path

**Files:**
- Modify: `src/tools.ts` (the `ToolRegistry.execute` failure branch — locate the `catch`/`isError` return that currently surfaces raw bridge errors)
- Test: `test/tool-failure-classification.test.mjs`

**Interfaces:**
- Consumes: `classifyFailure` from `src/failures/classifier.js`; `ToolCallResult` from `src/bridge.js`.
- Produces: on failure, `ToolCallResult.content` is the classified `userMessage` (falls back to raw when classification is `unknown` with an empty hint). No signature change to `execute`.

- [ ] **Step 1: Locate the failure return site**

Run: `grep -n "isError: true" src/tools.ts`
Read the surrounding function so the edit targets the real failure branch (do not invent a new one).

- [ ] **Step 2: Write the failing test**

```javascript
// test/tool-failure-classification.test.mjs
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { classifyFailure } from "../dist/failures/classifier.js";

// Behavioral contract used by ToolRegistry.execute's failure branch:
// a raw provider error is turned into a clean, actionable user message.
describe("tool failure classification contract", () => {
  it("produces an actionable message for a rate limit", () => {
    const f = classifyFailure("429 too many requests", "nba_get_scoreboard");
    assert.equal(f.category, "rate_limited");
    assert.ok(/retry/i.test(f.userMessage));
    assert.ok(f.developerMessage.includes("nba_get_scoreboard"));
  });
});
```

- [ ] **Step 3: Run test to verify it passes at the contract level**

Run: `npm run build && node --test test/tool-failure-classification.test.mjs`
Expected: PASS (this asserts the classifier contract the wiring relies on).

- [ ] **Step 4: Edit the failure branch in `src/tools.ts`**

Add the import at the top with the other local imports:
```typescript
import { classifyFailure } from "./failures/classifier.js";
```

In the failure return branch identified in Step 1, replace the raw-content return with:
```typescript
const classified = classifyFailure(errorText, toolName);
return {
  content: classified.userMessage || errorText,
  isError: true,
};
```
Use the branch's existing error variable in place of `errorText` (rename to match — do NOT introduce a new variable that isn't in scope).

- [ ] **Step 5: Run the broader tool tests to confirm no regression**

Run: `npm run build && node --test test/consumer-tool-failure-ux.test.mjs test/builtin-tools.test.mjs`
Expected: PASS.

- [ ] **Step 6: Add the test script + commit**

Add to `package.json`:
```json
"test:tool-failure-classification": "npm run build && node --test test/tool-failure-classification.test.mjs"
```
```bash
git add src/tools.ts test/tool-failure-classification.test.mjs package.json
git commit -m "feat(tools): surface classified failure messages from tool execution"
```

---

### Task 3: selftest cases + runner + report (Phase 2)

**Files:**
- Create: `src/selftest/cases.ts`
- Create: `src/selftest/report.ts`
- Create: `src/selftest/runner.ts`
- Test: `test/selftest-runner.test.mjs`

**Interfaces:**
- Consumes: `classifyFailure` from `src/failures/classifier.js`.
- Produces:
  - `interface SmokeTestCase { sport: string; name: string; toolName: string; args: Record<string, unknown>; live?: boolean; required?: boolean; }`
  - `const SMOKE_TESTS: SmokeTestCase[]`
  - `interface SmokeResult { sport: string; check: string; status: "pass" | "fail" | "skip"; latencyMs: number; notes: string; }`
  - `interface SelfTestReport { version: string; passed: number; failed: number; skipped: number; results: SmokeResult[]; toJSON(): Record<string, unknown>; }`
  - `function runSelftest(opts: { sports?: string[]; live?: boolean; execute?: (c: SmokeTestCase) => Promise<{ ok: boolean; note?: string; latencyMs: number }> }): Promise<SelfTestReport>`
  - `renderMarkdown(report: SelfTestReport): string`

The `execute` callback is injected so `runSelftest` is testable without a live bridge. The CLI (Task 4) supplies the real executor.

- [ ] **Step 1: Write the failing test**

```javascript
// test/selftest-runner.test.mjs
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runSelftest } from "../dist/selftest/runner.js";
import { renderMarkdown } from "../dist/selftest/report.js";

describe("runSelftest", () => {
  it("returns one result per case for the requested sport (offline)", async () => {
    const report = await runSelftest({
      sports: ["metadata"],
      live: false,
      execute: async () => ({ ok: true, latencyMs: 1, note: "stub" }),
    });
    assert.ok(report.results.length >= 1);
    assert.equal(report.results[0].sport, "metadata");
    assert.equal(report.failed, 0);
  });

  it("produces a JSON-serializable report", async () => {
    const report = await runSelftest({
      sports: ["metadata"],
      live: false,
      execute: async () => ({ ok: true, latencyMs: 1 }),
    });
    const json = JSON.stringify(report.toJSON());
    assert.ok(json.includes("passed"));
  });

  it("marks a failing case as fail with a note", async () => {
    const report = await runSelftest({
      sports: ["metadata"],
      live: true,
      execute: async () => ({ ok: false, latencyMs: 2, note: "401 auth" }),
    });
    assert.equal(report.failed >= 1, true);
    assert.equal(report.results.some((r) => r.status === "fail"), true);
  });

  it("renders a markdown table with a header row", () => {
    const md = renderMarkdown({
      version: "0.29.1", passed: 1, failed: 0, skipped: 0,
      results: [{ sport: "nba", check: "scoreboard", status: "pass", latencyMs: 431, notes: "6 games" }],
      toJSON() { return {}; },
    });
    assert.ok(md.includes("Sport"));
    assert.ok(md.includes("nba"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/selftest-runner.test.mjs`
Expected: FAIL — `Cannot find module '../dist/selftest/runner.js'`.

- [ ] **Step 3: Write `src/selftest/cases.ts`**

```typescript
// src/selftest/cases.ts

export interface SmokeTestCase {
  sport: string;
  name: string;
  toolName: string;
  args: Record<string, unknown>;
  live?: boolean;
  required?: boolean;
}

// Tool names verified against sports-skills v0.28.0 (`<module>_<command>`).
export const SMOKE_TESTS: SmokeTestCase[] = [
  { sport: "nba", name: "scoreboard", toolName: "nba_get_scoreboard", args: {} },
  { sport: "nba", name: "standings", toolName: "nba_get_standings", args: {} },
  { sport: "nfl", name: "scoreboard", toolName: "nfl_get_scoreboard", args: {} },
  { sport: "mlb", name: "scoreboard", toolName: "mlb_get_scoreboard", args: {} },
  { sport: "football", name: "competitions", toolName: "football_get_competitions", args: {} },
  { sport: "metadata", name: "team search", toolName: "metadata_search_teams", args: { query: "Lakers" } },
  { sport: "kalshi", name: "exchange status", toolName: "kalshi_get_exchange_status", args: {} },
  { sport: "polymarket", name: "sports config", toolName: "polymarket_get_sports_config", args: {} },
];
```

- [ ] **Step 4: Write `src/selftest/report.ts`**

```typescript
// src/selftest/report.ts

export interface SmokeResult {
  sport: string;
  check: string;
  status: "pass" | "fail" | "skip";
  latencyMs: number;
  notes: string;
}

export interface SelfTestReport {
  version: string;
  passed: number;
  failed: number;
  skipped: number;
  results: SmokeResult[];
  toJSON(): Record<string, unknown>;
}

export function renderMarkdown(report: SelfTestReport): string {
  const lines = [
    "| Sport | Check | Status | Latency | Notes |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const r of report.results) {
    lines.push(`| ${r.sport} | ${r.check} | ${r.status} | ${r.latencyMs}ms | ${r.notes} |`);
  }
  lines.push("");
  lines.push(`**${report.passed} passed, ${report.failed} failed, ${report.skipped} skipped**`);
  return lines.join("\n");
}
```

- [ ] **Step 5: Write `src/selftest/runner.ts`**

```typescript
// src/selftest/runner.ts
import { SMOKE_TESTS, type SmokeTestCase } from "./cases.js";
import type { SelfTestReport, SmokeResult } from "./report.js";

interface RunOptions {
  sports?: string[];
  live?: boolean;
  version?: string;
  execute?: (c: SmokeTestCase) => Promise<{ ok: boolean; note?: string; latencyMs: number }>;
}

export async function runSelftest(opts: RunOptions): Promise<SelfTestReport> {
  const version = opts.version ?? "0.0.0";
  const live = opts.live ?? false;
  const cases = SMOKE_TESTS.filter((c) => !opts.sports || opts.sports.includes(c.sport));

  const results: SmokeResult[] = [];
  for (const c of cases) {
    if (c.live !== false && !live) {
      results.push({ sport: c.sport, check: c.name, status: "skip", latencyMs: 0, notes: "offline (use --live)" });
      continue;
    }
    if (!opts.execute) {
      results.push({ sport: c.sport, check: c.name, status: "skip", latencyMs: 0, notes: "no executor" });
      continue;
    }
    const r = await opts.execute(c);
    results.push({
      sport: c.sport,
      check: c.name,
      status: r.ok ? "pass" : "fail",
      latencyMs: r.latencyMs,
      notes: r.note ?? "",
    });
  }

  const passed = results.filter((r) => r.status === "pass").length;
  const failed = results.filter((r) => r.status === "fail").length;
  const skipped = results.filter((r) => r.status === "skip").length;

  return {
    version, passed, failed, skipped, results,
    toJSON() {
      return { version, passed, failed, skipped, results };
    },
  };
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npm run build && node --test test/selftest-runner.test.mjs`
Expected: PASS — 4 tests. (Note: the offline test's cases have `live` undefined → treated as live-required → skipped unless `live:true`; the first test passes because `execute` returns ok and the assertion only checks `results.length >= 1` and `failed === 0` — skipped cases are neither. Verify this holds; if the first test needs a pass result, set `live: true` in that test call.)

- [ ] **Step 7: Add the test script + commit**

Add to `package.json`:
```json
"test:selftest-runner": "npm run build && node --test test/selftest-runner.test.mjs"
```
```bash
git add src/selftest/ test/selftest-runner.test.mjs package.json
git commit -m "feat(selftest): schema smoke-test runner + report (offline-testable)"
```

---

### Task 4: `sportsclaw selftest` CLI command (Phase 2)

**Files:**
- Modify: `src/index.ts` (add `cmdSelftest`, wire into the top-level arg dispatch and `printHelp`)
- Test: manual CLI verification (this task's deliverable is the wired command; logic is covered by Task 3)

**Interfaces:**
- Consumes: `runSelftest`, `renderMarkdown` from `src/selftest/*.js`; the existing engine/tool-execution entry used by `cmdQuery`/`cmdHealth` to run a single tool by name; `resolveConfig()` and the package version already read in `cmdDoctor`/`cmdHealth`.
- Produces: `sportsclaw selftest [--quick] [--sport <s>] [--json] [--live]`.

- [ ] **Step 1: Read the existing command dispatch + a real tool-invocation call site**

Run: `grep -n "cmdHealth\|cmdDoctor\|case \"doctor\"\|case \"health\"\|selftest" src/index.ts`
Read `cmdHealth` and the top-level dispatch (where `doctor`/`health` route) to copy the exact wiring pattern and the real single-tool execution path.

- [ ] **Step 2: Add `cmdSelftest` in `src/index.ts`**

```typescript
async function cmdSelftest(args: string[]): Promise<void> {
  const json = args.includes("--json");
  const live = args.includes("--live");
  const quick = args.includes("--quick");
  const sportIdx = args.indexOf("--sport");
  const sports = sportIdx >= 0 && args[sportIdx + 1] ? [args[sportIdx + 1]] : undefined;

  const { runSelftest } = await import("./selftest/runner.js");
  const { renderMarkdown } = await import("./selftest/report.js");

  // quick = first case per sport only
  const seen = new Set<string>();
  const executor = async (c: { sport: string; toolName: string; args: Record<string, unknown> }) => {
    if (quick) {
      if (seen.has(c.sport)) return { ok: true, latencyMs: 0, note: "skipped (quick)" };
      seen.add(c.sport);
    }
    const started = Date.now();
    try {
      // Reuse the real single-tool path used by cmdQuery/cmdHealth.
      const result = await runSingleTool(c.toolName, c.args); // <-- replace with the actual helper found in Step 1
      const latencyMs = Date.now() - started;
      const ok = !result.isError;
      return { ok, latencyMs, note: ok ? summarize(result.content) : result.content.slice(0, 60) };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - started, note: String(err).slice(0, 60) };
    }
  };

  const version = getPackageVersion(); // <-- reuse whatever cmdDoctor/cmdHealth uses
  const report = await runSelftest({ sports, live, version, execute: executor });

  if (json) {
    console.log(JSON.stringify(report.toJSON(), null, 2));
  } else {
    console.log(renderMarkdown(report));
  }
  process.exit(report.failed > 0 ? 1 : 0);
}
```
Replace `runSingleTool`, `summarize`, and `getPackageVersion` with the actual helpers discovered in Step 1 (do not invent them — `cmdHealth` already runs tools and reads the version). Keep `summarize` to a one-line note (e.g. count of events) or inline it.

- [ ] **Step 3: Wire into dispatch + help**

In the top-level command switch (same place `doctor`/`health` are handled), add:
```typescript
case "selftest":
  await cmdSelftest(args.slice(1));
  break;
```
Add a line to `printHelp()` next to `doctor`/`health`:
```
  selftest [--quick] [--sport <s>] [--json] [--live]   Run schema smoke tests
```

- [ ] **Step 4: Verify the command runs**

Run: `npm run build && node dist/index.js selftest --json`
Expected: valid JSON with `passed`/`failed`/`skipped`/`results` (offline → cases skipped). Then:
Run: `node dist/index.js selftest --quick --live --sport metadata`
Expected: a markdown table with the metadata team-search row (pass/fail depending on network).

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat(cli): add sportsclaw selftest command"
```

---

### Task 5: Persistent entity store + TTL (Phase 3)

**Files:**
- Create: `src/cache/entity-store.ts`
- Test: `test/entity-store.test.mjs`

**Interfaces:**
- Produces:
  - `type EntityType = "team" | "player" | "competition" | "season" | "market"`
  - `interface CachedEntity { id: string; entityType: EntityType; sport: string | null; league: string | null; canonicalName: string; aliases: string[]; providerIds: Record<string, string>; metadata: Record<string, unknown>; confidence: number; firstSeenAt: string; lastVerifiedAt: string; mentionCount: number; }`
  - `function entityIsStale(entity: CachedEntity, now?: number): boolean`
  - `class EntityStore { constructor(filePath?: string); load(): Promise<void>; get(query: string, entityType?: EntityType, sport?: string): CachedEntity | undefined; upsert(entity: CachedEntity): Promise<void>; }`
- TTLs (days): team 180, player 90, competition 365, season 30, market 1.
- Storage: `~/.sportsclaw/entity-cache.json` (default path). Follows the atomic-write pattern used elsewhere in the repo.

- [ ] **Step 1: Write the failing test**

```javascript
// test/entity-store.test.mjs
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EntityStore, entityIsStale } from "../dist/cache/entity-store.js";

function nowISO() { return new Date().toISOString(); }
function daysAgoISO(d) { return new Date(Date.now() - d * 86400000).toISOString(); }

describe("EntityStore", () => {
  it("upserts and gets an entity by alias", async () => {
    const store = new EntityStore(join(tmpdir(), `ec-${process.pid}-${Math.floor(process.hrtime()[1])}.json`));
    await store.load();
    await store.upsert({
      id: "nba:team:lakers", entityType: "team", sport: "nba", league: "NBA",
      canonicalName: "Los Angeles Lakers", aliases: ["Lakers", "LA Lakers"],
      providerIds: { espn: "13" }, metadata: {}, confidence: 1.0,
      firstSeenAt: nowISO(), lastVerifiedAt: nowISO(), mentionCount: 1,
    });
    const found = store.get("Lakers", "team", "nba");
    assert.equal(found?.providerIds.espn, "13");
  });

  it("treats a 2-day-old market entity as stale (1-day TTL)", () => {
    const market = {
      id: "kalshi:KX", entityType: "market", sport: null, league: null,
      canonicalName: "KX", aliases: [], providerIds: {}, metadata: {},
      confidence: 1.0, firstSeenAt: daysAgoISO(2), lastVerifiedAt: daysAgoISO(2), mentionCount: 1,
    };
    assert.equal(entityIsStale(market), true);
  });

  it("treats a 2-day-old team entity as fresh (180-day TTL)", () => {
    const team = {
      id: "nba:team:lakers", entityType: "team", sport: "nba", league: "NBA",
      canonicalName: "Los Angeles Lakers", aliases: [], providerIds: {}, metadata: {},
      confidence: 1.0, firstSeenAt: daysAgoISO(2), lastVerifiedAt: daysAgoISO(2), mentionCount: 1,
    };
    assert.equal(entityIsStale(team), false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/entity-store.test.mjs`
Expected: FAIL — `Cannot find module '../dist/cache/entity-store.js'`.

- [ ] **Step 3: Write `src/cache/entity-store.ts`**

```typescript
// src/cache/entity-store.ts
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type EntityType = "team" | "player" | "competition" | "season" | "market";

export interface CachedEntity {
  id: string;
  entityType: EntityType;
  sport: string | null;
  league: string | null;
  canonicalName: string;
  aliases: string[];
  providerIds: Record<string, string>;
  metadata: Record<string, unknown>;
  confidence: number;
  firstSeenAt: string;
  lastVerifiedAt: string;
  mentionCount: number;
}

const TTL_DAYS: Record<EntityType, number> = {
  team: 180, player: 90, competition: 365, season: 30, market: 1,
};

export function entityIsStale(entity: CachedEntity, now: number = Date.now()): boolean {
  const ttlMs = TTL_DAYS[entity.entityType] * 86_400_000;
  const verified = Date.parse(entity.lastVerifiedAt);
  if (Number.isNaN(verified)) return true;
  return now - verified > ttlMs;
}

const DEFAULT_PATH = join(homedir(), ".sportsclaw", "entity-cache.json");

export class EntityStore {
  private byId = new Map<string, CachedEntity>();
  private loaded = false;

  constructor(private filePath: string = DEFAULT_PATH) {}

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const arr = JSON.parse(raw) as CachedEntity[];
      for (const e of arr) this.byId.set(e.id, e);
    } catch {
      // Missing/corrupt file → start empty.
    }
    this.loaded = true;
  }

  get(query: string, entityType?: EntityType, sport?: string): CachedEntity | undefined {
    const q = query.trim().toLowerCase();
    for (const e of this.byId.values()) {
      if (entityType && e.entityType !== entityType) continue;
      if (sport && (e.sport ?? "").toLowerCase() !== sport.toLowerCase()) continue;
      if (entityIsStale(e)) continue;
      const names = [e.canonicalName, ...e.aliases].map((n) => n.toLowerCase());
      if (names.includes(q)) return e;
    }
    return undefined;
  }

  async upsert(entity: CachedEntity): Promise<void> {
    if (!this.loaded) await this.load();
    const existing = this.byId.get(entity.id);
    if (existing) {
      entity.mentionCount = existing.mentionCount + 1;
      entity.firstSeenAt = existing.firstSeenAt;
    }
    this.byId.set(entity.id, entity);
    await this.persist();
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    await writeFile(tmp, JSON.stringify([...this.byId.values()], null, 2), "utf8");
    await rename(tmp, this.filePath); // atomic replace
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test test/entity-store.test.mjs`
Expected: PASS — 3 tests.

- [ ] **Step 5: Add the test script + commit**

Add to `package.json`:
```json
"test:entity-store": "npm run build && node --test test/entity-store.test.mjs"
```
```bash
git add src/cache/ test/entity-store.test.mjs package.json
git commit -m "feat(cache): persistent entity store with per-type TTL"
```

---

### Task 6: Back the in-memory `EntityResolver` with the persistent store (Phase 3)

**Files:**
- Modify: `src/intelligence/entity-resolver.ts`
- Test: `test/entity-resolver-persistence.test.mjs`

**Interfaces:**
- Consumes: `EntityStore`, `CachedEntity` from `src/cache/entity-store.js`.
- Produces: `EntityResolver.getInstance()` gains `async hydrate(store?: EntityStore): Promise<void>` (loads persisted entities into the in-memory registry) and `async remember(entity: CachedEntity): Promise<void>` (upserts to store + registers in memory). Existing sync methods (`resolveTeam`, `resolvePlayer`, `mapToProviderId`) are unchanged.

- [ ] **Step 1: Write the failing test**

```javascript
// test/entity-resolver-persistence.test.mjs
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EntityResolver } from "../dist/intelligence/entity-resolver.js";
import { EntityStore } from "../dist/cache/entity-store.js";

describe("EntityResolver persistence", () => {
  it("remembers an entity to the store and maps its provider id", async () => {
    const path = join(tmpdir(), `er-${process.pid}.json`);
    const store = new EntityStore(path);
    const r = EntityResolver.getInstance();
    await r.hydrate(store);
    await r.remember({
      id: "nba:team:lakers", entityType: "team", sport: "nba", league: "NBA",
      canonicalName: "Los Angeles Lakers", aliases: ["Lakers"],
      providerIds: { espn: "13" }, metadata: {}, confidence: 1,
      firstSeenAt: new Date().toISOString(), lastVerifiedAt: new Date().toISOString(), mentionCount: 1,
    });
    // Fresh store instance sees the persisted row.
    const store2 = new EntityStore(path);
    await store2.load();
    assert.equal(store2.get("Lakers", "team", "nba")?.providerIds.espn, "13");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/entity-resolver-persistence.test.mjs`
Expected: FAIL — `r.hydrate is not a function`.

- [ ] **Step 3: Add `hydrate` + `remember` to `src/intelligence/entity-resolver.ts`**

Add the import at the top:
```typescript
import { EntityStore, type CachedEntity } from "../cache/entity-store.js";
```
Add a private field and two methods to the class (place after the constructor):
```typescript
  private store: EntityStore | null = null;

  public async hydrate(store?: EntityStore): Promise<void> {
    this.store = store ?? new EntityStore();
    await this.store.load();
  }

  public async remember(entity: CachedEntity): Promise<void> {
    if (this.store) await this.store.upsert(entity);
    if (entity.sport && (entity.entityType === "team" || entity.entityType === "player")) {
      this.register(entity.sport, entity.entityType, {
        canonicalId: entity.id,
        aliases: [entity.canonicalName, ...entity.aliases],
        providerIds: entity.providerIds,
      });
    }
  }
```
(`register`'s third arg accepts `event` too, but the `CachedEntity` types map cleanly for team/player; competitions/seasons/markets persist to the store without in-memory registration.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test test/entity-resolver-persistence.test.mjs`
Expected: PASS.

- [ ] **Step 5: Add the test script + commit**

Add to `package.json`:
```json
"test:entity-resolver-persistence": "npm run build && node --test test/entity-resolver-persistence.test.mjs"
```
```bash
git add src/intelligence/entity-resolver.ts test/entity-resolver-persistence.test.mjs package.json
git commit -m "feat(intelligence): back EntityResolver with persistent store"
```

---

### Task 7: Query complexity classifier + skill-cap planner (Phase 4)

**Files:**
- Create: `src/routing/complexity.ts`
- Test: `test/routing-complexity.test.mjs`

**Interfaces:**
- Produces:
  - `type QueryComplexity = "simple" | "compound" | "research" | "betting" | "live_game"`
  - `interface SkillCapPlan { complexity: QueryComplexity; maxSkills: number; addSkills: string[]; reason: string; }`
  - `function classifyQueryComplexity(query: string): QueryComplexity`
  - `function planSkillCaps(query: string, base: { routingMaxSkills: number; routingAllowSpillover: number }): SkillCapPlan`

- [ ] **Step 1: Write the failing test**

```javascript
// test/routing-complexity.test.mjs
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { classifyQueryComplexity, planSkillCaps } from "../dist/routing/complexity.js";

const base = { routingMaxSkills: 2, routingAllowSpillover: 1 };

describe("query complexity planning", () => {
  it("keeps a simple score query at <= 2 skills", () => {
    const plan = planSkillCaps("lakers score", base);
    assert.ok(plan.maxSkills <= 2);
  });

  it("expands a betting query to >= 3 skills with a market skill", () => {
    const plan = planSkillCaps("best Lakers bets tonight", base);
    assert.ok(plan.maxSkills >= 3);
    assert.ok(plan.addSkills.some((s) => ["betting", "markets", "kalshi", "polymarket"].includes(s)));
  });

  it("expands a multi-sport query to >= 4 skills", () => {
    const plan = planSkillCaps("what's happening tonight across sports", base);
    assert.ok(plan.maxSkills >= 4);
  });

  it("classifies an injury/news query as compound", () => {
    assert.equal(classifyQueryComplexity("any injury news for the lakers?"), "compound");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/routing-complexity.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/routing/complexity.ts`**

```typescript
// src/routing/complexity.ts

export type QueryComplexity = "simple" | "compound" | "research" | "betting" | "live_game";

export interface SkillCapPlan {
  complexity: QueryComplexity;
  maxSkills: number;
  addSkills: string[];
  reason: string;
}

const BETTING_KW = ["bet", "bets", "odds", "line", "spread", "total", "over", "under", "market", "price", "edge", "kelly"];
const LIVE_KW = ["live", "right now", "score", "winning", "quarter", "period", "inning"];
const NEWS_KW = ["injury", "injuries", "out", "questionable", "news", "report"];
const MULTISPORT_KW = ["across sports", "what's happening", "whats happening", "everything", "all sports", "tonight across"];
const RESEARCH_KW = ["audit", "deep dive", "analyze", "research", "compare", "breakdown"];

function hasAny(h: string, kws: string[]): boolean {
  return kws.some((k) => h.includes(k));
}

export function classifyQueryComplexity(query: string): QueryComplexity {
  const h = query.toLowerCase();
  if (hasAny(h, MULTISPORT_KW)) return "research";
  if (hasAny(h, RESEARCH_KW)) return "research";
  if (hasAny(h, BETTING_KW)) return "betting";
  if (hasAny(h, NEWS_KW)) return "compound";
  if (hasAny(h, LIVE_KW)) return "live_game";
  return "simple";
}

export function planSkillCaps(
  query: string,
  base: { routingMaxSkills: number; routingAllowSpillover: number },
): SkillCapPlan {
  const complexity = classifyQueryComplexity(query);
  const h = query.toLowerCase();
  const addSkills: string[] = [];
  let maxSkills = base.routingMaxSkills;
  let reason = "simple query — default caps";

  switch (complexity) {
    case "betting":
      maxSkills = Math.max(maxSkills, 3);
      addSkills.push("betting", "markets", "kalshi", "polymarket");
      reason = "betting intent — added market skills";
      break;
    case "research":
      maxSkills = Math.max(maxSkills, 4);
      reason = "multi-sport/research — widened skill budget";
      break;
    case "compound":
      maxSkills = Math.max(maxSkills, 3);
      if (hasAny(h, NEWS_KW)) addSkills.push("news");
      reason = "compound (injury/news) — added news";
      break;
    case "live_game":
      maxSkills = Math.max(maxSkills, 3);
      reason = "live-game intent";
      break;
    case "simple":
    default:
      break;
  }
  return { complexity, maxSkills, addSkills, reason };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test test/routing-complexity.test.mjs`
Expected: PASS — 4 tests.

- [ ] **Step 5: Add the test script + commit**

Add to `package.json`:
```json
"test:routing-complexity": "npm run build && node --test test/routing-complexity.test.mjs"
```
```bash
git add src/routing/ test/routing-complexity.test.mjs package.json
git commit -m "feat(routing): query-complexity classifier + skill-cap planner"
```

---

### Task 8: Integrate the skill-cap planner into `router.ts` (Phase 4)

**Files:**
- Modify: `src/router.ts` (inside `routePromptToSkills`, before the LLM route call at `:304`)
- Test: `test/router-complexity-integration.test.mjs`

**Interfaces:**
- Consumes: `planSkillCaps` from `src/routing/complexity.js`; the existing `RouteInput.config` (`routingMaxSkills`, `routingAllowSpillover`) and `RouteInput.prompt`.
- Produces: `routePromptToSkills` uses an effective `maxSkills = max(config.routingMaxSkills, planSkillCaps(prompt).maxSkills)` and seeds the planner's `addSkills` (intersected with `installedSkills`) into the candidate set. No signature change.

- [ ] **Step 1: Read `routePromptToSkills` to find where `routingMaxSkills` is consumed**

Run: `grep -n "routingMaxSkills\|routingAllowSpillover\|installedSkills" src/router.ts`
Read that region so the edit uses the real local variables (do not introduce parallel state).

- [ ] **Step 2: Write the integration test**

```javascript
// test/router-complexity-integration.test.mjs
import assert from "node:assert/strict";
import { describe, it } from "node:test";

// The planner is the unit under test at the routing boundary; this guards the
// contract router.ts relies on so a future refactor can't silently narrow it.
import { planSkillCaps } from "../dist/routing/complexity.js";

describe("router complexity integration contract", () => {
  it("a betting prompt raises the effective max above the base of 2", () => {
    const plan = planSkillCaps("best bets for lakers tonight", { routingMaxSkills: 2, routingAllowSpillover: 1 });
    const effective = Math.max(2, plan.maxSkills);
    assert.ok(effective >= 3);
  });
});
```

- [ ] **Step 3: Run test to verify it passes at the contract level**

Run: `npm run build && node --test test/router-complexity-integration.test.mjs`
Expected: PASS.

- [ ] **Step 4: Edit `src/router.ts`**

Add the import with the other local imports:
```typescript
import { planSkillCaps } from "./routing/complexity.js";
```
Inside `routePromptToSkills`, immediately after `input` is destructured/available and before the max-skills value is used, compute:
```typescript
  const capPlan = planSkillCaps(input.prompt, {
    routingMaxSkills: input.config.routingMaxSkills,
    routingAllowSpillover: input.config.routingAllowSpillover,
  });
  const effectiveMaxSkills = Math.max(input.config.routingMaxSkills, capPlan.maxSkills);
  const seededSkills = capPlan.addSkills.filter((s) => input.installedSkills.includes(s));
```
Then use `effectiveMaxSkills` wherever `input.config.routingMaxSkills` currently caps the final selection, and union `seededSkills` into the candidate list the LLM router considers (respecting `effectiveMaxSkills`). Keep the existing spillover logic intact.

- [ ] **Step 5: Run the routing tests to confirm no regression**

Run: `npm run build && node --test test/model-role-router.test.mjs test/router-complexity-integration.test.mjs`
Expected: PASS. (If `model-role-router.test.mjs` covers a different router, also run any `test:*router*` script found via `grep -n router package.json`.)

- [ ] **Step 6: Add the test script + commit**

Add to `package.json`:
```json
"test:router-complexity-integration": "npm run build && node --test test/router-complexity-integration.test.mjs"
```
```bash
git add src/router.ts test/router-complexity-integration.test.mjs package.json
git commit -m "feat(router): expand skill caps for compound/betting/multi-sport queries"
```

---

### Task 9: `executeToolSafely` wrapper (Phase 5)

**Files:**
- Create: `src/tools/executor.ts`
- Test: `test/safe-executor.test.mjs`

**Interfaces:**
- Consumes: `sanitizeToolInput` from `src/tools.js`; `classifyFailure` from `src/failures/classifier.js`; `ClassifiedFailure` from `src/failures/types.js`; `ToolCallInput` from `src/bridge.js`.
- Produces:
  - `interface ToolExecutionResult { ok: boolean; toolName: string; args: Record<string, unknown>; data?: unknown; warnings: string[]; failure?: ClassifiedFailure; latencyMs?: number; normalized: boolean; }`
  - `function executeToolSafely(toolName: string, args: Record<string, unknown>, run: (name: string, a: Record<string, unknown>) => Promise<{ content: string; isError?: boolean }>, nowFn?: () => number): Promise<ToolExecutionResult>`

The real tool executor (`ToolRegistry.execute`) is injected as `run` so this composition unit is testable without a live bridge. This wrapper is the seam Task 2's inline classification will migrate to; keep both consistent.

- [ ] **Step 1: Write the failing test**

```javascript
// test/safe-executor.test.mjs
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { executeToolSafely } from "../dist/tools/executor.js";

describe("executeToolSafely", () => {
  it("returns ok with data on success and reports normalized args", async () => {
    const res = await executeToolSafely(
      "nba_get_standings",
      { season: "2026" }, // bare year → sanitizeToolInput normalizes to espn.nba.2026
      async (_n, a) => ({ content: JSON.stringify({ season: a.season }) }),
    );
    assert.equal(res.ok, true);
    assert.equal(res.normalized, true);
    assert.ok(String(res.data).includes("espn.nba.2026"));
  });

  it("classifies a failing run into a structured failure", async () => {
    const res = await executeToolSafely(
      "kalshi_get_exchange_status",
      {},
      async () => ({ content: "429 too many requests", isError: true }),
    );
    assert.equal(res.ok, false);
    assert.equal(res.failure?.category, "rate_limited");
    assert.equal(res.failure?.retryable, true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/safe-executor.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/tools/executor.ts`**

```typescript
// src/tools/executor.ts
import { sanitizeToolInput } from "../tools.js";
import { classifyFailure } from "../failures/classifier.js";
import type { ClassifiedFailure } from "../failures/types.js";

export interface ToolExecutionResult {
  ok: boolean;
  toolName: string;
  args: Record<string, unknown>;
  data?: unknown;
  warnings: string[];
  failure?: ClassifiedFailure;
  latencyMs?: number;
  normalized: boolean;
}

export async function executeToolSafely(
  toolName: string,
  args: Record<string, unknown>,
  run: (name: string, a: Record<string, unknown>) => Promise<{ content: string; isError?: boolean }>,
  nowFn: () => number = Date.now,
): Promise<ToolExecutionResult> {
  const started = nowFn();
  const normalizedArgs = { ...args };
  const before = JSON.stringify(normalizedArgs);
  sanitizeToolInput(toolName, normalizedArgs);
  const normalized = JSON.stringify(normalizedArgs) !== before;

  try {
    const result = await run(toolName, normalizedArgs);
    if (result.isError) {
      return {
        ok: false, toolName, args: normalizedArgs, warnings: [], normalized,
        failure: classifyFailure(result.content, toolName),
        latencyMs: nowFn() - started,
      };
    }
    return {
      ok: true, toolName, args: normalizedArgs, data: result.content, warnings: [], normalized,
      latencyMs: nowFn() - started,
    };
  } catch (err) {
    return {
      ok: false, toolName, args: normalizedArgs, warnings: [], normalized,
      failure: classifyFailure(err instanceof Error ? err.message : String(err), toolName),
      latencyMs: nowFn() - started,
    };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test test/safe-executor.test.mjs`
Expected: PASS — 2 tests. (Confirms `sanitizeToolInput` mutates in place — it does; see `src/tools.ts:132`.)

- [ ] **Step 5: Add the test script + commit**

Add to `package.json`:
```json
"test:safe-executor": "npm run build && node --test test/safe-executor.test.mjs"
```
```bash
git add src/tools/executor.ts test/safe-executor.test.mjs package.json
git commit -m "feat(tools): executeToolSafely wrapper composing sanitize + classify"
```

---

### Task 10: Structured `tool_execution` log with credential redaction (Phase 5)

**Files:**
- Modify: `src/analytics.ts` (add `logToolExecution` + `redactArgs`)
- Test: `test/tool-execution-log.test.mjs`

**Interfaces:**
- Consumes: `ToolExecutionResult` from `src/tools/executor.js`.
- Produces:
  - `function redactArgs(args: Record<string, unknown>): Record<string, unknown>`
  - `function buildToolExecutionEvent(result: ToolExecutionResult, timestamp: string): Record<string, unknown>` — shape `{ event: "tool_execution", tool_name, ok, latency_ms, failure_category, normalized, args_hash, timestamp }`.

- [ ] **Step 1: Read `src/analytics.ts` to match its logging/export style**

Run: `grep -n "export function\|export const\|createHash\|sha256" src/analytics.ts | head`
Follow the existing pattern (how events are shaped/emitted).

- [ ] **Step 2: Write the failing test**

```javascript
// test/tool-execution-log.test.mjs
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { redactArgs, buildToolExecutionEvent } from "../dist/analytics.js";

describe("tool_execution logging", () => {
  it("redacts credential-like keys and never leaks their values", () => {
    const out = redactArgs({ api_key: "secret", token: "abc", team: "Lakers" });
    const json = JSON.stringify(out);
    assert.ok(!json.includes("secret"));
    assert.ok(!json.includes("abc"));
    assert.ok(json.includes("Lakers"));
    assert.ok(!("api_key" in out));
  });

  it("builds an event with a hashed args field and no raw secrets", () => {
    const event = buildToolExecutionEvent({
      ok: false, toolName: "worldcup-get-market-state",
      args: { api_key: "secret", market_id: "kalshi:KX" },
      warnings: [], normalized: false, latencyMs: 122,
      failure: { category: "user_input", severity: "medium", retryable: false, userMessage: "x", developerMessage: "y" },
    }, "2026-07-07T00:00:00Z");
    const json = JSON.stringify(event);
    assert.ok(!json.includes("secret"));
    assert.equal(event.event, "tool_execution");
    assert.equal(event.failure_category, "user_input");
    assert.ok(String(event.args_hash).startsWith("sha256:"));
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm run build && node --test test/tool-execution-log.test.mjs`
Expected: FAIL — `redactArgs is not a function`.

- [ ] **Step 4: Add to `src/analytics.ts`**

Add at the top if not already imported:
```typescript
import { createHash } from "node:crypto";
```
Add the exports:
```typescript
const REDACT_KEYS = ["api_key", "apikey", "token", "authorization", "auth", "password", "secret", "private_key", "wallet", "credential"];

export function redactArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (REDACT_KEYS.some((r) => k.toLowerCase().includes(r))) continue;
    out[k] = v;
  }
  return out;
}

export function buildToolExecutionEvent(
  result: import("./tools/executor.js").ToolExecutionResult,
  timestamp: string,
): Record<string, unknown> {
  const argsHash = "sha256:" + createHash("sha256").update(JSON.stringify(redactArgs(result.args))).digest("hex");
  return {
    event: "tool_execution",
    tool_name: result.toolName,
    ok: result.ok,
    latency_ms: result.latencyMs ?? null,
    failure_category: result.failure?.category ?? null,
    normalized: result.normalized,
    args_hash: argsHash,
    timestamp,
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run build && node --test test/tool-execution-log.test.mjs`
Expected: PASS — 2 tests.

- [ ] **Step 6: Add the test script + commit**

Add to `package.json`:
```json
"test:tool-execution-log": "npm run build && node --test test/tool-execution-log.test.mjs"
```
```bash
git add src/analytics.ts test/tool-execution-log.test.mjs package.json
git commit -m "feat(analytics): structured tool_execution log with credential redaction"
```

---

### Task 11 (GATED — server-side, requires explicit user approval before running): World Cup market-state normalization

**This task does not touch the sportsclaw repo.** It hardens the hosted `worldcup-get-market-state` MCP workflow so a bare ticker/id is normalized to the `{source}:` prefix inside the workflow, before the `startswith('kalshi:'/'polymarket:')` branches. This keeps proprietary market logic off the MIT client and fixes all clients at once.

**Do NOT execute without the user's explicit go-ahead** — it edits a production workflow (`update_workflow_id`) and is a separate deploy. Confirm first.

- [ ] **Step 1: Confirm with the user** that server-side editing of the production `worldcup-get-market-state` workflow is approved for this session.

- [ ] **Step 2: Fetch the current workflow definition** via the World Cup MCP `retrieve_workflow_id` / `search_workflow` (name `worldcup-get-market-state`) and save the exact current `tasks`/`inputs` as a backup before any change.

- [ ] **Step 3: Add a leading normalization step** that rewrites `requested_id`: if it already contains `:` leave it; else if it matches a Kalshi shape (`^KX` / uppercase-hyphenated series) set `kalshi:<id>`; else if it matches a Polymarket shape (numeric / `0x…` token / slug) set `polymarket:<id>`; append a `state_warnings` entry noting the coercion. Prefer a dedicated `normalize_market_state`-adjacent connector so the logic is server-side and reusable.

- [ ] **Step 4: Verify** by executing the workflow with a bare ticker (`KXWCGAME-26JUL04PARFRA-FRA`) and confirming the kalshi branch now fires and `market` is non-empty, with a coercion warning present. Re-run with an already-prefixed id to confirm no double-prefixing.

- [ ] **Step 5: Record** the change (backup + new definition) in the WC MCP/ops notes. No sportsclaw commit.

---

## Self-Review

**Spec coverage:**
- §1 Preflight — season/player already exist (noted in spec); market normalization → Task 11 (server-side). Client preflight is exercised via Task 9 (`sanitizeToolInput` composition). ✓
- §2 Failure classification — Task 1. ✓
- §3 Readiness — reframed to failure classification (`data_not_ready`) in Task 1; no client gate (per spec non-goal). ✓
- §4 selftest — Tasks 3–4. ✓
- §5 Dynamic routing — Tasks 7–8. ✓
- §6 Entity cache — Tasks 5–6. ✓
- §7 executeToolSafely — Task 9. ✓
- §8 User-facing errors — Task 1 (`userMessage`) + Task 2 (wiring). ✓
- §9 Observability — Task 10. ✓

**Placeholder scan:** Task 4 intentionally references real helpers (`runSingleTool`, `getPackageVersion`, `summarize`) to be resolved against `cmdHealth`/`cmdDoctor` in Step 1 — flagged explicitly as "replace with the actual helper," not silent TODOs, because the CLI's private tool-invocation helper name can only be read at execution time. All other steps contain complete code.

**Type consistency:** `ClassifiedFailure`/`FailureCategory` (Task 1) are reused verbatim in Tasks 9–10. `CachedEntity`/`EntityType` (Task 5) reused in Task 6. `ToolExecutionResult` (Task 9) reused in Task 10. `planSkillCaps` signature (Task 7) matches its call in Task 8. Consistent. ✓

**Ordering:** Task 2 depends on Task 1; Task 4 on Task 3; Task 6 on Task 5; Task 8 on Task 7; Tasks 9–10 on Task 1. Phase order (1→5) respects this. Task 11 is independent and gated.
