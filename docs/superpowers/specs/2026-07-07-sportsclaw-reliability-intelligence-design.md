# Spec: sportsclaw Reliability + Intelligence Upgrade (revised)

**Date:** 2026-07-07
**Status:** Design — awaiting review
**Supersedes:** the original Python-authored spec (see "Corrections" below)

## Goal

Make sportsclaw smarter and harder to break: fewer failed tool calls, cleaner
recovery when tools fail, faster answers, and smarter multi-dimensional queries.

## Corrections to the original spec (evidence-grounded)

The original spec was written in **Python**. sportsclaw-engine-core is
**Node.js / TypeScript / ESM** (`package.json` v0.29.1, `type: module`). The only
Python in the repo is `docker/relay/relay_server.py`; Python lives in the separate
`sports-skills` backend the engine shells out to. **Everything here is TypeScript**,
kebab-case files, `camelCase`/`PascalCase`, `.js` import extensions, tested via the
existing `npm test` / `test:*` script harness (not pytest).

Verified against the live repo, the `sports-skills` source (v0.28.0), and the hosted
World Cup MCP:

1. **Tool names are real, not invented.** sportsclaw builds them `${sport}_${command}`
   (`src/tools.ts:85`); `sports-skills` schema emits the same (`cli.py:828`). So
   `football_get_player_profile`, `nba_get_scoreboard`, `metadata_search_teams`,
   `kalshi_get_exchange_status`, `polymarket_get_sports_config` all exist.

2. **Preflight §1 already largely exists in TS:**
   - `sanitizeToolInput()` (`src/tools.ts:132`) normalizes bare-year seasons
     (`2026` → `espn.mlb.2026`, football → `premier-league-2026`).
   - `detectGuessedId()` (`:102`) + `buildLookupSuggestion()` (`:76`) detect a
     name-as-ID and emit "Call `football_search_player(query=…)`".
   - The original spec's season example `2025-26` is **wrong**: `sports-skills`
     `_resolve_season` (`football/_connector.py:1228`) rejects `2025-26`; the
     canonical form is `{competition-slug}-{single-year}` (e.g. `premier-league-2025`),
     which the existing `sanitizeToolInput` already produces.

3. **Market-ID prefixing is World-Cup-MCP-specific, NOT global.** `sports-skills`
   `kalshi_*` / `polymarket_*` tools take **bare** tickers/ids (`cli.py:141`, no
   prefix requirement anywhere in source). The `kalshi:` / `polymarket:` scheme
   exists **only** in the hosted `worldcup-get-market-state` MCP workflow
   (`world-cup/SKILL.md:153`, workflow branches on `requested_id.startswith('kalshi:')`).
   A global "prefix all market IDs" rule would **break** direct kalshi/polymarket calls.

4. **Failure classification §2 partially exists:** `bridge.ts::classifyBridgeError`
   (`src/bridge.ts:47`, handles 429/retry) and `mcp.ts::classifyError` (`:944`).

5. **Readiness §3 is server-side data.** "Not enough knockout matches" exists in
   **neither** sportsclaw nor sports-skills — it is raised inside the WC MCP
   `wcbracket-engine`. `wcbracket-simulate` is a live workflow (100% / 37 runs) that
   already guards simulation on `bracket.rounds`. The client has no
   `knockout_events_count` in context, so it cannot gate this pre-call. Reframed below.

6. **Entity cache §6 exists in-memory:** `EntityResolver` singleton
   (`src/intelligence/entity-resolver.ts`) with `providerIds`/`aliases`/
   `mapToProviderId`. Missing: persistence + TTL. No SQLite dependency exists;
   persistence will use JSON under `~/.sportsclaw/` (matches tasks/memory patterns).

7. **Routing §5 exists:** `router.ts` + config `routingMode`/`routingMaxSkills:2`/
   `routingAllowSpillover:1` (`src/types.ts:345`), with spillover + skill aliases.
   Missing: query-complexity-driven cap expansion.

8. **`executeToolSafely` §7:** `ToolRegistry.execute` already chains sanitize → cache →
   bridge → circuit-breaker. This is consolidation, not a new system.

9. **selftest §4:** genuinely new. `cmdDoctor` (env/versions) and `cmdHealth`
   (connectivity) exist but neither runs representative per-schema tool calls.

## Open-source constraint (drives Phase 1 split)

sportsclaw is **MIT** and `files: ["dist", ...]` — all of `src/` ships publicly to npm.
The kalshi/polymarket market-normalization logic is **proprietary** and must **not**
land in the client. It therefore lives **server-side** in the hosted, metered
`worldcup-get-market-state` workflow (the established "world-cup premium, no local
code, server-side" pattern). The open client gets only generic reliability plumbing.

## Phases

### Phase 1 — Fix the World Cup market-state bug + generic failure classification

**1a — Server-side (WC MCP, closed, separate deploy):**
Harden `worldcup-get-market-state` so a bare ticker/id normalizes to the prefixed
form *inside the workflow* before the `startswith('kalshi:'/'polymarket:')` branches.
Detection: Kalshi tickers match `^KX` / uppercase-hyphenated series; Polymarket ids
are numeric / `0x…` token / slug. Emit a `warnings` entry when a bare id was coerced.
**Requires explicit user confirmation before editing the production workflow.**

**1b — Client-side (sportsclaw, open):**
Extend the existing classifiers into one `classifyFailure(error, toolName?)` returning
a `ClassifiedFailure { category, severity, retryable, userMessage, developerMessage,
suggestedFix? }`. Categories: `USER_INPUT`, `DATA_NOT_READY`, `PROVIDER_ERROR`,
`RATE_LIMITED`, `PERMISSION_CONFIG`, `AUTH_ERROR`, `TOOL_CONTRACT`, `AGENT_PLANNING`,
`UNKNOWN`. Rules are **generic pattern matches** (429 → RATE_LIMITED; 401/403 → AUTH /
PERMISSION_CONFIG; "not enough … matches"/"not ready" → DATA_NOT_READY; storage 403 →
PERMISSION_CONFIG) — **no proprietary market rules**. Compose `classifyBridgeError` /
`mcp.classifyError` rather than replace them. Pair with §8 user-facing messages:
*what failed → why → whether retry helps → what to do next.* Never "tool failed" alone.

- **Files:** `src/failures/classifier.ts`, `src/failures/types.ts`; wire into
  `ToolRegistry.execute` / `bridge.ts`.
- **Verify:** unit tests map each known error string to the right category/retryable;
  a market-state DATA_NOT_READY/USER_INPUT failure renders a clean user message.

### Phase 2 — `sportsclaw selftest`

New `cmdSelftest(args)` in `src/index.ts` + `src/selftest/{runner,cases,report}.ts`.
Reuses `cmdDoctor`'s env preconditions. Flags: `--quick`, `--sport <s>`, `--json`,
`--live`. Cases use **confirmed** `${module}_${command}` names (nba_get_scoreboard,
nfl_get_scoreboard, mlb_get_scoreboard, football_get_competitions,
metadata_search_teams, kalshi_get_exchange_status, polymarket_get_sports_config, …).
Output: a markdown table (sport/check/status/latency/notes) and a serializable JSON
report `{ version, passed, failed, skipped, results[] }`. Failures run through
`classifyFailure` (Phase 1b).

- **Verify:** `run_selftest(sports:["metadata"], live:false)` yields ≥1 result;
  `JSON.stringify(report.toJSON())` succeeds; `selftest --quick --json` is valid.

### Phase 3 — Entity cache persistence

Add a JSON-backed store + TTL behind the existing `EntityResolver` (no new module tree,
no SQLite). `~/.sportsclaw/entity-cache.json`. `CachedEntity` fields per original spec
(entity_type, sport, canonicalName, aliases, providerIds, confidence, timestamps,
mentionCount). TTLs: team 180d, player 90d, competition 365d, season 30d, market 1d;
never cache injury/roster status. `getEntity` precedes resolver tools; `upsertEntity`
after successful lookups.

- **Verify:** upsert→get round-trips providerIds; a 2-day-old market entity is stale.

### Phase 4 — Complexity-aware routing

Add `src/routing/complexity.ts` (`classifyQueryComplexity(query)` →
`SIMPLE|COMPOUND|RESEARCH|BETTING|LIVE_GAME`) and a small planner that raises the
existing `routingMaxSkills`/`routingAllowSpillover` caps per complexity (simple 1–2,
team overview 3, betting 3–4, multi-sport 4, research 3–5). Keyword sets per the
original spec (betting → betting/markets/kalshi/polymarket; live → scoreboard;
injury/news → news). Integrates into `router.ts`; does not replace it.

- **Verify:** "lakers score" ≤2 skills; "best Lakers bets tonight" ≥3 incl. a
  betting/markets skill; "what's happening tonight across sports" ≥4.

### Phase 5 — Wrapper consolidation + observability

Consolidate the execute path into one `executeToolSafely(toolName, args, context)` →
`ToolExecutionResult { ok, toolName, args, data?, warnings, failure?, latencyMs,
normalized }`, composing existing sanitize/cache/bridge/circuit-breaker + Phase 1b
classification. Add a structured `tool_execution` log event
(`{ event, toolName, ok, latencyMs, failureCategory, normalized, argsHash, timestamp }`)
via the existing `analytics.ts`/`incident-log.ts`, with **credential redaction**
(drop `api_key`, tokens, auth headers, wallet keys; hash args).

- **Verify:** redaction test asserts secrets never appear in the serialized event;
  existing raw tool execution still passes its current tests.

## Non-goals

- No client-side kalshi/polymarket normalization (proprietary → server-side).
- No client-side bracket readiness gate (server-side data).
- No new Python packages; no SQLite dependency.
- No refactor of modules not listed above.

## Test surface (TS, mirrors original checklist)

`test/failures/*`, `test/selftest/*`, `test/cache/*`, `test/routing/*`,
`test/tools/*` (safe executor), `test/logging/*` (redaction), wired as `test:*`
npm scripts consistent with existing ones.

## Definition of Done

- Bare World Cup market IDs resolve (server-side) instead of silently returning empty.
- Known failures classify into structured categories with clean user messages.
- `sportsclaw selftest --quick --json` returns a valid health report.
- Compound betting/team queries activate ≥3 relevant skills.
- Entity IDs persist and are reused with per-type TTLs.
- Logs redact credentials.
