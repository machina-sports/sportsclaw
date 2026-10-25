# Unified inference boundary

Every SportsClaw runtime model call goes through one module:

| Entry point | Wraps | Used by |
|---|---|---|
| `generate(ctx, params)` — `src/inference/run.ts` | AI SDK `generateText` | chat engine, router, subagents, heartbeat, setup, operator ticks, momentum explainer/evaluator, model roles (NIM / OpenShell), watch-intent interpreter |
| `stream(ctx, params)` — `src/inference/run.ts` | AI SDK `streamText` | streamed operator ticks |
| `image(ctx, provider, prompt, …)` — `src/inference/run.ts` | native image dispatcher (`src/inference/image-gen.ts`) | `generate_image` tool (`src/image-gen.ts`) |
| `decide(ctx, client, request, options)` — `src/inference/decide.ts` | `JevDecisionClient.decide` | evidence verifier, capability router, decision relay |

## What the boundary does — and doesn't do

- It only adds a per-call **receipt**. Params, SDK generics, result objects,
  aborts, timeouts, `maxRetries` and provider error instances all pass through
  unchanged. Callers still build their own models (`resolveModel`, native
  NIM / OpenShell endpoints); building a provider client doesn't count as
  inference.
- `stream()` returns the SDK result synchronously and never drains it. The
  receipt is sent once, on real completion, failure or abort, and only after
  the caller's own `onFinish` / `onError` / `onAbort` has run. Failures the
  SDK's callbacks never see are covered too: a synchronous construction error
  (for example `maxRetries: -1`) is reported and rethrown unchanged. An error
  raised by the model's own stream reader reaches no SDK callback, so
  `stream()` observes it at the public language-model protocol: the call's
  model, and any model a `prepareStep` override returns, is passed to the SDK
  through a proxy that intercepts only `doStream` and wraps the returned
  `stream` in a lazy pass-through (it reads only when the SDK reads and
  rethrows the original error). The SDK reads provider streams eagerly, so
  such a failure may be reported before the caller consumes the result; a
  success is never reported early. The SDK result object is returned as is,
  with no private SDK methods touched. A caller abort is still reported
  through `onAbort`, after the caller's handler.
- Not observed at the model level, so these keep callback-only reporting: a
  string model id (resolved by the SDK's global provider; the boundary does
  not resolve gateway ids itself), a model object without a redefinable
  `doStream`, and an injected `impl`, which receives the caller's params
  unchanged. Inside `prepareStep`, `options.model` is the observed proxy, not
  the caller's original object.
- A call is `failed`, never `completed`, when the model finishes with
  `finishReason: "error"` (the result is still returned unchanged) or when the
  caller's `onFinish` throws or rejects (the stream still errors with the
  caller's own error, as with the raw SDK).
- Receipts (`ctx.onReceipt`) carry only closed enums, a bounded model id,
  usage counts, step count and latency. They never carry prompts, state, tool
  I/O, raw errors, endpoints, credentials or user ids. `errorCode` comes from
  `INFERENCE_ERROR_CODES`. If an observer throws, or is async and rejects, the
  error is swallowed and never logged. Each receipt belongs to one call:
  there's no global "last call" state.
- Receipts are sanitized before delivery. A `purpose` outside
  `INFERENCE_PURPOSES` is reported as `other`. A provider `finishReason`
  outside the SDK enum is dropped. Token counts and step counts appear only
  when they are non-negative safe integers. Callers still get the original SDK
  values.
- Without a caller `onError`, a stream error logs only its closed status and
  code, with no provider content. An explicit `onError` still receives the
  original error.
- `generate(ctx, params, impl?)` and `stream(ctx, params, impl?)` take an
  optional trusted, code-supplied SDK-compatible implementation, such as a
  test double. It runs inside the same receipt boundary. The operator
  daemon always calls the boundary and passes `generateTextImpl` /
  `streamTextImpl` through it.
- Library exports from the package entry: `generateInference`,
  `streamInference`, `imageInference`, `decideInference`, plus the receipt
  types, `INFERENCE_ERROR_CODES` and `INFERENCE_PURPOSES`.
- There's no new routing model, fallback or provider. NIM/OpenShell
  safeguards still apply (OpenShell needs a sandbox, uses explicit native
  endpoints, isolated HTTP and credential substitution). `invokeModelRole`
  now accepts `abortSignal` and `onReceipt`. `makeRunModelRole`'s timeout now
  aborts the underlying request.
- `decide.ts` imports no SDK, engine, MCP, memory or provider module. Jev
  stays opt-in, keeps its consent and pinned-model validation, and
  `JevDecisionClient` is still the public low-level client.

`test/inference-boundary-guard.test.mjs` parses every `src/**/*.ts` file and
fails the build on any bypass: imports of SDK execution functions (named,
aliased, namespace, default, dynamic, `require`), re-exports, direct
`doGenerate` / `doStream` access, Jev `decide` calls outside `decide.ts`
(including element access such as `client["decide"]` and a dynamically
imported client), and image-backend or dispatcher calls outside their allowed
sites (including dynamic `import()` destructuring and namespace string-element
calls).

**Scope:** models running inside external MCP servers are separate services
and are not covered.

## Watch-intent interpreter (`POST /api/watch-intent`)

This is a fixed-purpose seam for the conversational shared-watch coordinator.

- **Off by default.** It only turns on when
  `SPORTSCLAW_WATCH_INTENT_ENABLED=true` (exactly that value). Any other
  value returns `{"contract":"watch-intent-v1","ok":false,"reasonCode":"disabled"}`.
- **Request order:** the `X-Auth-Token` check runs before the flag check, the
  body read or a concurrency slot. Then come the bounded body (32 KiB), a 5 s
  read deadline, the relay's shared `active_queries` limit, and a 12 s
  process backstop around an 8 s model deadline. Every response is
  `no-store`, and nothing from the request is logged.
- **Request keys:** exactly `contract`, `text`, `locale` and `eligible`.
  Anything else, including provider/model/endpoint/tools/history/identity,
  is refused, as is a non-string `locale`. The relay forwards the body as
  compact UTF-8 JSON (no `\uXXXX` expansion) and enforces the 32 KiB cap on
  those forwarded bytes too, so anything it dispatches fits the worker's cap.
- **Model call:** the worker (`dist/watch-intent-relay.js`) makes one
  fixed-prompt `generate` call with no tools, no history and
  `maxRetries: 0`, then parses the reply strictly. A target ID must come from
  the candidate list that fits the action: follow → takes; pause → active
  subscriptions; resume → paused subscriptions; unfollow → any listed
  subscription.
- **Model selection:** the provider and model come only from the server
  environment object that `createServerModel(env)` receives. The worker passes
  `process.env`; tests pass an explicit object, and nothing else is read.
  - With `SPORTSCLAW_WATCH_INTENT_NATIVE_CONFIG` set, the worker uses a native
    route. The value is the existing `ModelRoleRouteConfig` JSON, with
    `route` set to `nim` or `openshell` and `model` required. Example:
    `{"route":"openshell","model":"nvidia/…","baseUrl":"https://…/v1","credentialEnv":"NVIDIA_API_KEY"}`.
    It is checked by the same route validator and `resolveNativeRoleEndpoint`
    that `invokeModelRole` uses:
    - OpenShell requires `OPENSHELL_SANDBOX=1` and reads the profile
      credential from the workload environment, never from hydrated config.
      It sends traffic over the isolated transport.
    - NIM uses the explicit `baseUrl`, falling back to `NIM_BASE_URL` /
      `OPENAI_BASE_URL` from the same environment.
    - Invalid JSON, unknown keys, another route, a missing sandbox or a
      missing credential make the request fail closed with
      `inference_unavailable`. No direct or cloud client is ever created as a
      fallback.
  - With it unset, the worker keeps the direct path: `SPORTSCLAW_PROVIDER` /
    `SPORTSCLAW_MODEL` through the existing provider resolver.
  - The request JSON can never choose a route, endpoint, model or schema.
- **Responsibility:** the interpreter proposes an intent but never grants
  consent. Confirmation and persistence belong to the bridge coordinator.
