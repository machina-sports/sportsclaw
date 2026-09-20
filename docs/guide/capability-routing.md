# Capability routing

`CapabilityRouter` is a generic, typed routing primitive built on `JevDecisionClient`.
The opt-in SportsClaw adapter uses it **instead of** the generative skill-router call.
It does not execute tools, authorize actions, build tool arguments, or generate answers.

## Standalone SDK

```ts
import { CapabilityRouter } from "sportsclaw-engine-core";

const router = new CapabilityRouter({
  provider: "jev",
  dataPolicy: "cloud_allowed",
  maxSelected: 3,
});
const outcome = await router.route({
  prompt: "Compare the game results with market prices",
  candidates: [
    { id: "scores", description: "Read recorded game results." },
    { id: "markets", description: "Read timestamped market prices." },
  ],
}, { abortSignal });

if (outcome.status === "selected") {
  // Still validate permission and tool arguments before executing anything.
  console.log(outcome.selectedIds);
}
```

The standalone default is `provider: "deterministic"`, `dataPolicy: "local_only"`.
Importing or using the primitive needs no generative-model key and initializes no engine.
A trusted embedding may supply `deterministicSelectedIds` as a **complete rule result**.
Valid rule selections return without credential lookup or network access. Without such a
result, the deterministic provider returns clarification rather than guessing.

### Outcomes

- `selected`: validated caller IDs, in catalog order.
- `clarify`: ambiguity, low confidence/margin, unknown requirements, an empty model-selected
  set, or too many selected capabilities. No arbitrary truncation.
- `unsupported`: an empty eligible catalog or a confident unsupported disposition.
- `unavailable`: invalid input, withheld cloud consent, missing credentials, authentication
  failure, timeout, cancellation or malformed response. Never disguised as unsupported.

Outcomes carry bounded reason codes and a source. A model response may also supply its
actual model and metrics. On an uncertain capability, metrics describe that capability's
answer. On successful selection, confidence and margin are the minima across evaluated
judgments, **not a calibrated joint probability**. Rule outcomes have no model confidence.

### Bounds and validation

Prompt and optional `recentContext`: at most 4,000 characters each. Catalog: at most 30
capabilities, each with a distinct 1–64 character ID and a 1–500 character description.
IDs are preserved, not trimmed or case-folded. Invalid and oversized inputs fail before
credential lookup; no catalog is silently truncated. Input snapshots prevent mutation during
an asynchronous call from changing the mapping or result.

The generic config accepts `provider`, `dataPolicy`, pinned `model` (default `jev-1.13.0`),
`timeoutMs` (250–60,000; default 8,000), `confidenceThreshold` (0.5–1; default 0.9),
`marginThreshold` (0–1; default 0.15), `maxSelected` (1–30; default 3), `transport` and `env`.
Invalid generic constructor settings throw. There is **no fallback setting and no retry**.

### Selection policy

Jev receives one batch: a disposition Choice and one include/exclude/unknown Choice per
candidate. Questions use opaque catalog references (`c0`, `c1`, etc.). The caller's ID is
not automatically encoded as a question identifier; descriptions and explicitly supplied
context are sent as content. Descriptions may themselves contain names or identifiers,
so opaque references are not a general anonymization guarantee.

Every question shares a policy: choose a coordinated minimal sufficient set covering the
whole request; include complementary capabilities; for interchangeable alternatives, prefer
the earliest catalog entry unless the request explicitly prefers another. `required` means
inclusion in that set, not individual indispensability among all possible alternatives.

Independent judgments do not guarantee a logically consistent or semantically correct set.
Synthetic tests verify encoding and handling, not real model accuracy. Empty, uncertain and
over-cap selections abstain. Thresholds are policy defaults requiring evaluation.

## Opt-in skill routing

Existing SportsClaw behavior is unchanged when routing is unset. The engine default remains
the **generative router**, distinct from the standalone primitive's deterministic default.

Pass routing settings to an existing engine configuration:

```ts
import type { SkillRoutingConfig } from "sportsclaw-engine-core";

const routing: SkillRoutingConfig = {
  provider: "jev",
  dataPolicy: "cloud_allowed",
  maxSelected: 3,
  includeRecentContext: false,
};
```

CLI/environment opt-in:

```sh
export SPORTSCLAW_ROUTING_PROVIDER=jev
export SPORTSCLAW_ROUTING_DATA_POLICY=cloud_allowed
# Supply TYPESAFE_API_KEY through your existing secret mechanism.
```

Explicit config wins over environment. `provider: "generative"` retains the old path.
The skill adapter also accepts the model, timeout, confidence/margin, transport and env
settings listed above. Invalid settings are reported as unavailable, not silently sent to
another provider. `includeRecentContext` defaults to false; it has no environment shortcut.

The adapter:

1. Retains the existing MCP routing exception.
2. Uses a conservative whole-request fast path for simple requests such as `NBA scores`
   or `NBA and NFL standings today`. Merely mentioning a sport in a longer request is not
   enough. Complete rule matches make no Jev or generative-router call.
3. Otherwise supplies the installed capability catalog to one Jev request. Descriptions
   contain skill/operation names, not argument schemas, credentials or memory documents.
4. Validates the returned IDs, preserves multi-skill selections, and unions installed
   deterministic helper skills only within the configured cap. Over-cap unions clarify.
5. Carries distinct outcomes through `RouteMeta.routing`. A non-selected outcome returns a
   fixed response from the engine **before history-tool widening or main/parallel generation**.
   Follow-ups and yolo mode do not override this stop.
6. On successful routes, retains the existing tool-history and provider-ceiling behavior.

Raw fan-profile/memory blocks never enter this adapter's Jev request. Recent conversation
text is sent only with explicit `includeRecentContext: true`. This controls routing egress,
not the engine's independent memory backend or the normal answer-generation policy.

Legacy `llmAttempted/llmSucceeded` remain false for decision routing; Jev is not a generative
router call. Typed routing metadata contains outcome codes, source, model and metrics,
not prompt text or answers. Legacy `RouteDecision.confidence` retains a compatibility value
for rule routes; the new metadata does not present it as measured model confidence.

## Cancellation and transport contract

Cancellation is checked before deterministic routing and after awaiting the decision client.
A valid response arriving after caller cancellation cannot become a selection. Default fetch
honors the client's timeout/AbortSignal. Injected transports must also honor AbortSignal for
in-flight deadlines; the router cannot terminate arbitrary caller-provided code.

## Verification and remaining scope

Tests use synthetic data and mocked transports. They cover default compatibility, one-call
multi-selection, rule shortcuts, admission failures, cancellation, catalog ordering, input
mutation, privacy, and typed outcomes. The actual engine `run()` refusal path is exercised
with isolated MCP/tool-construction fixtures across follow-up and yolo combinations.

No live Jev accuracy, matched latency/cost benchmark, relay HTTP decision endpoint, source
argument resolver, downstream application integration, default activation, or deployment is
included. A routing decision is not evidence that the selected tool succeeded.
