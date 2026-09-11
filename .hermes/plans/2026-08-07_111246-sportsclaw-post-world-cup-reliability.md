# SportsClaw Post-World-Cup Reliability and Coverage Update Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Restore green `main`, ship a reliable post-World-Cup release, make the World Cup MCP optional rather than a product dependency, report sports coverage accurately, and certify the seven-sport momentum pipeline with real evidence.

**Architecture:** Preserve the TypeScript/ESM SportsClaw engine and the `sports-skills` Python bridge. Reuse the existing MCP, health, selftest, catalog, operator, and momentum systems. Keep the World Cup hosted service intact, but remove it from the local default runtime after dependency checks. Add only the smallest catalog and certification surfaces needed to prevent misleading coverage claims.

**Tech stack:** Node.js, TypeScript, ESM, `node:test`, `sports-skills`, GitHub Actions, Azure Foundry.

---

## Scope contract

Change SportsClaw from a post-tournament runtime with red CI, incomplete configuration, and ambiguous coverage reporting into a green, configurable, accurately categorized, and evidence-certified release.

### In scope

1. Restore green CI.
2. Land PRs #137, #136, and #138 in dependency order.
3. Add deterministic regression coverage to PR #138 before merging it.
4. Repair the local Azure Foundry configuration through the existing config path.
5. Disconnect only the local `world-cup-mcp` registration after proving no active operator depends on it.
6. Distinguish default sports, optional sports, default support modules, and optional support modules.
7. Add a seven-sport momentum certification record that distinguishes live and synthetic proof.
8. Release v0.29.2 only after the complete release gate passes.

### Out of scope

- New sports.
- UI redesign.
- Generic refactors.
- Hindsight PR #101.
- Hosted World Cup workflow edits.
- Hosted pod deletion or teardown.
- Credential rotation.
- Automatically starting stopped operator jobs.
- Dependency modernization that is unrelated to a failing release gate.

### Default decisions

- Merge order: **#137, then #136, then #138**.
- World Cup: keep the hosted service intact; disconnect only the local registration.
- Coverage message: **14 default sports, 1 optional sport, 6 default support modules, 1 optional support module** when all 22 current schemas are installed.
- Release framing: **v0.29.2 is a reliability release, not a feature expansion**.
- Incomplete live certification is allowed if it is labeled honestly. Fabricated evidence is not.

---

## Verified baseline

- Latest release: `v0.29.1`, released 2026-07-07.
- Current `origin/main`: `b00a84f`, merged 2026-07-25.
- Main CI: 948/949, with one stale OpenShell policy assertion.
- PR #137: clean, 949/949, intended to unblock CI.
- PR #136: fail-closed momentum hardening and LLM timeouts.
- PR #138: forced-output operator salvage, currently missing regression coverage.
- PR #101: older Hindsight memory work, excluded from this release.
- Local runtime: v0.29.1, status `down` because `AZURE_FOUNDRY_BASE_URL` is absent.
- Installed locally: 22 schemas and 263 tools.
- Operators: `paper-trader` and `tv-operator` stopped.
- World Cup MCP: online with 19 tools.
- Current momentum live proof: MLB and WNBA.
- Current synthetic proof: NFL, NBA, NHL, CFB, and CBB. NHL proves the rejection path, not an accepted explanation.

---

## Seven-sport certification baseline

| Sport | Current evidence | Current outcome | Required next proof |
|---|---|---|---|
| MLB | Live, as reported by PR #135 | Accepted explanation | Recover and record the original receipt; rerun only if the receipt is incomplete |
| WNBA | Live, ESPN event `401857073` | Accepted explanation plus one correctly held hallucinated card | Preserve the receipt and evaluator outcomes |
| NFL | Synthetic | Accepted explanation | Live replay with a real ESPN event and resolved market |
| NBA | Synthetic | Accepted explanation | Live replay with a real ESPN event and resolved market |
| NHL | Synthetic | Rejection path only | Live replay that exercises an accepted explanation path |
| CFB | Synthetic | Accepted explanation | Live replay with a real ESPN event and resolved market |
| CBB | Synthetic | Accepted explanation | Live replay with a real ESPN event and resolved market |

A sport must not be marked live-certified without a timestamp, ESPN event ID, market-resolution result, output verdict, evaluator verdict, and evidence source.

---

## Task 0: Establish a clean baseline

**Objective:** Reproduce the known failure from a clean `origin/main` worktree and ensure there are no hidden blockers.

**Actions:**

1. Do not use the current divergent local branch for integration.
2. Create a clean worktree from `origin/main` for release work.
3. Capture branch, commit, worktree status, Node version, Python version, and package version.
4. Run the exact CI build and test commands.
5. Confirm the only failure is the stale OpenShell policy assertion.

**Commands:**

```bash
git fetch --all --prune
git worktree add ../sportsclaw-v0292 origin/main
cd ../sportsclaw-v0292
git status --short --branch
git log -1 --oneline
npm ci
npm run build
node --test test/*.test.mjs
```

**Expected:** Build succeeds. Tests report 948 passing and one failure in `test/openshell-policies.test.mjs`.

**Stop condition:** Any additional failure. Do not absorb unrelated defects into this release.

**Commit:** None.

---

## Task 1: Review and merge PR #137

**Objective:** Restore green `main` before stacking reliability work.

**Files expected:**

- Modify: `test/openshell-policies.test.mjs`
- No production code changes expected.

**Actions:**

1. Review the PR diff against the already-shipped OpenShell policy.
2. Confirm the updated assertions explicitly preserve the loopback-only vault routes and the read-only ESPN host allowlist.
3. Run the full suite in an isolated PR worktree.
4. Confirm GitHub CI is 949/949.
5. After execution approval, merge using the repository's standard merge strategy.
6. Re-run CI on `main` before continuing.

**Commands:**

```bash
gh pr view 137 --json title,body,files,statusCheckRollup
npm ci
npm run build
node --test test/openshell-policies.test.mjs
node --test test/*.test.mjs
```

**Expected:** 949/949 locally and in GitHub Actions.

**Acceptance gate:** `main` is green. Tasks 2 and 3 remain blocked until this is true.

---

## Task 2: Rebase, review, and merge PR #136

**Objective:** Ensure every momentum generation or evaluator failure retries within bounds and ultimately fails closed into a visible held result.

**Files expected:**

- Modify: `src/intelligence/momentum-explainer.ts`
- Modify: `src/intelligence/momentum-evaluator.ts`
- Modify: `src/intelligence/momentum-live.ts`
- Modify: `src/intelligence/momentum-replay.ts`
- Create or modify: `src/intelligence/momentum-runtime.ts`
- Modify: `test/momentum-explainer.test.mjs`
- Modify: `test/momentum-evaluator.test.mjs`
- Modify: `test/momentum-replay.test.mjs`

**TDD sequence:**

1. Assert a thrown generator call consumes the bounded retry budget and ends in `onRejected`.
2. Assert an evaluator timeout is held, not emitted and not silently dropped.
3. Assert a bridge envelope with `status: false` is rejected.
4. Assert an empty-book `0c` tick cannot create a momentum swing.
5. Assert a genuine `1c` price still can create a swing.
6. Run the tests before applying the PR to prove the regression exists.
7. Apply or rebase the PR and prove the tests pass.

**Commands:**

```bash
npm run build
node --test test/momentum-explainer.test.mjs \
  test/momentum-evaluator.test.mjs \
  test/momentum-replay.test.mjs
node --test test/*.test.mjs
```

**Expected:** The targeted momentum suite and the full suite pass on the rebased branch and again on `main` after merge.

**Acceptance gate:** No known generator, evaluator, timeout, or bridge-error path can bypass a tested held/rejected outcome.

**Commit if tests are added:** `test(momentum): cover fail-closed error paths`

---

## Task 3: Add deterministic regression tests to PR #138, then merge

**Objective:** Pin the forced-output salvage behavior before shipping it.

**Files expected:**

- Modify: `src/operator-daemon.ts`
- Modify: `test/operator-daemon.test.mjs`
- Possibly modify: `test/operator-sink.test.mjs` if the output sink contract is involved.

**TDD sequence:**

1. Stub the initial streamed generation so it ends without calling `OUTPUT_TOOL_NAME`.
2. Assert the daemon makes exactly one salvage call.
3. Assert the salvage call uses forced `toolChoice` for `OUTPUT_TOOL_NAME`.
4. Assert a substantive salvaged answer publishes successfully.
5. Assert an idle or empty salvaged answer fails closed.
6. Assert an initial response that already called the output tool does not trigger salvage.
7. Assert the salvage path never retries more than once.
8. Run the targeted test five times to prove determinism.

**Commands:**

```bash
npm run build
node --test test/operator-daemon.test.mjs
for i in 1 2 3 4 5; do node --test test/operator-daemon.test.mjs || exit 1; done
node --test test/*.test.mjs
```

**Expected:** Identical green results across all five targeted runs and a green full suite.

**Acceptance gate:** PR #138 does not merge without deterministic coverage for the missing-output-tool case.

**Commit:** `test(operator): cover forced-output salvage`

---

## Task 4: Repair Azure Foundry configuration without leaking secrets

**Objective:** Move local health from `down` to `healthy` using the existing configuration path.

**Primary paths:**

- Existing config logic: `src/config.ts`
- Health and doctor: `src/index.ts`
- Provider resolution: `src/llm-providers.ts`
- Tests: `test/cli-health.test.mjs`, `test/llm-providers.test.mjs`

**Actions:**

1. Run `sportsclaw config` and use the existing Foundry setup flow.
2. The user enters any secret directly. The agent must never type, print, log, or paste a key.
3. Confirm non-secret Foundry settings are read from `~/.sportsclaw/.env` as designed.
4. Run doctor, health, offline selftest, then one representative live metadata selftest.
5. Capture output to temporary files and verify no secret value or credentialed URL is present.
6. Change code only if a real config-resolution or redaction defect is reproduced.

**Commands:**

```bash
sportsclaw config
sportsclaw doctor
sportsclaw health --json
sportsclaw selftest --quick --json
sportsclaw selftest --live --sport metadata --json
```

**Expected:** `health --json` reports `healthy`. Doctor reports the provider configured. Both selftests return valid JSON and pass their intended checks.

**Acceptance gate:** Healthy runtime, successful representative live call, and no secret leakage.

**Potential commit only if code changes are necessary:** `fix(config): align Foundry health with saved configuration`

---

## Task 5: Demote the World Cup MCP to an optional integration

**Objective:** Remove the expired tournament integration from the local default runtime without touching the hosted service.

**Paths and state:**

- Local metadata: `~/.sportsclaw/mcp.json`
- Local tokens: `~/.sportsclaw/.env`, read only, never copied into the backup artifact
- Operator configs: `~/.sportsclaw/operator/`
- MCP implementation: `src/mcp.ts`, `src/index.ts`
- Docs: `docs/advanced/mcp.md`, `docs/sports-data/machina.md`
- Tests: `test/cli-health.test.mjs`, `test/mcp-helpers.test.mjs`

**Actions:**

1. Copy `~/.sportsclaw/mcp.json` to a timestamped file under `~/.sportsclaw/backups/`.
2. Save a redacted `sportsclaw health --json` snapshot alongside it.
3. Use `search_files` to check operator configs, watcher state, and task state for `world-cup` references.
4. If any active dependency exists, stop and report it.
5. Remove only the local registration with `sportsclaw mcp remove world-cup-mcp`.
6. Do not delete the hosted pod, workflow, connector, or service.
7. Prove SportsClaw starts, lists schemas, passes selftest, and reports healthy with zero optional MCPs.
8. Add documentation or tests only if the generic optional-MCP behavior is not already covered.

**Commands:**

```bash
mkdir -p ~/.sportsclaw/backups
cp ~/.sportsclaw/mcp.json ~/.sportsclaw/backups/mcp-$(date +%Y%m%dT%H%M%S).json
sportsclaw health --json > ~/.sportsclaw/backups/health-$(date +%Y%m%dT%H%M%S).json
sportsclaw mcp remove world-cup-mcp
sportsclaw mcp list
sportsclaw list
sportsclaw selftest --quick --json
sportsclaw health --json
```

**Expected:** The local MCP list no longer contains `world-cup-mcp`; the hosted service remains untouched; health and selftest remain green.

**Rollback:** Restore the metadata entry from the timestamped backup or re-register the same endpoint using `sportsclaw mcp add`. Never expose or duplicate its token.

**Potential commit:** `docs(mcp): mark World Cup integration as on-demand`

---

## Task 6: Normalize catalog categories and reporting

**Objective:** Stop conflating installed schemas with sports.

**Canonical category model:**

- 14 default sports.
- 1 optional sport: esports.
- 6 default support modules.
- 1 optional support module: Polymarket trading.
- Current full installation: 22 schemas and 263 tools.

**Files:**

- Modify: `src/schema.ts`
- Modify: `src/index.ts`
- Modify: `docs/sports-data/coverage.md`
- Modify: `README.md`
- Create: `test/schema-catalog.test.mjs`
- Possibly modify: `test/version-help.test.mjs`

**TDD sequence:**

1. Add failing tests for exactly 14 default sports.
2. Add failing tests that classify esports as an optional sport.
3. Add failing tests for six default support modules and one optional support module.
4. Add a failing invariant that every installed schema belongs to one category or is reported as unknown.
5. Add a failing test that the current full installation summarizes to 15 sports, 7 support modules, 22 schemas, and 263 tools.
6. Split the current constants in `src/schema.ts` into category-aware arrays while preserving `DEFAULT_SKILLS` compatibility.
7. Add a pure `summarizeInstalledSchemas()` helper.
8. Update `sportsclaw list` and `sportsclaw list --json` to use the summary.
9. Update CLI help, coverage docs, and README to match.

**Commands:**

```bash
npm run build
node --test test/schema-catalog.test.mjs test/version-help.test.mjs
node dist/index.js list
node dist/index.js list --json
node --test test/*.test.mjs
```

**Expected:** Human and JSON output distinguish sports, support modules, optional modules, schema count, and tool count. No surface claims "22 sports."

**Acceptance gate:** `src/schema.ts`, CLI output, `docs/sports-data/coverage.md`, and README agree exactly.

**Commit:** `feat(catalog): separate sports and support modules`

---

## Task 7: Add a durable seven-sport certification artifact

**Objective:** Make the live-versus-synthetic evidence status machine-checkable and human-readable.

**Files:**

- Create: `docs/sports-data/momentum-certification.json`
- Create: `docs/sports-data/momentum-certification.md`
- Create: `test/momentum-certification.test.mjs`
- Link from: `demo/vault_data/README.md`

**JSON fields per sport:**

```json
{
  "sport": "wnba",
  "evidenceType": "live",
  "verifiedAt": "ISO-8601 timestamp",
  "espnEventId": "401857073",
  "marketResolution": "recorded result",
  "outputVerdict": "accepted or held",
  "evaluatorVerdict": "recorded result",
  "latencyMs": null,
  "fixturePath": null,
  "pendingLive": false,
  "notes": "receipt source"
}
```

**TDD sequence:**

1. Assert the manifest contains exactly NFL, MLB, NBA, NHL, WNBA, CFB, and CBB.
2. Assert a `live` row requires `verifiedAt`, `espnEventId`, market resolution, output verdict, evaluator verdict, and a receipt source.
3. Assert a `synthetic` row requires a fixture path and `pendingLive: true`.
4. Assert NHL remains `synthetic`, `pendingLive: true`, with a rejection-path note until a live accepted-path receipt exists.
5. Recover existing MLB and WNBA receipts from PR evidence or run logs. If a required receipt field is missing, mark it pending receipt rather than inventing it.
6. Generate or manually maintain the Markdown table from the JSON source and cross-link the existing fixture README.

**Commands:**

```bash
node --test test/momentum-certification.test.mjs
node --test test/momentum-replay.test.mjs
node --test test/*.test.mjs
```

**Expected:** Seven honest rows, with live and synthetic evidence clearly separated.

**Acceptance gate:** No live row without a complete evidence receipt.

**Commit:** `docs(sports-data): add momentum certification matrix`

---

## Task 8: Run live replay certification as fixtures become available

**Objective:** Convert pending synthetic rows to live evidence without blocking the reliability release.

**Command shape:**

```bash
node dist/intelligence/momentum-replay.js <sport> <espn_event_id>
```

**Per-sport evidence to record:**

- Execution timestamp.
- ESPN event ID.
- Market resolution result.
- Output verdict.
- Evaluator verdict.
- End-to-end latency.
- Evidence source and receipt path.
- Any held/rejected reason.

**Required live queue:** NFL, NBA, NHL, CFB, CBB.

**Special NHL gate:** A live rejection proves fail-closed behavior but does not certify the accepted explanation path. NHL remains pending until an accepted live card passes the evaluator.

**Expected:** Each available representative fixture updates only that sport's JSON and Markdown rows.

**Acceptance gate:** No fabricated event, price, latency, verdict, or receipt. An unavailable fixture remains explicitly pending.

**Commit per sport:** `docs(sports-data): record live momentum certification for <sport>`

---

## Task 9: Run the full release gate and prepare v0.29.2

**Objective:** Release only after one uninterrupted clean-room verification pass.

**Commands, in order:**

```bash
npm ci
npm run build
node --test test/*.test.mjs
SPORTSCLAW_MEMORY_BACKEND=file node test/ci-smoke.mjs
node dist/index.js doctor
node dist/index.js health --json
node dist/index.js selftest --quick --json
node dist/index.js selftest --live --sport metadata --json
```

**Expected:**

- Clean install completes. Dependency advisories may be logged, but unrelated dependency remediation does not enter this release.
- TypeScript build passes.
- Full suite passes with the expanded test count.
- CI smoke passes with file memory.
- Doctor passes.
- Health reports `healthy`.
- Offline and representative live selftests pass.

**Version step only after the gate passes:**

```bash
npm version 0.29.2 --no-git-tag-version
git diff -- package.json package-lock.json
```

The version diff must contain release metadata only. Then prepare release notes and request explicit approval before any commit, push, tag, GitHub release, or deployment action.

**Release-note framing:**

- Green CI restored.
- Momentum failures now fail closed with bounded timeouts.
- Forced-output salvage has deterministic regression coverage.
- Foundry health is configured and secret-safe.
- World Cup MCP is optional locally.
- Catalog reporting distinguishes sports from support modules.
- Seven-sport certification states exactly what is live and what remains synthetic.

**Commit:** `chore(release): v0.29.2 reliability release`

**Tag after approval:** `v0.29.2`

---

## Task 10: Verify the published release

**Objective:** Prove the public artifact, not only the source branch.

**Actions:**

1. Install `sportsclaw-engine-core@0.29.2` in a clean temporary directory.
2. Run doctor, health, list JSON, offline selftest, and representative live metadata selftest.
3. Confirm zero optional MCPs are required.
4. Confirm the hosted World Cup MCP is still reachable if manually registered.
5. Confirm the release-tag CI is green.
6. Confirm `paper-trader` and `tv-operator` remain stopped.
7. Confirm docs and package version are aligned.

**Acceptance gate:** Fresh-install behavior matches the release claims. No operator or hosted service starts, stops, or changes as an unintended side effect.

---

## Risks and rollback

### Red base hides regressions

- **Control:** #137 must make `main` green before #136 or #138 merges.
- **Rollback:** Revert the later merge and return to green `main`.

### PR #138 test flakiness

- **Control:** Fake model transport, fixed tick sequences, no real network, five repeated runs.
- **Rollback:** Leave #138 open until the test is deterministic.

### World Cup MCP removal breaks a hidden job

- **Control:** Back up metadata and search operator, watcher, and task state before removal.
- **Rollback:** Restore the metadata entry or re-register the endpoint. Never delete the hosted service.

### Secret leakage

- **Control:** User enters secrets directly. Capture redacted command output only. Never print or copy `.env` values.
- **Rollback:** Stop, redact contaminated artifacts, and ask the user to coordinate any required rotation.

### Catalog drift returns

- **Control:** A pure summary helper plus invariants and JSON CLI output.
- **Rollback:** Revert the catalog commit without touching sports schemas.

### Live fixtures are unavailable

- **Control:** Keep rows pending. The reliability release does not require fabricated completeness.
- **Rollback:** None needed. Pending is valid.

### Unrelated dependency advisories expand scope

- **Control:** Record advisories separately. Only a proven release blocker enters this release.
- **Rollback:** Remove unrelated dependency changes from the diff.

---

## Definition of done

- `main` CI is green at 949/949 or higher.
- PRs #137, #136, and #138 are merged in order.
- PR #138 has deterministic operator-daemon regression coverage.
- Local Azure Foundry health is `healthy` without secret leakage.
- SportsClaw starts and selftests with no optional MCP registered.
- Local `world-cup-mcp` registration is removed only after backup and dependency checks.
- Hosted World Cup service remains intact.
- CLI, source constants, README, and coverage docs agree on 14 default sports, optional esports, six default support modules, and optional Polymarket trading.
- The seven-sport certification JSON and Markdown exist and pass validation.
- v0.29.2 is released only after the uninterrupted release gate and explicit approval.
- Fresh-install post-release verification passes.
- The two operator jobs remain stopped.

---

## Execution handoff

Before implementation:

1. Review and approve this scope.
2. Confirm whether to create the ClickUp implementation card and assign it to Rodrigo.
3. Execute with `subagent-driven-development`, one task per fresh worker.
4. Run two reviews before each merge: specification compliance, then code quality.
5. Do not merge, push, tag, publish, or change local MCP configuration without the applicable approval gate.
