# OpenShell Integration Plan — Phase 1

**Status:** draft, decisions D1–D5 captured (2026-05-19), awaiting overall plan approval before Phase 2.
**Prereq:** [Phase 0 research](./openshell-research.md).
**Scope:** engine-side integration design only. No production code in this document.

## Decisions captured (2026-05-19)

- **D1 Gemini** — Drop Gemini for OpenShell-enabled jobs. Validator errors on `openshell` block + `provider: "google"`. Existing direct-call Gemini users unaffected.
- **D2 Multi-provider** — Accept the Privacy Router's one-provider-one-model-per-gateway constraint for v1. Multi-provider ticks remain a direct-call feature.
- **D3 Engine.ts policy** — Relaxed. Centralizing the three duplicated `resolveModel` helpers is now on the table as a separate follow-up. The OpenShell plan itself does not require engine.ts changes (env-var seam stands).
- **D4 Plugin location** — Subdirectory of sportsclaw (`sportsclaw/openshell/`). No separate package or repo. Engine and OpenShell recipe ship in the same release. See [§4](#4-engine-vs-sportsclawopenshell-subdirectory) and [Risk R8](#risks).
- **D5 Telemetry** — Optional `inferenceRoute` field on existing tick events. No new event type, no sink contract change.

---

## TL;DR

The cleanest integration uses Vercel AI SDK's **environment-variable-driven base URL override** as the routing seam, plus a new optional `openshell` block in the job config that drives an **opt-in launcher** which sets those env vars before the daemon constructs models. Engine internals (`engine.ts`, `heartbeat.ts`, `subagent.ts`, `router.ts`) require **zero source changes** for the default direct-call path. The OpenShell-specific image, policy, and sandbox runbook ship as a **separate `sportsclaw-openshell` plugin/recipe** outside this repo so the engine stays vendor-neutral.

Two architectural decisions need a human call before Phase 2 starts (see [Decisions needed](#decisions-needed)).

---

## Grounding facts from the current codebase

These ground every design choice below. I checked the code, not memory.

- The Vercel AI SDK is wired in via three packages: `@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/google`. The default singleton imports (`anthropic`, `openai`, `google`) read their base URL from env vars (`ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`, `GOOGLE_GENERATIVE_AI_BASE_URL`) at construction time.
- `generateText` is called from at least seven files: `engine.ts` (≥6 sites), `heartbeat.ts`, `router.ts`, `operator-daemon.ts`, `subagent.ts`, `setup.ts`.
- The `provider → model` switch (`anthropic(modelId)` / `openai(modelId)` / `google(modelId)`) is duplicated in three places: `engine.ts:194`, `operate.ts:394`, `setup.ts:51`. The comment at `operate.ts:391–392` claims an older spec forbade engine.ts changes — see [Risk R3](#risks).
- The job config (`operator-config.ts:24-`) already has optional `provider` and `model` fields with sensible defaults. The work envelope explicitly allows adding a new optional field; that's our seam.
- `operate.ts` is the launcher. It loads the config, sets env via `applyConfigToEnv`, resolves the sink, and calls `createOperatorDaemon`. This is the only file that needs new logic for the launcher path.
- `TickEvent` (operator-daemon.ts:80) is an open discriminated union — adding a new event type or extending an existing one with optional fields does not break the sink plugin contract (sinks subscribe to events; unknown fields are ignored by structural typing).

---

## 1. Where the provider abstraction lives

### The seam: env-var-driven base URL override

The Vercel AI SDK default exports honor `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`, and `GOOGLE_GENERATIVE_AI_BASE_URL` at construction time. We exploit this:

- Production code keeps calling `anthropic(modelId)` / `openai(modelId)` / `google(modelId)` exactly as today.
- The launcher (`operate.ts`) sets the appropriate base URL env var **before** any provider singleton is constructed (i.e. before the daemon's first model resolution).
- When `https://inference.local` is set as the base URL, every call routes through the Privacy Router.

This means **engine.ts is not modified for the default path.** The env-var trick is invisible to anyone who isn't running under OpenShell.

### Constraint imposed by Privacy Router

The Privacy Router exposes **one provider+model per gateway** (Phase 0 §a). Two consequences:

1. If the gateway is configured for Anthropic, only `POST /v1/messages` calls succeed. `openai()` SDK calls would route to `inference.local/v1/chat/completions` which is rejected. We therefore need the job config's `provider` to match the gateway's configured provider. The launcher validates this on startup and fails fast.
2. Inside a single OpenShell sandbox there is no native way to call Anthropic *and* OpenAI *and* Gemini in the same tick. For Phase 2 we standardize on **one provider per OpenShell-enabled job** and accept that multi-provider ticks remain a direct-call feature only.

### Gemini

The `@ai-sdk/google` provider does **not** speak the same protocol the Privacy Router exposes. Three options, exactly as in Phase 0:

- **Option A (recommended for the case study):** standardize Machina Sports TV on a Nemotron-local + Anthropic-frontier story. Drop Gemini from the OpenShell-enabled job config. Existing Gemini users with no `openshell` block see no change.
- **Option B:** allow Gemini under OpenShell but route it direct (network policy allow + bypass Privacy Router). Asterisk on the NVIDIA marketing story.
- **Option C:** swap `@ai-sdk/google` for Google's OpenAI-compat endpoint when OpenShell mode is on. More engineering, brittle behaviour delta vs. native Gemini.

**Default plan: Option A.** Surface in config as a startup error when `provider: "google"` and `openshell` block is present together.

### Why not a centralized `resolveModel`?

We could refactor the three duplicated `resolveModel` helpers into one. We don't need to for OpenShell — env-var routing already covers the case. Doing the refactor opportunistically inside this work would couple the OpenShell change to a broader cleanup; better to keep the diff narrow and propose the refactor as a separate follow-up.

---

## 2. Routing telemetry

OpenShell's gateway already logs every routing decision (`openshell logs <sandbox> --tail`). We don't reimplement that. What the engine adds:

### A single `inference_route` field on `TickEvent`s that go through `generateText`

Add an optional field on the `tick_started` / `tick_completed` (or whatever the relevant tick events are — re-check during implementation) event payload:

```
inferenceRoute?: {
  via: "direct" | "openshell";
  baseUrl?: string;       // present when via === "openshell"
  provider: LLMProvider;
  model: string;
}
```

Sinks that want to render or forward this (tail-server, console) opt in by reading the field. Sinks that don't care ignore it. **No sink plugin contract change** — the field is optional and additive.

### Startup banner

When the launcher detects `openshell` config, log a one-line banner before the first tick:

```
[operate] openshell mode: routing inference via https://inference.local (provider=anthropic, model=claude-...)
```

This is the user-visible signal that the env-var trick is in effect.

### Why not richer telemetry?

The Privacy Router's own log stream is more authoritative than anything we'd emit (it sees every request, including credential injection metadata). Duplicating it in the engine would invite drift. Defer richer telemetry to a follow-up if there's demand.

---

## 3. How the optional-at-install constraint is enforced

Three layers:

### Layer 1 — runtime dependency layer

- Engine ships with **no new npm dependencies.** The env-var trick uses existing `@ai-sdk/*` packages.
- Engine ships with **no `openshell` CLI dependency.** The launcher does not shell out to `openshell ...`; it just reads config and sets env vars. Anyone running on a laptop with no `openshell` binary on PATH is unaffected.
- A separate `sportsclaw-openshell` plugin (see §4) holds the Dockerfile, policy YAML, and sandbox lifecycle docs. The engine repo has no knowledge of it beyond a README pointer.

### Layer 2 — config layer

- New optional `openshell?: OpenShellConfig` field on `OperatorJobConfig`. Its absence is the default; behaviour is identical to today's engine.
- When `openshell` is present, validator enforces:
  - `provider` is set and matches the gateway's expected provider (Anthropic/OpenAI/NVIDIA).
  - `model` is set (no implicit defaults — OpenShell uses one model per gateway, so be explicit).
  - `provider !== "google"` (unless we accept Option B/C from §1).
- Config-level migration: existing config files don't have the field, validator skips the block, daemon launches with direct LLM calls. **Zero changes for current users.**

Rough shape (for design discussion, not literal source):
```
openshell?: {
  // Whether to set ANTHROPIC_BASE_URL / OPENAI_BASE_URL on launch.
  // Default: when this block exists, true.
  enabled?: boolean;

  // The URL the launcher sets as the SDK base URL. Defaults to
  // "https://inference.local" — the only value that makes sense inside
  // an OpenShell sandbox. Field is here for future use (e.g. pointing
  // at a LiteLLM-on-host proxy that mimics inference.local).
  baseUrl?: string;
};
```

### Layer 3 — install/packaging layer

- The engine's existing Dockerfile stays as the deployable artifact. The OpenShell case-study image either:
  - is the same Dockerfile run via `openshell sandbox create --from <sportsclaw-image>`, or
  - is a thin downstream image in the `sportsclaw-openshell` plugin repo that pins a known-good sportsclaw version + bundled `policy.yaml`.
- No changes to `package.json` deps. No changes to `npm install` flow.

---

## 4. Engine vs. `sportsclaw/openshell/` subdirectory

Per D4, the OpenShell recipe lives as a subdirectory of this repo, not a separate package. The split is therefore between **engine source** (existing TypeScript) and a **recipe directory** (Dockerfile, YAML, runbook).

### Engine source (existing layout)

- The optional `openshell` config block (schema + validator) — `src/operator-config.ts`.
- The launcher logic that reads the block and sets env vars — `src/operate.ts`.
- The optional `inferenceRoute` field on `TickEvent` payloads — `src/operator-daemon.ts`.
- The startup banner — `src/operate.ts`.
- A README section explaining OpenShell mode and pointing at `openshell/` for the recipe.

Approximate engine-side diff: ~80–150 LOC across `operator-config.ts`, `operate.ts`, `operator-daemon.ts`, plus tests.

### `sportsclaw/openshell/` subdirectory (new)

- `openshell/policy.yaml` — reference policy with network rules for known sink dependencies (YouTube Live, image-gen APIs, tail-server URL).
- `openshell/Dockerfile` — a thin downstream image (or a build script that produces one) that combines the repo-root Dockerfile + the Machina Sports TV sink + an entry point that respects the `openshell` config block.
- `openshell/README.md` — runbook: install OpenShell, create gateway, configure provider, `openshell sandbox create --from sportsclaw-openshell:latest`, expose tail-server.
- `openshell/models.md` — the Nemotron model-id table (which Nemotron variant pairs with which gateway provider type).
- Optional: `openshell/generate-policy.ts` — a thin `policy.yaml` synthesizer from sink manifest. Could be deferred and replaced by OpenShell's `generate-sandbox-policy` agent skill.

### Implications of the subdirectory choice (D4)

- **Optional-at-install preserved.** The subdirectory ships as **static files only** — `Dockerfile`, `policy.yaml`, `README.md`, `models.md`. No JavaScript in the npm install path, no new `package.json` dependencies, no `openshell` CLI required on PATH for current users. The engine code paths added in Phase 2a (config block, env-var swap, telemetry field) are **inert** unless a job config opts in via an `openshell` block. A laptop user running `sportsclaw operate --job foo` with no OpenShell config sees zero behavioral change. This honors the hard constraint from the work envelope.
- **Not vendor-locked.** OpenShell is Apache 2.0, generic, and supports Anthropic, any OpenAI-compatible provider, NVIDIA API Catalog, and local backends (Ollama, vLLM, LM Studio). The subdirectory is named after the *runtime*, not the vendor — same way a `docker/` or `k8s/` subdirectory would be. The Nemotron model table in `openshell/models.md` documents one supported configuration; the recipe itself works with non-NVIDIA backends. The NVIDIA co-marketing story is built *on top of* this neutral integration, not baked into it.
- **Coupled releases.** The engine and OpenShell recipe ship in the same npm release. A breaking change to the recipe forces an engine release. Mitigate by treating `openshell/` as documentation-grade — versioned only when behavior actually changes.
- **External tenants pull the recipe whether they use it or not.** Static files, ~tens of KB. Negligible cost.
- **Faster iteration for the case study.** No second-repo bootstrap, no cross-repo PR coordination, no separate CI. For the World Cup deadline this matters.
- See [Risk R8](#risks) for the coupling concern.

---

## 5. Migration path

Three phases of engine work, each independently reviewable.

### Phase 2a — config + launcher (minimum to validate the end-to-end path)

1. Extend `OperatorJobConfig` with optional `openshell` field. Add validator entry.
2. In `operate.ts`, after `applyConfigToEnv`, branch on `cfg.openshell`: when present and enabled, set `ANTHROPIC_BASE_URL` (or whichever provider matches `cfg.provider`) to `cfg.openshell.baseUrl ?? "https://inference.local"`.
3. Add a startup banner log.
4. Add a small fixture-style integration test: load a config with `openshell` block, assert env vars are set, assert provider construction picks up the new base URL.

Gate: a sportsclaw daemon launched against a stub HTTP server (mimicking `inference.local`) should successfully route a tick through the stub.

### Phase 2b — telemetry

1. Add `inferenceRoute` to tick events (optional, additive).
2. Update the bundled noop sink to log the field when present. Don't touch external sink contract — third-party sinks ignore it.

Gate: a tick with `openshell` enabled emits an event with `inferenceRoute.via === "openshell"`.

### Phase 2c — `sportsclaw/openshell/` subdirectory

Added to this repo (per D4). New files only — no edits to existing engine source beyond the root README pointer added in Phase 2a.

Contents per [§4](#4-engine-vs-sportsclawopenshell-subdirectory): `policy.yaml`, `Dockerfile`, `README.md` (runbook), `models.md`.

Gate: end-to-end demo — Machina Sports TV job config with `openshell` block, run inside `openshell sandbox create --from sportsclaw-openshell:latest`, ticks publish through Privacy Router to Nemotron + Anthropic.

### What's NOT in scope for Phase 2

- The multi-provider-per-tick problem (Phase 0 §optional-at-install leak #2). Defer; single-provider-per-job is the constraint for v1.
- Per-call routing decisions (LiteLLM-on-host pattern). Defer.
- Refactoring the three duplicated `resolveModel` helpers. Independently valuable but not load-bearing for OpenShell.
- Engine.ts changes. The env-var seam avoids them.
- Gemini compatibility under OpenShell. Currently Option A (drop Gemini for OpenShell-enabled jobs); revisit if a tenant needs it.

---

## 6. Risks

### R1 — Privacy Router rejects calls we didn't anticipate

Privacy Router enforces a strict header allowlist and a strict route allowlist per provider. If `@ai-sdk/anthropic` sends a header we haven't checked is allowed (e.g. a custom user-agent or a new beta header), the router strips it silently — most paths still work because Anthropic SDKs treat those headers as cosmetic, but a future SDK upgrade could surprise us. **Mitigation:** pin the `@ai-sdk/anthropic` version when shipping the OpenShell-enabled case study; have the plugin's CI run a smoke test against a live or mocked `inference.local`.

### R2 — 60s default timeout is short for long reasoning models

Privacy Router defaults to 60s per upstream call. Nemotron-3-Super-120B at long thinking phases can exceed that. **Mitigation:** document `openshell inference set --timeout 300` in the plugin runbook. Surface it as an explicit choice in the recipe.

### R3 — Engine.ts modification policy (resolved)

Per D3, the prior prohibition is relaxed. The OpenShell plan still avoids engine.ts changes via the env-var seam — so this risk is dormant for Phase 2. The follow-up to centralize the three duplicated `resolveModel` helpers (`engine.ts:194`, `operate.ts:394`, `setup.ts:51`) is now permissible as a separate task; out of scope for this plan.

### R4 — `inference.local` is sandbox-only

The Privacy Router is only reachable from inside an OpenShell sandbox. A SportsClaw daemon running on the host with `ANTHROPIC_BASE_URL=https://inference.local` will fail DNS resolution. This is fine if the launcher only sets the env var when actually inside a sandbox, but if a user copies an OpenShell config to a host-only environment they'll get cryptic errors. **Mitigation:** the launcher does a startup probe — if `openshell` is configured but `inference.local` doesn't resolve, fail with an explicit error message before the first tick.

### R5 — Sink contract drift via `inferenceRoute`

If we accidentally promote `inferenceRoute` from optional to required, we break every external sink. **Mitigation:** it's optional and additive. Document this explicitly in the tick-event type comments; cover it in a sink-contract regression test.

### R6 — Privacy Router hot-reload boundary

Hot-reloading the inference provider (`openshell inference update`) takes ~5s. If a tick is in-flight during a reload, the streamed response is closed and reissued. Existing connection-scoped streams are not interrupted. **Mitigation:** for the case study, don't change providers mid-broadcast. For ops docs, call out that `inference update` is safe but causes a brief retry window.

### R7 — Single-provider-per-gateway becomes a hard wall

If Machina Sports TV genuinely needs both Nemotron (for cheap classification) and Claude (for narration) in the same tick — and the case study probably will — single-gateway-single-provider isn't enough. Per D2 we've accepted the constraint for v1, but it might bite during Phase 2c. **Mitigation:** scope the v1 demo to single-provider ticks. If multi-provider becomes a blocker, NemoClaw-style LiteLLM-on-host is the established workaround. Per D4, that workaround would also live under `sportsclaw/openshell/` rather than as a separate plugin.

### R8 — Subdirectory coupling (D4)

`sportsclaw/openshell/` ships in the engine's npm release. Two failure modes: (1) a recipe-only change (e.g. `policy.yaml` update) forces an engine version bump, polluting release history; (2) an engine release breaks the recipe and we don't notice because there's no separate CI gate. **Mitigation:** treat `openshell/` as documentation-grade — version it via doc-update commits only, never publish-blocking. Add a CI smoke test that builds the `openshell/Dockerfile` and runs `--validate` against a fixture job config; failure blocks engine release.

---

## Decisions captured

All five decisions resolved 2026-05-19 (see top of doc). Summary:

| ID | Topic | Decision |
|----|---|---|
| D1 | Gemini under OpenShell | Drop for OpenShell jobs; validator errors |
| D2 | Multi-provider per tick | Accept single-provider constraint for v1 |
| D3 | Engine.ts modification | Relaxed; centralization permissible as separate follow-up |
| D4 | Plugin location | Subdirectory of sportsclaw (`sportsclaw/openshell/`) |
| D5 | Telemetry shape | Optional `inferenceRoute` field on existing tick events |

---

**Stopping here as instructed. No production code written. Awaiting overall plan approval before Phase 2a.**
