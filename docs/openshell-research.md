# OpenShell / NemoClaw Research — Phase 0

**Status:** complete, awaiting human review before Phase 1.
**Date:** 2026-05-19.
**Scope:** answer the four research questions, document what's verified vs. inferred, surface tensions for the optional-at-install constraint.

---

## Sources consulted

Primary (verbatim, raw):
- `NVIDIA/OpenShell` repo, `main` — README.md, docs/index.mdx, docs/get-started/quickstart.mdx,
  docs/sandboxes/inference-routing.mdx, docs/sandboxes/manage-sandboxes.mdx,
  docs/sandboxes/policies.mdx, docs/reference/policy-schema.mdx (partial).
- `NVIDIA/OpenShell` README quickstart + protection-layer table.
- `NVIDIA/NemoClaw` README and listings (via WebFetch — summarized, not raw).
- `openclaw/openclaw` README (via WebFetch).

Secondary / corroboration:
- developer.nvidia.com blog — "Run Autonomous, Self-Evolving Agents More Safely with NVIDIA OpenShell".
- vietanh.dev — "NVIDIA OpenShell: Policy-Enforced Sandboxes for Autonomous Coding Agents" (2026-03-17).
- futurumgroup.com — "OpenShell Redraws the Agent Control Plane".
- codersera.com — "NemoClaw + OpenClaw Secure Sandbox Guide".

Dead ends:
- `docs.nvidia.com/nemoclaw/latest/index.html` — 404 when fetched. The Developer Guide URL exists in search index but the live page is missing today. Worked around via the NVIDIA blog + ghost.codersera + repo READMEs.
- `kenhuangus.substack.com` — 403. Not material; covered by other sources.
- `blogs.cisco.com/.../securing-enterprise-agents-with-nvidia-and-cisco-ai-defense` — promotional, no implementation detail.

Repo versions observed:
- OpenShell: v0.0.44, May 19 2026, alpha ("proof-of-life — single-player mode").
- NemoClaw: alpha, released 2026-03-16. Apache 2.0. TypeScript-heavy.

---

## (a) Privacy Router endpoint contract

**Verified.** Privacy Router is a real HTTPS endpoint named `https://inference.local`, intercepted by the gateway, reachable **only from inside a sandbox**. It is not exposed to the host.

Wire protocol: OpenAI-compatible and Anthropic-compatible HTTP. Supported routes per provider:

| Provider type configured | Method + path |
|---|---|
| OpenAI-compatible | `POST /v1/chat/completions`, `POST /v1/completions`, `POST /v1/responses`, `GET /v1/models`, `GET /v1/models/*` |
| Anthropic | `POST /v1/messages` |
| NVIDIA API Catalog | OpenAI-compatible patterns above |

Behavior:
- Strips caller `Authorization`. Injects backend credentials from the configured provider record.
- Header allowlist per provider (e.g. `openai-organization`, `x-model-id`; `anthropic-version`, `anthropic-beta`). All others stripped.
- 120s tolerance for idle gaps in streamed responses.
- Per-gateway: **one provider, one model active at a time.** Hot-reloads in ~5s on running sandboxes via `openshell inference set`.
- Sample usage from inside a sandbox:
  ```python
  from openai import OpenAI
  client = OpenAI(base_url="https://inference.local/v1", api_key="unused")
  ```

External LLM hosts (e.g. `api.anthropic.com`, `api.openai.com`, `generativelanguage.googleapis.com`) are still reachable from a sandbox if `network_policies` allows them — they don't get Privacy Router credential injection or routing, only the normal egress policy check.

**Implication for SportsClaw:** the Vercel AI SDK's `openai`, `anthropic`, and any OpenAI-compatible provider can be pointed at `https://inference.local/v1` with a placeholder API key and the sandbox handles credential injection. Drop-in.

**Gemini-shaped tension:** Vercel AI SDK's `@ai-sdk/google` provider speaks Google's GenerativeLanguage API (`generativelanguage.googleapis.com/v1beta/...`), which is **not** OpenAI/Anthropic-compatible and therefore **not handled by Privacy Router**. Options if we want Gemini calls to be policy-routed too:
1. Allow `generativelanguage.googleapis.com` in `network_policies` and accept that Gemini bypasses the Privacy Router (credentials still leak into the sandbox).
2. Switch the Gemini calls to Google's OpenAI-compat endpoint (`generativelanguage.googleapis.com/v1beta/openai/...`) or to Vertex AI's OpenAI-compat endpoint and route them via `inference.local`. Cost: changes prompts/SDK behavior subtly.
3. Drop Gemini entirely for the OpenShell-routed configuration and standardize on Nemotron (local) + Anthropic (frontier). This is the cleanest narrative for the NVIDIA co-marketing story but loses Gemini-specific capabilities (e.g. multimodal calls the engine currently uses).

Phase 1 needs a decision here. My read: option 3 for the Nemotron + Anthropic launch case study, option 1 as a transitional fallback so existing direct-call users aren't affected.

---

## (b) Sandbox process model — supported agents only, or arbitrary processes?

**Verified.** The sandbox accepts arbitrary container images and arbitrary commands.

- `openshell sandbox create -- <agent>` is the convenience path: it injects a pre-shipped binary (`claude`, `opencode`, `codex`, `copilot`) into the base image and runs it. The "supported agents" list applies to **bundled tooling and default policy presets**, not a restriction on what the sandbox can run.
- `openshell sandbox create --from <image>` accepts any container image — base name (`base`, `openclaw`, `ollama`), a local directory with a Dockerfile, or any registry image (`my-registry.example.com/my-image:latest`).
- `openshell sandbox exec -n <name> -- <command>` runs arbitrary commands inside a sandbox with stdin pipe support and exit-code propagation. There is no allow-list of binaries here; the sandbox-internal `process` policy + `landlock` filesystem rules are what constrain it.
- `openshell service expose <sandbox> <port> [name]` makes a long-running process inside the sandbox reachable through a gateway-managed URL. Intended explicitly for "development servers, notebooks, dashboards, or other services that keep listening after the sandbox starts."

**Implication for SportsClaw:** the engine can run inside OpenShell unmodified. SportsClaw already has a Dockerfile in repo root, so the path is:
1. Build a sportsclaw container image (already exists).
2. `openshell sandbox create --from <sportsclaw-image>` with `--gpu` if Nemotron-local needs the GPU.
3. Optionally `openshell service expose` for the tail server / overlay.
4. Inside the sandbox, set `OPENAI_BASE_URL=https://inference.local/v1` (or Anthropic equivalent) and let the Vercel AI SDK hit the Privacy Router.

NemoClaw is **not** a prerequisite. NemoClaw is a sibling stack — it's the "guided onboarding + hardened blueprint" wrapper specifically for OpenClaw assistants, with a LiteLLM proxy on the host. We can borrow ideas (blueprint YAML structure, policy presets) but we don't need to wedge SportsClaw into NemoClaw's blueprint. Running SportsClaw directly as a sandbox under OpenShell is the cleaner path.

---

## (c) Policy authoring

**Verified.** Declarative YAML. Schema is at `docs/reference/policy-schema.mdx` (≈400 lines, not fully read).

Structure:
- Static sections (locked at sandbox creation, require recreate to change):
  - `filesystem_policy` — `read_only`, `read_write` path lists; enforced via Landlock LSM.
  - `landlock` — `compatibility: best_effort | hard_requirement`.
  - `process` — `run_as_user`, `run_as_group` (root rejected); plus seccomp filters.
- Dynamic section (hot-reloadable in ~5s on running sandboxes):
  - `network_policies` — named blocks of `endpoints` (host, port, protocol: `rest` / `websocket` / unset for raw TCP) + `binaries` allowlist + optional `rules` (HTTP method/path). Connections denied if no block matches.

CLI surface:
- `openshell policy set <sandbox> --policy file.yaml` — full replacement.
- `openshell policy update <sandbox>` — incremental merge.
- `OPENSHELL_SANDBOX_POLICY=./policy.yaml` as default.

L7 enforcement: TLS is terminated by the proxy for `protocol: rest` endpoints so it can check HTTP method/path against `rules`. WebSocket upgrades are validated. Raw TCP streams bypass payload inspection.

There is also an `openshell` agent skill named `generate-sandbox-policy` for synthesizing policies from plain-language descriptions or API docs. Probably not relevant to the engine work but useful for tenant onboarding.

---

## (d) Can SportsClaw run inside OpenShell as a process, or does NemoClaw need adapting?

**Answer: SportsClaw can run inside OpenShell directly as a sandbox.** NemoClaw is not on the critical path.

What NemoClaw actually is (separating myth from substance):
- A reference stack for running **OpenClaw** (the messaging-channel assistant) inside OpenShell.
- Bundles: CLI plugin (TypeScript Commander extension), blueprint YAML configs, LiteLLM proxy on the host (port 4000) for model routing, state management, onboarding wizard.
- Adds value when you want OpenClaw's specific shape: multi-channel inbox, voice, Live Canvas, etc.
- Not generic. The blueprints assume OpenClaw's runtime shape.

What SportsClaw needs that OpenShell provides directly:
- Container sandbox with policy enforcement.
- Privacy-aware LLM routing (`inference.local`).
- Network egress policy (already needed — YouTube Live, tail server, image gen APIs, etc.).
- Optional GPU passthrough for Nemotron-local.

What SportsClaw needs that OpenShell **does not** provide:
- Cron-based daemon lifecycle (`sportsclaw operate --job <jobId>` ticking on intervalMs). Sandbox doesn't know what cron is; it just runs whatever process you start. We start the daemon as the sandbox's main process.
- Tail server + overlay. Either runs inside the sandbox with `openshell service expose`, or runs outside (preferred — separate repo, separate concern).
- Sink plugin loading. Stays unchanged; npm modules resolved inside the sandbox like anywhere else, subject to `filesystem_policy`.

**The integration shape:** a thin opt-in layer that, when a job config sets `provider: { type: "openshell" }`, swaps the Vercel AI SDK provider to point at `https://inference.local/v1` instead of `api.anthropic.com` / `generativelanguage.googleapis.com`. That's a provider-level swap inside the existing daemon. **No structural changes to the daemon are required** if we standardize on OpenAI/Anthropic-shaped providers. Gemini is the exception (see §(a) tension).

Packaging: ship a Dockerfile that produces a SportsClaw sandbox image. Document `openshell sandbox create --from <image>` as the runbook for the NVIDIA case study. Optional `sportsclaw-openshell` plugin can bundle the recommended `policy.yaml` (network rules for known sink dependencies, filesystem rules for `~/.sportsclaw`) but is not required for the basic path.

---

## Optional-at-install constraint — assessment

**Cleanly satisfiable.** The Privacy Router is OpenAI/Anthropic-compatible HTTP. From the daemon's perspective there is no difference between calling `https://api.anthropic.com/v1/messages` and calling `https://inference.local/v1/messages` — just a `baseURL` swap.

Concrete shape (proposed for Phase 1):
- New optional field on the job config: `provider` (already hinted at in the work envelope). Existing direct-call code path stays the default.
- When `provider.type === "openshell"`, the engine sets the Vercel AI SDK provider's `baseURL` to `https://inference.local/v1` and passes a placeholder API key.
- When unset, current behavior — direct LLM calls — is unchanged.
- Engine ships with no `openshell` runtime dependency, no NemoClaw dependency, no Docker requirement.

**Where the "optional" story leaks (be honest about this):**

1. **Gemini.** As covered in §(a). If the engine keeps Gemini as a first-class provider, OpenShell deployment forces a per-call routing decision (Gemini bypasses Privacy Router; Anthropic goes through it). Surface as a policy concern: it works, but the "Privacy Router routing between local and frontier" narrative is partly fiction unless we standardize models.

2. **Per-gateway one-provider-one-model.** OpenShell's `inference.local` exposes exactly one configured provider+model per gateway. If the engine wants to call Nemotron for safety check + Anthropic for content + Gemini for image-prompting in one tick, those are three different upstream backends. `inference.local` can't multiplex them. Options:
   - Multiple gateways (heavy).
   - Hot-switch model between calls (slow, ~5s reload — kills tick latency).
   - Run some calls direct (network_policies allow) and only the policy-sensitive ones through `inference.local`.
   This is an honest constraint that affects how we tell the NVIDIA story. The most defensible architecture: the **default** for any tick that doesn't need frontier reasoning routes to local Nemotron via `inference.local`; tick steps that explicitly need Claude/GPT can either route via a second gateway or go direct with credentials. NemoClaw's LiteLLM-on-host approach exists precisely to dodge this constraint — the LiteLLM proxy multiplexes upstreams behind a single OpenAI-compat endpoint. We could borrow that pattern.

3. **GPU.** Nemotron-local needs a GPU. The Brev credit covers it for the case study, but for "anyone running `sportsclaw operate` on a laptop without NVIDIA infra" the local-model story doesn't apply — they'd point `inference.local` at a hosted Nemotron via NVIDIA API Catalog, or skip OpenShell entirely. The optional-at-install promise still holds; just naming the realistic deployment shapes.

4. **Sandbox-only Privacy Router.** `inference.local` is only reachable from inside an OpenShell sandbox. There is no host-side mode where SportsClaw stays on the host and just uses the router as an LLM proxy. Either you go in-sandbox (NVIDIA case study) or you stay direct (current default). No middle ground without running our own LiteLLM-style proxy on the host.

---

## Open questions for Phase 1

1. Do we standardize on OpenAI/Anthropic-shaped providers (drop or re-route Gemini) for the OpenShell story, or accept a two-track routing (some via `inference.local`, some direct)?
2. Do we ship a `sportsclaw-openshell` plugin/blueprint with a recommended `policy.yaml`, or document a hand-rolled policy in the README and skip the plugin?
3. Multi-provider-per-tick problem — solve via NemoClaw-style LiteLLM-on-host, multiple gateways, or accept the constraint and architect ticks so each tick uses one upstream?
4. Is the SportsClaw Dockerfile production-ready as a sandbox image (writable workspace lives where, where do sink-plugin modules resolve from, how do we mount `~/.sportsclaw/operator/<jobId>.json` into the sandbox), or does it need work?
5. Do we want the tail server + overlay running inside the same sandbox (via `openshell service expose`) for the case study, or stay external?

---

**Stopping here as instructed. Phase 1 design will not be drafted until this is reviewed.**
