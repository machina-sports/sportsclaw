# Harness Hardening P0–P2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the sportsclaw engine survive transient data-source failures, process restarts, and unbounded token spend — the three reliability gaps identified in the June 2026 harness audit.

**Architecture:** Three independent workstreams. P0 adds an error-class-aware retry policy and a per-sport circuit breaker around the Python subprocess bridge (`src/tools.ts`). P1 makes `SessionStore` persist sessions to disk with atomic writes and makes `FileMemoryStorage.write()` atomic (`src/engine.ts`, `src/memory.ts`). P2 captures LLM token usage from the Vercel AI SDK, logs it through analytics, and adds an optional daily token budget gate (`src/engine.ts`, `src/analytics.ts`, new `src/token-ledger.ts`).

**Tech Stack:** TypeScript/ESM, Node `node:test` + `assert/strict` for tests (existing convention: test files are `test/*.test.mjs` importing from `../dist/*.js`, run via `npm run build && node --test test/<file>`). No new dependencies.

**Conventions that apply to every task:**
- Build with `npm run build` (tsc; success = no emit errors).
- Tests import from `../dist/<module>.js`, never from `src/`.
- Each new test file gets a `test:<name>` script in `package.json` following the existing pattern: `"test:<name>": "npm run build && node --test test/<name>.test.mjs"`.
- Local imports in `src/` always use explicit `.js` extensions (ESM requirement).
- Logging style: `console.error("[sportsclaw] ...")`, gated on `config.verbose` for non-error chatter.

**Important corrections to the audit (verified against code 2026-06-12):**
- `executePythonBridge` already retries once (`src/tools.ts:1020-1054`) — but blindly: it retries deterministic failures (missing Python deps) and waits 0ms before retrying rate limits. The fix is *policy-aware* retry, not adding retry from scratch.
- `FileMemoryStorage.append` uses `appendFile` (O_APPEND, atomic at OS level) — there is NO read-modify-write race there. The real gap is `write()` (`src/memory.ts:149-152`), which is truncate-then-write and can tear on crash. `PodMemoryStorage` already serializes appends and has a race test (`test/pod-memory-append-race.test.mjs`).

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/circuit-breaker.ts` | Create | Generic keyed circuit breaker (no I/O, injectable clock) |
| `src/tools.ts` | Modify | Export `resolveRetryPlan`; wire retry policy + breaker into `executePythonBridge`; new `circuit_open` error code |
| `src/engine.ts` | Modify | `SessionStore` disk persistence; async `load()`; token usage capture; daily budget gate |
| `src/memory.ts` | Modify | Atomic `FileMemoryStorage.write()`; export the class for tests |
| `src/types.ts` | Modify | Add `dailyTokenBudget` to config |
| `src/analytics.ts` | Modify | Optional `inputTokens`/`outputTokens` on `QueryEvent` |
| `src/token-ledger.ts` | Create | Daily token tally persisted to disk |
| `test/fixtures/flaky-bridge.sh` | Create | Stub `sports_skills` executable that fails N times then succeeds |
| `test/bridge-retry-plan.test.mjs` | Create | Unit tests for `resolveRetryPlan` |
| `test/circuit-breaker.test.mjs` | Create | Unit tests for `CircuitBreaker` |
| `test/bridge-resilience.test.mjs` | Create | Integration tests for `executePythonBridge` retry + breaker |
| `test/session-store.test.mjs` | Create | Disk persistence round-trip, TTL, corruption |
| `test/file-memory-atomic.test.mjs` | Create | Atomic write behavior |
| `test/token-ledger.test.mjs` | Create | Ledger record/read/corruption |
| `test/analytics-tokens.test.mjs` | Create | `buildQueryEvent` token fields |

---

### Task 1: Retry policy — `resolveRetryPlan`

**Files:**
- Modify: `src/tools.ts` (after `classifyBridgeError`, ~line 95)
- Test: `test/bridge-retry-plan.test.mjs`
- Modify: `package.json` (add script)

- [ ] **Step 1: Write the failing test**

Create `test/bridge-retry-plan.test.mjs`:

```js
/**
 * resolveRetryPlan — error-class-aware retry policy for the Python bridge.
 *
 * Deterministic failures (missing deps, old Python) must never retry.
 * Transient failures (rate limit, DNS) retry with growing backoff.
 * Timeouts retry once with no sleep (the caller widens the window instead).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveRetryPlan } from "../dist/tools.js";

describe("resolveRetryPlan", () => {
  it("never retries dependency_missing", () => {
    assert.deepEqual(resolveRetryPlan("dependency_missing", 0), { retry: false, delayMs: 0 });
  });

  it("never retries python_version_incompatible", () => {
    assert.deepEqual(resolveRetryPlan("python_version_incompatible", 0), { retry: false, delayMs: 0 });
  });

  it("never retries circuit_open", () => {
    assert.deepEqual(resolveRetryPlan("circuit_open", 0), { retry: false, delayMs: 0 });
  });

  it("retries rate_limited twice with growing backoff", () => {
    const first = resolveRetryPlan("rate_limited", 0);
    assert.equal(first.retry, true);
    assert.ok(first.delayMs >= 1500 && first.delayMs < 1750, `got ${first.delayMs}`);

    const second = resolveRetryPlan("rate_limited", 1);
    assert.equal(second.retry, true);
    assert.ok(second.delayMs >= 3000 && second.delayMs < 3250, `got ${second.delayMs}`);

    assert.equal(resolveRetryPlan("rate_limited", 2).retry, false);
  });

  it("retries network_dns twice with shorter backoff", () => {
    const first = resolveRetryPlan("network_dns", 0);
    assert.equal(first.retry, true);
    assert.ok(first.delayMs >= 500 && first.delayMs < 750, `got ${first.delayMs}`);

    assert.equal(resolveRetryPlan("network_dns", 1).retry, true);
    assert.equal(resolveRetryPlan("network_dns", 2).retry, false);
  });

  it("retries timeout exactly once with zero delay", () => {
    assert.deepEqual(resolveRetryPlan("timeout", 0), { retry: true, delayMs: 0 });
    assert.equal(resolveRetryPlan("timeout", 1).retry, false);
  });

  it("retries tool_execution_failed once with a brief pause", () => {
    const first = resolveRetryPlan("tool_execution_failed", 0);
    assert.equal(first.retry, true);
    assert.ok(first.delayMs >= 250 && first.delayMs < 500, `got ${first.delayMs}`);
    assert.equal(resolveRetryPlan("tool_execution_failed", 1).retry, false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/bridge-retry-plan.test.mjs`
Expected: FAIL — `resolveRetryPlan` is not exported from `dist/tools.js` (`undefined is not a function` or SyntaxError on named import).

- [ ] **Step 3: Write the implementation**

In `src/tools.ts`, change the `BridgeErrorCode` union (line 24-30) to add the new code:

```typescript
type BridgeErrorCode =
  | "timeout"
  | "dependency_missing"
  | "network_dns"
  | "rate_limited"
  | "python_version_incompatible"
  | "circuit_open"
  | "tool_execution_failed";
```

In `classifyBridgeError`, add a branch immediately before the final `return` (the `tool_execution_failed` fallback, ~line 91):

```typescript
  if (haystack.includes("circuit breaker open")) {
    return {
      errorCode: "circuit_open",
      hint:
        "This data source is cooling down after repeated failures. " +
        "Try a different question or retry in about a minute.",
    };
  }
```

Then add the policy function right after `classifyBridgeError` (~line 96):

```typescript
export interface RetryPlan {
  retry: boolean;
  delayMs: number;
}

/**
 * Decide whether a failed bridge attempt should be retried and how long to
 * wait first. `attempt` is the zero-based index of the attempt that just
 * failed. Deterministic failures (missing deps, incompatible Python, open
 * circuit) never retry; transient failures back off with jitter so parallel
 * lanes don't stampede a recovering provider.
 */
export function resolveRetryPlan(
  errorCode: BridgeErrorCode,
  attempt: number
): RetryPlan {
  const jitter = () => Math.floor(Math.random() * 250);
  switch (errorCode) {
    case "dependency_missing":
    case "python_version_incompatible":
    case "circuit_open":
      return { retry: false, delayMs: 0 };
    case "rate_limited":
      return attempt < 2
        ? { retry: true, delayMs: 1500 * 2 ** attempt + jitter() }
        : { retry: false, delayMs: 0 };
    case "network_dns":
      return attempt < 2
        ? { retry: true, delayMs: 500 * 2 ** attempt + jitter() }
        : { retry: false, delayMs: 0 };
    case "timeout":
      // One retry; executePythonBridge widens the timeout window instead of sleeping.
      return attempt < 1
        ? { retry: true, delayMs: 0 }
        : { retry: false, delayMs: 0 };
    default:
      return attempt < 1
        ? { retry: true, delayMs: 250 + jitter() }
        : { retry: false, delayMs: 0 };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test test/bridge-retry-plan.test.mjs`
Expected: PASS (7 tests).

- [ ] **Step 5: Add package.json script and commit**

Add to `package.json` scripts (alphabetically near the other `test:` entries):

```json
"test:bridge-retry-plan": "npm run build && node --test test/bridge-retry-plan.test.mjs",
```

```bash
git add src/tools.ts test/bridge-retry-plan.test.mjs package.json
git commit -m "feat(bridge): error-class-aware retry policy for the Python bridge

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: `CircuitBreaker` class

**Files:**
- Create: `src/circuit-breaker.ts`
- Test: `test/circuit-breaker.test.mjs`
- Modify: `package.json` (add script)

- [ ] **Step 1: Write the failing test**

Create `test/circuit-breaker.test.mjs`:

```js
/**
 * CircuitBreaker — keyed failure counter that fails fast after a threshold
 * of consecutive failures and allows a half-open probe after a cooldown.
 * Clock is injectable so tests never sleep.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CircuitBreaker } from "../dist/circuit-breaker.js";

describe("CircuitBreaker", () => {
  it("allows calls while below the failure threshold", () => {
    const cb = new CircuitBreaker({ failureThreshold: 3 });
    cb.recordFailure("nfl");
    cb.recordFailure("nfl");
    assert.equal(cb.canProceed("nfl"), true);
  });

  it("opens after threshold consecutive failures", () => {
    const cb = new CircuitBreaker({ failureThreshold: 3 });
    cb.recordFailure("nfl");
    cb.recordFailure("nfl");
    cb.recordFailure("nfl");
    assert.equal(cb.canProceed("nfl"), false);
  });

  it("keys are independent", () => {
    const cb = new CircuitBreaker({ failureThreshold: 1 });
    cb.recordFailure("nfl");
    assert.equal(cb.canProceed("nfl"), false);
    assert.equal(cb.canProceed("nba"), true);
  });

  it("a success resets the consecutive failure count and closes the circuit", () => {
    const cb = new CircuitBreaker({ failureThreshold: 2 });
    cb.recordFailure("nfl");
    cb.recordFailure("nfl");
    assert.equal(cb.canProceed("nfl"), false);
    cb.recordSuccess("nfl");
    assert.equal(cb.canProceed("nfl"), true);
    cb.recordFailure("nfl");
    assert.equal(cb.canProceed("nfl"), true, "count restarted after success");
  });

  it("allows a half-open probe after the cooldown elapses", () => {
    let clock = 1_000_000;
    const cb = new CircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 60_000,
      now: () => clock,
    });
    cb.recordFailure("nfl");
    assert.equal(cb.canProceed("nfl"), false);
    clock += 59_999;
    assert.equal(cb.canProceed("nfl"), false);
    clock += 1;
    assert.equal(cb.canProceed("nfl"), true, "half-open after cooldown");
  });

  it("a failed half-open probe re-opens for another full cooldown", () => {
    let clock = 1_000_000;
    const cb = new CircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 60_000,
      now: () => clock,
    });
    cb.recordFailure("nfl");
    clock += 60_000;
    assert.equal(cb.canProceed("nfl"), true);
    cb.recordFailure("nfl"); // probe failed
    clock += 30_000;
    assert.equal(cb.canProceed("nfl"), false, "re-opened from the probe failure");
  });

  it("reset() clears all state", () => {
    const cb = new CircuitBreaker({ failureThreshold: 1 });
    cb.recordFailure("nfl");
    cb.reset();
    assert.equal(cb.canProceed("nfl"), true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/circuit-breaker.test.mjs`
Expected: FAIL — `dist/circuit-breaker.js` does not exist (ERR_MODULE_NOT_FOUND).

- [ ] **Step 3: Write the implementation**

Create `src/circuit-breaker.ts`:

```typescript
/**
 * sportsclaw Engine — Circuit Breaker
 *
 * Keyed failure tracker for external data sources. After a threshold of
 * consecutive failures for a key, calls fail fast until a cooldown elapses;
 * then a single half-open probe is allowed. A success closes the circuit,
 * a failed probe re-opens it for another full cooldown.
 *
 * Pure in-memory state with an injectable clock — no I/O, fully unit-testable.
 */

export interface CircuitBreakerOptions {
  /** Consecutive failures before the circuit opens (default: 5) */
  failureThreshold?: number;
  /** How long an open circuit fails fast before allowing a probe (default: 60s) */
  cooldownMs?: number;
  /** Clock override for tests (default: Date.now) */
  now?: () => number;
}

interface BreakerEntry {
  consecutiveFailures: number;
  openedAt: number | null;
}

export class CircuitBreaker {
  private entries = new Map<string, BreakerEntry>();
  private failureThreshold: number;
  private cooldownMs: number;
  private now: () => number;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 5;
    this.cooldownMs = options.cooldownMs ?? 60_000;
    this.now = options.now ?? Date.now;
  }

  private entry(key: string): BreakerEntry {
    let e = this.entries.get(key);
    if (!e) {
      e = { consecutiveFailures: 0, openedAt: null };
      this.entries.set(key, e);
    }
    return e;
  }

  /** True if calls for this key may proceed (closed, or cooldown elapsed → half-open). */
  canProceed(key: string): boolean {
    const e = this.entry(key);
    if (e.openedAt === null) return true;
    return this.now() - e.openedAt >= this.cooldownMs;
  }

  recordSuccess(key: string): void {
    const e = this.entry(key);
    e.consecutiveFailures = 0;
    e.openedAt = null;
  }

  recordFailure(key: string): void {
    const e = this.entry(key);
    e.consecutiveFailures++;
    if (e.consecutiveFailures >= this.failureThreshold) {
      e.openedAt = this.now();
    }
  }

  /** Clear all breaker state (used by tests). */
  reset(): void {
    this.entries.clear();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test test/circuit-breaker.test.mjs`
Expected: PASS (7 tests).

- [ ] **Step 5: Add package.json script and commit**

```json
"test:circuit-breaker": "npm run build && node --test test/circuit-breaker.test.mjs",
```

```bash
git add src/circuit-breaker.ts test/circuit-breaker.test.mjs package.json
git commit -m "feat(bridge): keyed circuit breaker with injectable clock

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Wire retry policy + breaker into `executePythonBridge`

**Files:**
- Modify: `src/tools.ts:954-1055` (`executePythonBridge`)
- Create: `test/fixtures/flaky-bridge.sh`
- Test: `test/bridge-resilience.test.mjs`
- Modify: `package.json` (add script)

- [ ] **Step 1: Create the stub bridge fixture**

Create `test/fixtures/flaky-bridge.sh`:

```sh
#!/bin/sh
# Stand-in for `python3 -m sports_skills ...` used by bridge resilience tests.
# Counts invocations in $FLAKY_STATE. Fails with $FLAKY_ERROR on stderr until
# $FLAKY_FAILURES invocations have happened, then prints JSON on stdout.
COUNT=0
[ -f "$FLAKY_STATE" ] && COUNT=$(cat "$FLAKY_STATE")
COUNT=$((COUNT + 1))
echo "$COUNT" > "$FLAKY_STATE"
if [ "$COUNT" -le "$FLAKY_FAILURES" ]; then
  echo "${FLAKY_ERROR:-getaddrinfo ENOTFOUND fake.example}" >&2
  exit 1
fi
echo "{\"ok\": true, \"attempt\": $COUNT}"
```

Run: `chmod +x test/fixtures/flaky-bridge.sh`

- [ ] **Step 2: Write the failing test**

Create `test/bridge-resilience.test.mjs`:

```js
/**
 * executePythonBridge — retry + circuit breaker integration.
 *
 * Uses test/fixtures/flaky-bridge.sh as a stand-in for the Python
 * interpreter (config.pythonPath accepts any executable). The fixture
 * fails FLAKY_FAILURES times then succeeds, counting attempts in a
 * state file so tests can assert exactly how many attempts happened.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { executePythonBridge, bridgeBreaker } from "../dist/tools.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "flaky-bridge.sh");

let stateDir;

function bridgeConfig(failures, extraEnv = {}) {
  return {
    pythonPath: FIXTURE,
    timeout: 5_000,
    env: {
      FLAKY_STATE: join(stateDir, "count"),
      FLAKY_FAILURES: String(failures),
      ...extraEnv,
    },
  };
}

function attempts() {
  return Number(readFileSync(join(stateDir, "count"), "utf-8").trim());
}

describe("executePythonBridge resilience", () => {
  beforeEach(() => {
    chmodSync(FIXTURE, 0o755);
    stateDir = mkdtempSync(join(tmpdir(), "sc-bridge-"));
    bridgeBreaker.reset();
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    bridgeBreaker.reset();
  });

  it("retries transient network errors and succeeds", async () => {
    const result = await executePythonBridge("nfl", "scores", undefined, bridgeConfig(2));
    assert.equal(result.success, true);
    assert.equal(attempts(), 3, "two failures + one success");
  });

  it("does not retry deterministic dependency failures", async () => {
    const result = await executePythonBridge("nfl", "scores", undefined, bridgeConfig(99, {
      FLAKY_ERROR: "ModuleNotFoundError: No module named 'sports_skills'",
    }));
    assert.equal(result.success, false);
    assert.equal(attempts(), 1, "no retry for missing dependency");
  });

  it("gives up after exhausting transient retries", async () => {
    const result = await executePythonBridge("nfl", "scores", undefined, bridgeConfig(99));
    assert.equal(result.success, false);
    assert.equal(attempts(), 3, "initial attempt + two network retries");
  });

  it("opens the circuit after repeated failing calls and fails fast", async () => {
    const cfg = bridgeConfig(9999, {
      FLAKY_ERROR: "ModuleNotFoundError: No module named 'sports_skills'",
    });
    // Default threshold is 5 consecutive failed calls.
    for (let i = 0; i < 5; i++) {
      await executePythonBridge("nfl", "scores", undefined, cfg);
    }
    const before = attempts();
    const result = await executePythonBridge("nfl", "scores", undefined, cfg);
    assert.equal(result.success, false);
    assert.match(result.error ?? "", /circuit breaker open/i);
    assert.equal(attempts(), before, "subprocess was not spawned while open");
    // Other sports are unaffected.
    const other = await executePythonBridge("nba", "scores", undefined, cfg);
    assert.equal(other.success, false);
    assert.doesNotMatch(other.error ?? "", /circuit breaker open/i);
  });

  it("a success closes the circuit again", async () => {
    const cfg = bridgeConfig(5, {
      FLAKY_ERROR: "ModuleNotFoundError: No module named 'sports_skills'",
    });
    for (let i = 0; i < 5; i++) {
      await executePythonBridge("nfl", "scores", undefined, cfg);
    }
    assert.equal(bridgeBreaker.canProceed("nfl"), false);
    // Simulate cooldown elapsing by resetting (clock injection is unit-tested
    // in circuit-breaker.test.mjs; here we only verify the success path closes).
    bridgeBreaker.recordSuccess("nfl");
    const result = await executePythonBridge("nfl", "scores", undefined, cfg);
    assert.equal(result.success, true, "6th invocation exceeds FLAKY_FAILURES=5");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm run build && node --test test/bridge-resilience.test.mjs`
Expected: FAIL — `bridgeBreaker` is not exported from `dist/tools.js`. (The first test may incidentally pass — the legacy single-retry covers 2 failures; the import error fails the suite regardless.)

- [ ] **Step 4: Write the implementation**

In `src/tools.ts`:

Add the import at the top (after the existing local imports, ~line 22):

```typescript
import { CircuitBreaker } from "./circuit-breaker.js";
```

Add the shared breaker right above `executePythonBridge` (~line 949). Module-level on purpose: a failing provider is failing for every engine instance in the process, so the breaker state should be shared:

```typescript
/**
 * Shared per-sport circuit breaker for the Python bridge. Module-level by
 * design: a data source that is down is down for every engine instance in
 * this process, so they should all fail fast together.
 */
export const bridgeBreaker = new CircuitBreaker();
```

Replace the entire trailing async IIFE of `executePythonBridge` (the block starting `return (async () => {` at line 1020 through the closing `})();` at line 1054) with:

```typescript
  return (async () => {
    if (!bridgeBreaker.canProceed(sport)) {
      return {
        success: false,
        error:
          `circuit breaker open for "${sport}": repeated failures reaching the data source. ` +
          `Cooling down before new attempts.`,
      };
    }

    let attempt = 0;
    let lastResult = await runOnce(timeout);
    while (!lastResult.success) {
      const { errorCode } = classifyBridgeError(lastResult.error, lastResult.stderr);
      const plan = resolveRetryPlan(errorCode, attempt);
      if (!plan.retry) break;
      if (plan.delayMs > 0) {
        await new Promise((r) => setTimeout(r, plan.delayMs));
      }
      attempt++;
      // Timeouts get a widened window on retry; other errors keep the original.
      const nextTimeout = errorCode === "timeout" ? retryTimeout : timeout;
      if (config?.verbose) {
        console.error(
          `[sportsclaw] bridge retry attempt=${attempt} code=${errorCode} timeout=${nextTimeout}ms`
        );
      }
      lastResult = await runOnce(nextTimeout);
    }

    if (lastResult.success) {
      bridgeBreaker.recordSuccess(sport);
    } else {
      bridgeBreaker.recordFailure(sport);
    }
    return lastResult;
  })();
```

Note: this drops the old behavior of merging first/second error messages on double timeout — the surviving error already says "timed out", and the verbose retry log preserves the trail.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run build && node --test test/bridge-resilience.test.mjs test/bridge-retry-plan.test.mjs test/circuit-breaker.test.mjs`
Expected: PASS. (The transient-retry tests sleep ~1.5–2s for backoff — that's expected.)

- [ ] **Step 6: Run the existing smoke test for regressions**

Run: `npm run test:tool-call-part-guard && npm run test:guardrails`
Expected: PASS (no behavior change for non-bridge paths).

- [ ] **Step 7: Add package.json script and commit**

```json
"test:bridge-resilience": "npm run build && node --test test/bridge-resilience.test.mjs",
```

```bash
git add src/tools.ts test/fixtures/flaky-bridge.sh test/bridge-resilience.test.mjs package.json
git commit -m "feat(bridge): wire retry policy and per-sport circuit breaker into executePythonBridge

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: `SessionStore` disk persistence

**Files:**
- Modify: `src/engine.ts:227-302` (SessionStore), `src/engine.ts:3085` (restore site), `src/engine.ts:3508` and `src/engine.ts:3844` (save sites)
- Test: `test/session-store.test.mjs`
- Modify: `package.json` (add script)

Sessions currently live in an in-memory Map (`src/engine.ts:240-302`) and vanish on restart — fatal for the Discord/Telegram listeners. Design: keep the synchronous in-memory Map as the hot path; add a persist directory (default `~/.sportsclaw/sessions`, `null` disables). `save()` becomes async and writes JSON atomically (temp file + rename). New async `load()` falls back to disk on memory miss, honoring TTL. Engine call sites `await` both.

- [ ] **Step 1: Write the failing test**

Create `test/session-store.test.mjs`:

```js
/**
 * SessionStore disk persistence — sessions must survive a process restart
 * (simulated here by constructing a second store over the same directory),
 * honor TTL on load, and treat corrupt files as empty sessions.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionStore } from "../dist/engine.js";

const MESSAGES = [
  { role: "user", content: "who won the lakers game?" },
  { role: "assistant", content: [{ type: "text", text: "Lakers won 112-104." }] },
];

let dir;

describe("SessionStore persistence", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sc-sessions-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips a session across store instances", async () => {
    const a = new SessionStore(dir);
    await a.save("discord:123", MESSAGES);

    const b = new SessionStore(dir);
    const loaded = await b.load("discord:123");
    assert.deepEqual(loaded, MESSAGES);
  });

  it("load() prefers the in-memory copy", async () => {
    const store = new SessionStore(dir);
    await store.save("s1", MESSAGES);
    const loaded = await store.load("s1");
    assert.deepEqual(loaded, MESSAGES);
  });

  it("returns empty for unknown sessions", async () => {
    const store = new SessionStore(dir);
    assert.deepEqual(await store.load("nope"), []);
  });

  it("expired sessions on disk are dropped and their file deleted", async () => {
    const a = new SessionStore(dir);
    await a.save("old", MESSAGES);
    const file = readdirSync(dir).find((f) => f.endsWith(".json"));
    assert.ok(file, "session file written");
    // Rewrite with an updatedAt older than the 2h TTL.
    writeFileSync(
      join(dir, file),
      JSON.stringify({ messages: MESSAGES, updatedAt: Date.now() - 3 * 60 * 60 * 1000 }),
      "utf-8"
    );

    const b = new SessionStore(dir);
    assert.deepEqual(await b.load("old"), []);
    assert.equal(
      readdirSync(dir).filter((f) => f.endsWith(".json")).length, 0,
      "expired file removed"
    );
  });

  it("corrupt session files are treated as empty", async () => {
    const a = new SessionStore(dir);
    await a.save("bad", MESSAGES);
    const file = readdirSync(dir).find((f) => f.endsWith(".json"));
    writeFileSync(join(dir, file), "{not json", "utf-8");

    const b = new SessionStore(dir);
    assert.deepEqual(await b.load("bad"), []);
  });

  it("sanitizes hostile session ids into safe filenames", async () => {
    const store = new SessionStore(dir);
    await store.save("../../etc/passwd", MESSAGES);
    for (const f of readdirSync(dir)) {
      assert.ok(!f.includes(".."), `unsafe filename: ${f}`);
      assert.ok(!f.includes("/"), `unsafe filename: ${f}`);
    }
  });

  it("persistDir null disables disk persistence", async () => {
    const store = new SessionStore(null);
    await store.save("mem-only", MESSAGES);
    assert.deepEqual(store.get("mem-only"), MESSAGES);
    assert.equal(readdirSync(dir).length, 0, "nothing written to unrelated dir");
  });

  it("clear() removes the session file", async () => {
    const store = new SessionStore(dir);
    await store.save("gone", MESSAGES);
    store.clear("gone");
    // Unlink is fire-and-forget; give it a tick.
    await new Promise((r) => setTimeout(r, 50));
    const b = new SessionStore(dir);
    assert.deepEqual(await b.load("gone"), []);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/session-store.test.mjs`
Expected: FAIL — `new SessionStore(dir)` ignores the argument and `load` is not a function.

- [ ] **Step 3: Write the implementation**

In `src/engine.ts`, ensure these imports exist at the top of the file (add only what's missing — the file already imports from `node:fs`/`node:path` elsewhere; check first):

```typescript
import { mkdirSync } from "node:fs";
import { readFile as fsReadFile, writeFile as fsWriteFile, rename as fsRename, unlink as fsUnlink } from "node:fs/promises";
import { join as pathJoin } from "node:path";
import { homedir as osHomedir } from "node:os";
```

(If `engine.ts` already imports any of these names, reuse the existing binding instead of aliasing — match the file's existing import style.)

Replace the `SessionStore` class (`src/engine.ts:240-302`) with:

```typescript
export class SessionStore {
  private store = new Map<string, SessionEntry>();
  private persistDir: string | null;
  private dirReady = false;

  /**
   * @param persistDir Directory for on-disk session files. Defaults to
   * ~/.sportsclaw/sessions (overridable via SPORTSCLAW_SESSION_DIR).
   * Pass null to disable persistence (in-memory only).
   */
  constructor(persistDir?: string | null) {
    this.persistDir =
      persistDir === null
        ? null
        : persistDir ??
          process.env.SPORTSCLAW_SESSION_DIR ??
          pathJoin(osHomedir(), ".sportsclaw", "sessions");
  }

  private filePath(sessionId: string): string {
    const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 128);
    return pathJoin(this.persistDir!, `${safe}.json`);
  }

  /** Load message history from memory only. Returns empty array if not found or expired. */
  get(sessionId: string): Message[] {
    const entry = this.store.get(sessionId);
    if (!entry) return [];
    if (Date.now() - entry.updatedAt > SESSION_TTL_MS) {
      this.store.delete(sessionId);
      return [];
    }
    return entry.messages;
  }

  /**
   * Load message history, falling back to disk on memory miss so sessions
   * survive process restarts. Corrupt or expired files yield an empty session.
   */
  async load(sessionId: string): Promise<Message[]> {
    const inMemory = this.get(sessionId);
    if (inMemory.length > 0) return inMemory;
    if (!this.persistDir) return [];
    try {
      const raw = await fsReadFile(this.filePath(sessionId), "utf-8");
      const parsed = JSON.parse(raw) as SessionEntry;
      if (!parsed || !Array.isArray(parsed.messages) || typeof parsed.updatedAt !== "number") {
        return [];
      }
      if (Date.now() - parsed.updatedAt > SESSION_TTL_MS) {
        void fsUnlink(this.filePath(sessionId)).catch(() => {});
        return [];
      }
      this.store.set(sessionId, parsed);
      return parsed.messages;
    } catch {
      // Missing or corrupt file — start a fresh session.
      return [];
    }
  }

  /** Save message history for a session, trimming to keep within bounds. */
  async save(sessionId: string, messages: Message[]): Promise<void> {
    // Trim oldest messages if over limit (keep the most recent ones)
    const trimmed =
      messages.length > SESSION_MAX_MESSAGES
        ? messages.slice(messages.length - SESSION_MAX_MESSAGES)
        : messages;

    const entry: SessionEntry = { messages: trimmed, updatedAt: Date.now() };
    this.store.set(sessionId, entry);

    // Evict oldest sessions when over capacity
    if (this.store.size > SESSION_MAX_ENTRIES) {
      this.evict();
    }

    if (!this.persistDir) return;
    try {
      if (!this.dirReady) {
        mkdirSync(this.persistDir, { recursive: true });
        this.dirReady = true;
      }
      const path = this.filePath(sessionId);
      // Atomic write: temp file + rename so a crash mid-write never leaves
      // a torn session file. Random suffix avoids concurrent-save collisions.
      const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
      await fsWriteFile(tmp, JSON.stringify(entry), "utf-8");
      await fsRename(tmp, path);
    } catch (err) {
      // Persistence is best-effort; the in-memory session is already saved.
      console.error(
        `[sportsclaw] session persist error: ${err instanceof Error ? err.message : err}`
      );
    }
  }

  /** Clear a specific session (memory and disk). */
  clear(sessionId: string): boolean {
    const had = this.store.delete(sessionId);
    if (this.persistDir) {
      void fsUnlink(this.filePath(sessionId)).catch(() => {});
    }
    return had;
  }

  /** Number of active sessions. */
  get size(): number {
    return this.store.size;
  }

  /** Evict expired and oldest sessions to stay within capacity. */
  private evict(): void {
    const now = Date.now();
    // First pass: remove expired
    for (const [id, entry] of this.store) {
      if (now - entry.updatedAt > SESSION_TTL_MS) {
        this.store.delete(id);
      }
    }
    // Second pass: if still over limit, remove oldest
    while (this.store.size > SESSION_MAX_ENTRIES) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey) this.store.delete(oldestKey);
      else break;
    }
  }
}
```

Update the three call sites:

`src/engine.ts:3085` (session restore):

```typescript
      const prior = await sessionStore.load(sessionId);
```

`src/engine.ts:3508` (parallel-lane save):

```typescript
        await sessionStore.save(sessionId, this.messages);
```

`src/engine.ts:3844` (main save):

```typescript
      await sessionStore.save(sessionId, this.messages);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test test/session-store.test.mjs`
Expected: PASS (8 tests).

- [ ] **Step 5: Regression check**

Run: `npm run test:halt-guard && npm run test:guardrails`
Expected: PASS.

- [ ] **Step 6: Add package.json script and commit**

```json
"test:session-store": "npm run build && node --test test/session-store.test.mjs",
```

```bash
git add src/engine.ts test/session-store.test.mjs package.json
git commit -m "feat(sessions): persist sessions to disk so conversations survive restarts

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Atomic `FileMemoryStorage.write()`

**Files:**
- Modify: `src/memory.ts:123-185` (FileMemoryStorage)
- Test: `test/file-memory-atomic.test.mjs`
- Modify: `package.json` (add script)

`write()` (`src/memory.ts:149-152`) is truncate-then-write: a crash mid-write leaves a torn file (e.g., half a FAN_PROFILE.md). Fix with temp-file + rename. `append()` already uses `appendFile` (O_APPEND) and needs no change.

- [ ] **Step 1: Write the failing test**

Create `test/file-memory-atomic.test.mjs`:

```js
/**
 * FileMemoryStorage.write — atomic temp-file + rename semantics.
 * After any write completes, the target file must contain exactly one
 * complete payload (never a torn mix), and no temp files may linger.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FileMemoryStorage } from "../dist/memory.js";

let dir;

describe("FileMemoryStorage atomic write", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sc-memory-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips content", async () => {
    const storage = new FileMemoryStorage(dir);
    await storage.write("user1", "FAN_PROFILE.md", "# Fan\nteam: Lakers\n");
    assert.equal(await storage.read("user1", "FAN_PROFILE.md"), "# Fan\nteam: Lakers\n");
  });

  it("leaves no temp files behind", async () => {
    const storage = new FileMemoryStorage(dir);
    await storage.write("user1", "CONTEXT.md", "hello");
    const files = readdirSync(storage.getUserDir("user1"));
    assert.deepEqual(files, ["CONTEXT.md"]);
  });

  it("concurrent writes settle on one complete payload", async () => {
    const storage = new FileMemoryStorage(dir);
    const a = "A".repeat(64 * 1024);
    const b = "B".repeat(64 * 1024);
    await Promise.all([
      storage.write("user1", "STRATEGY.md", a),
      storage.write("user1", "STRATEGY.md", b),
    ]);
    const final = await storage.read("user1", "STRATEGY.md");
    assert.ok(
      final === a || final === b,
      "file must be exactly one of the two complete payloads, not a torn mix"
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/file-memory-atomic.test.mjs`
Expected: FAIL — `FileMemoryStorage` is not exported from `dist/memory.js`.

- [ ] **Step 3: Write the implementation**

In `src/memory.ts`:

1. Export the class — change `class FileMemoryStorage implements MemoryStorage {` (line 123) to:

```typescript
export class FileMemoryStorage implements MemoryStorage {
```

2. Add `rename` to the existing `node:fs/promises` import at the top of the file (it already imports `writeFile`, `appendFile`, `mkdir`, `readdir` — add `rename` to that list).

3. Replace `write()` (lines 149-152):

```typescript
  async write(userId: string, file: string, content: string): Promise<void> {
    const dir = await this.ensureDir(userId);
    const path = join(dir, file);
    // Atomic write: temp + rename so a crash mid-write never tears the file.
    const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    await writeFile(tmp, content, "utf-8");
    await rename(tmp, path);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test test/file-memory-atomic.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Regression check**

Run: `npm run test:pod-memory-append-race && npm run test:editorial-memory`
Expected: PASS.

- [ ] **Step 6: Add package.json script and commit**

```json
"test:file-memory-atomic": "npm run build && node --test test/file-memory-atomic.test.mjs",
```

```bash
git add src/memory.ts test/file-memory-atomic.test.mjs package.json
git commit -m "fix(memory): atomic temp+rename writes in FileMemoryStorage

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Token usage capture + analytics fields

**Files:**
- Modify: `src/analytics.ts:39-51` (QueryEvent), `src/analytics.ts:124-149` (buildQueryEvent)
- Modify: `src/engine.ts` (usage accumulation in both result paths + both buildQueryEvent call sites)
- Test: `test/analytics-tokens.test.mjs`
- Modify: `package.json` (add script)

The Vercel AI SDK (`ai@^6`) returns `totalUsage` (`{ inputTokens, outputTokens, totalTokens }`, cumulative across steps) on every `generateText` result; the engine currently discards it. Scope: capture usage from the main loop (single-lane and parallel-lane paths, including parallel synthesis), expose it via a getter, and record it in `QueryEvent`. Auxiliary calls (router, evidence gate) are intentionally out of scope for v1 — they are small and bounded.

- [ ] **Step 1: Write the failing test**

Create `test/analytics-tokens.test.mjs`:

```js
/**
 * buildQueryEvent — optional token usage fields. When the engine provides
 * usage, the event carries inputTokens/outputTokens; when absent, the
 * fields are simply omitted (no zeros, no NaN).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildQueryEvent } from "../dist/analytics.js";

const BASE = {
  userId: "user1",
  sessionId: "s1",
  promptLength: 24,
  detectedSports: ["nba"],
  toolsCalled: [{ name: "nba_scores", success: true, latencyMs: 800 }],
  totalLatencyMs: 4200,
  clarificationNeeded: false,
};

describe("buildQueryEvent token fields", () => {
  it("includes token counts when usage is provided", () => {
    const event = buildQueryEvent({
      ...BASE,
      usage: { inputTokens: 1200, outputTokens: 340 },
    });
    assert.equal(event.inputTokens, 1200);
    assert.equal(event.outputTokens, 340);
  });

  it("omits token fields when usage is absent", () => {
    const event = buildQueryEvent(BASE);
    assert.equal(event.inputTokens, undefined);
    assert.equal(event.outputTokens, undefined);
  });

  it("keeps all pre-existing fields intact", () => {
    const event = buildQueryEvent(BASE);
    assert.equal(event.sessionId, "s1");
    assert.deepEqual(event.toolsSucceeded, ["nba_scores"]);
    assert.equal(event.success, true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/analytics-tokens.test.mjs`
Expected: FAIL — first test: `event.inputTokens` is `undefined`, expected `1200`.

- [ ] **Step 3: Implement the analytics changes**

In `src/analytics.ts`, extend `QueryEvent` (lines 39-51) — add after `clarificationNeeded`:

```typescript
  inputTokens?: number;
  outputTokens?: number;
```

Extend `buildQueryEvent` params (lines 124-132) — add after `clarificationNeeded: boolean;`:

```typescript
  usage?: { inputTokens: number; outputTokens: number };
```

And in the returned object (after `clarificationNeeded: params.clarificationNeeded,`):

```typescript
    ...(params.usage
      ? { inputTokens: params.usage.inputTokens, outputTokens: params.usage.outputTokens }
      : {}),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test test/analytics-tokens.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Implement the engine wiring**

In `src/engine.ts`:

1. Add a module-level helper near the top of the file (after the imports, before the SessionStore section):

```typescript
/** Normalized token usage extracted from a generateText result. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

function usageOf(result: {
  totalUsage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
}): TokenUsage {
  const u = result.totalUsage ?? {};
  const input = u.inputTokens ?? 0;
  const output = u.outputTokens ?? 0;
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: u.totalTokens ?? input + output,
  };
}

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}
```

2. Add a private field and public getter on the engine class (next to the other private fields / getters such as `generatedImages`):

```typescript
  private _lastUsage: TokenUsage | null = null;

  /** Token usage of the most recent run() (main loop only). Null before first run. */
  get lastTokenUsage(): TokenUsage | null {
    return this._lastUsage;
  }
```

3. **Parallel-lane path** — immediately after `const laneResults = await Promise.all(lanePromises);` (`src/engine.ts:3453`):

```typescript
      this._lastUsage = laneResults
        .map(usageOf)
        .reduce(addUsage, { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
```

And inside the multi-agent synthesis `try` block, right after `const synthesisResult = await generateText({ ... });` (`src/engine.ts:3476-3484`), add:

```typescript
          this._lastUsage = addUsage(this._lastUsage!, usageOf(synthesisResult));
```

4. **Single-lane path** — after the recovery pass completes (immediately after the closing `}` of the `if (!result.text?.trim() && ...)` recovery block at `src/engine.ts:3689`, before the `for (const msg of result.response.messages)` loop):

```typescript
    this._lastUsage = usageOf(result);
    if (this.config.verbose) {
      console.error(
        `[sportsclaw] tokens input=${this._lastUsage.inputTokens} ` +
          `output=${this._lastUsage.outputTokens} total=${this._lastUsage.totalTokens}`
      );
    }
```

5. **Both `buildQueryEvent` call sites** (`src/engine.ts:3514` and `src/engine.ts:3855`) — add to the params object:

```typescript
            usage: this._lastUsage ?? undefined,
```

- [ ] **Step 6: Build and regression check**

Run: `npm run build && node --test test/analytics-tokens.test.mjs && npm run test:halt-guard`
Expected: PASS. (The engine wiring itself requires a live LLM; it is exercised by `test:ci-integration` in CI and verified here by compilation + the analytics unit tests.)

- [ ] **Step 7: Add package.json script and commit**

```json
"test:analytics-tokens": "npm run build && node --test test/analytics-tokens.test.mjs",
```

```bash
git add src/analytics.ts src/engine.ts test/analytics-tokens.test.mjs package.json
git commit -m "feat(analytics): capture LLM token usage per run and log it in query events

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Daily token ledger + budget gate

**Files:**
- Create: `src/token-ledger.ts`
- Modify: `src/types.ts:140-226` (config), `src/engine.ts` (gate + recording)
- Test: `test/token-ledger.test.mjs`
- Modify: `package.json` (add script)

Opt-in spend guardrail (the OpenClaw "$3,600 overnight burn" lesson). A tiny JSON ledger at `~/.sportsclaw/analytics/token-ledger.json` tallies tokens per UTC day. When `config.dailyTokenBudget > 0` and today's tally has reached it, `run()` throws a clear error before any LLM call. Default `0` = disabled — no behavior change for existing users.

- [ ] **Step 1: Write the failing test**

Create `test/token-ledger.test.mjs`:

```js
/**
 * token-ledger — per-UTC-day token tally on disk. Accounting must be
 * accumulative, corruption-tolerant, and never throw.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { recordTokens, tokensUsedToday } from "../dist/token-ledger.js";

let dir;
let ledger;

describe("token-ledger", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sc-ledger-"));
    ledger = join(dir, "token-ledger.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("starts at zero", () => {
    assert.equal(tokensUsedToday(ledger), 0);
  });

  it("accumulates across calls", () => {
    recordTokens(1000, ledger);
    recordTokens(500, ledger);
    assert.equal(tokensUsedToday(ledger), 1500);
  });

  it("ignores non-positive and non-finite values", () => {
    recordTokens(0, ledger);
    recordTokens(-50, ledger);
    recordTokens(NaN, ledger);
    assert.equal(tokensUsedToday(ledger), 0);
  });

  it("recovers from a corrupt ledger file", () => {
    writeFileSync(ledger, "{corrupt", "utf-8");
    assert.equal(tokensUsedToday(ledger), 0);
    recordTokens(200, ledger);
    assert.equal(tokensUsedToday(ledger), 200);
  });

  it("keys by UTC date", () => {
    recordTokens(100, ledger);
    const data = JSON.parse(readFileSync(ledger, "utf-8"));
    const today = new Date().toISOString().slice(0, 10);
    assert.equal(data[today], 100);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/token-ledger.test.mjs`
Expected: FAIL — `dist/token-ledger.js` does not exist (ERR_MODULE_NOT_FOUND).

- [ ] **Step 3: Write the implementation**

Create `src/token-ledger.ts`:

```typescript
/**
 * sportsclaw Engine — Daily Token Ledger
 *
 * Tiny on-disk tally of LLM tokens spent per UTC day, used by the optional
 * dailyTokenBudget guardrail. Accounting is best-effort and must never
 * break the main flow: all errors are swallowed.
 *
 * Note: the read-modify-write below is not cross-process atomic. Two
 * processes recording simultaneously can undercount slightly — acceptable
 * for a spend guardrail, not suitable for billing.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const DEFAULT_LEDGER = join(homedir(), ".sportsclaw", "analytics", "token-ledger.json");

type LedgerShape = Record<string, number>;

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function readLedger(ledgerPath: string): LedgerShape {
  try {
    if (!existsSync(ledgerPath)) return {};
    const parsed = JSON.parse(readFileSync(ledgerPath, "utf-8"));
    return parsed && typeof parsed === "object" ? (parsed as LedgerShape) : {};
  } catch {
    return {};
  }
}

/** Add tokens to today's tally. Non-positive or non-finite values are ignored. */
export function recordTokens(tokens: number, ledgerPath: string = DEFAULT_LEDGER): void {
  if (!Number.isFinite(tokens) || tokens <= 0) return;
  try {
    mkdirSync(dirname(ledgerPath), { recursive: true });
    const ledger = readLedger(ledgerPath);
    const key = todayKey();
    ledger[key] = (ledger[key] ?? 0) + tokens;
    // Atomic write: temp + rename so a crash never corrupts the ledger.
    const tmp = `${ledgerPath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(ledger), "utf-8");
    renameSync(tmp, ledgerPath);
  } catch {
    // Accounting must never break the main flow.
  }
}

/** Tokens recorded so far for the current UTC day. */
export function tokensUsedToday(ledgerPath: string = DEFAULT_LEDGER): number {
  const value = readLedger(ledgerPath)[todayKey()];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test test/token-ledger.test.mjs`
Expected: PASS (5 tests).

- [ ] **Step 5: Add the config field**

In `src/types.ts`, add to `sportsclawConfig` (after `contextPruneThreshold`, line 199):

```typescript
  /**
   * Daily LLM token budget (input + output, UTC day). When today's recorded
   * usage reaches this value, run() throws before making any LLM call.
   * 0 disables the gate. Default: 0.
   */
  dailyTokenBudget?: number;
```

And to `DEFAULT_CONFIG` (after `contextPruneThreshold: 80,`, line 225):

```typescript
  dailyTokenBudget: 0,
```

- [ ] **Step 6: Wire the gate and recording into the engine**

In `src/engine.ts`:

1. Add the import (with the other local imports at the top):

```typescript
import { recordTokens, tokensUsedToday } from "./token-ledger.js";
```

2. Add the gate immediately after the guide-intercept block (after the closing `}` at `src/engine.ts:3080`, before the `// --- Session: restore prior conversation history ---` comment):

```typescript
    // --- Spend guardrail: refuse to start a run once the daily budget is hit ---
    if (this.config.dailyTokenBudget > 0) {
      const used = tokensUsedToday();
      if (used >= this.config.dailyTokenBudget) {
        throw new Error(
          `Daily token budget exhausted (${used}/${this.config.dailyTokenBudget} tokens used today, UTC). ` +
            `Raise dailyTokenBudget in config or wait until tomorrow.`
        );
      }
    }
```

3. Record usage at both points where `this._lastUsage` is set (from Task 6):

In the **single-lane path**, extend the block added in Task 6 step 5.4 so it reads:

```typescript
    this._lastUsage = usageOf(result);
    recordTokens(this._lastUsage.totalTokens);
    if (this.config.verbose) {
      console.error(
        `[sportsclaw] tokens input=${this._lastUsage.inputTokens} ` +
          `output=${this._lastUsage.outputTokens} total=${this._lastUsage.totalTokens}`
      );
    }
```

In the **parallel-lane path**, after the lane-usage reduce added in Task 6 step 5.3, the synthesis may add more usage — so record once, just before `return responseText;` (`src/engine.ts:3529`):

```typescript
      recordTokens(this._lastUsage?.totalTokens ?? 0);
```

- [ ] **Step 7: Build and full regression check**

Run: `npm run build && node --test test/token-ledger.test.mjs test/analytics-tokens.test.mjs test/session-store.test.mjs test/file-memory-atomic.test.mjs test/bridge-retry-plan.test.mjs test/circuit-breaker.test.mjs test/bridge-resilience.test.mjs`
Expected: ALL PASS.

Then: `npm run test:halt-guard && npm run test:guardrails && npm run test:tool-call-part-guard`
Expected: PASS.

- [ ] **Step 8: Add package.json script and commit**

```json
"test:token-ledger": "npm run build && node --test test/token-ledger.test.mjs",
```

```bash
git add src/token-ledger.ts src/types.ts src/engine.ts test/token-ledger.test.mjs package.json
git commit -m "feat(engine): daily token ledger and opt-in dailyTokenBudget spend gate

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Out of Scope (deliberately deferred)

- **Token-based context pruning** (replacing the message-count heuristic at `engine.ts:3205-3216`): needs per-model context-window metadata; the reactive token-overflow trim plus the new usage telemetry should inform thresholds first.
- **Python subprocess pooling / daemon mode**: significant latency win but a separate design effort; the breaker makes failure modes safe in the meantime.
- **Hermes-style SQLite sessions with FTS5 search**: the disk-persisted SessionStore fixes the actual P1 risk (restart loss); SQLite is a later migration if cross-channel session search is wanted.
- **Auxiliary-call usage** (router, evidence gate, recovery pass) in the token tally: small, bounded, and would complicate the wiring; noted for v2.

## Self-Review Notes

- Spec coverage: P0 = Tasks 1-3; P1 = Tasks 4-5; P2 = Tasks 6-7. ✓
- Type consistency: `RetryPlan`, `CircuitBreaker`, `TokenUsage`, `usage` param shapes match across tasks. `bridgeBreaker` (Task 3) is the `CircuitBreaker` from Task 2. Task 7 extends the exact block Task 6 introduces — Task 7 must run after Task 6. ✓
- Line numbers reference the file state at plan-writing time (v0.26.2, commit 43731ed); executors should re-locate anchors by the quoted surrounding code if lines have drifted.
