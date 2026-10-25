/**
 * Unified inference boundary — the one place runtime code executes a model.
 *
 *   generate(ctx, params)  → the SDK's generateText, same params/result/errors
 *   stream(ctx, params)    → the SDK's streamText, returned synchronously
 *   image(ctx, provider, prompt, …) → the native image dispatcher
 *
 * Callers keep constructing provider clients (`resolveModel`, native NIM /
 * OpenShell endpoints) and keep every call-specific option; this module only
 * adds a per-call sanitized receipt. SDK generics are preserved by wrapping
 * the SDK functions themselves (higher-order inference keeps their type
 * parameters). Original result objects and error instances pass through by
 * identity; a throwing or rejecting observer can never mask either. Streams are
 * never drained here and report exactly once, at real completion, failure or
 * abort — including synchronous construction errors, an error finish, a failed
 * caller onFinish and stream errors that reach no SDK callback.
 *
 * An AST guard (test/inference-boundary-guard.test.mjs) keeps runtime callers
 * from importing the SDK's execution functions anywhere else.
 */

import { APICallError, generateText, streamText, type Output, type ToolSet } from "ai";

import type { GeneratedImage, LLMProvider } from "../types.js";
import { generateImageForProvider } from "./image-gen.js";
import {
  emitReceipt,
  routeOf,
  safeModelId,
  type InferenceContext,
  type InferenceErrorCode,
  type InferenceReceipt,
  type InferenceStatus,
} from "./receipt.js";

export {
  INFERENCE_ERROR_CODES,
  type InferenceContext,
  type InferenceErrorCode,
  type InferenceKind,
  type InferenceReceipt,
  type InferenceRouteLabel,
  type InferenceStatus,
} from "./receipt.js";

type LooseParams = {
  model?: unknown;
  abortSignal?: AbortSignal;
  onFinish?: (event: never) => unknown;
  onError?: (event: { error: unknown }) => unknown;
  onAbort?: (event: never) => unknown;
  prepareStep?: (options: never) => unknown;
};

function modelIdOf(model: unknown): string | undefined {
  if (typeof model === "string") return safeModelId(model);
  if (model && typeof model === "object") return safeModelId((model as { modelId?: unknown }).modelId);
  return undefined;
}

function usageOf(usage: unknown): InferenceReceipt["usage"] {
  if (!usage || typeof usage !== "object") return undefined;
  const u = usage as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const out = { inputTokens: n(u.inputTokens), outputTokens: n(u.outputTokens), totalTokens: n(u.totalTokens) };
  return out.inputTokens === undefined && out.outputTokens === undefined && out.totalTokens === undefined
    ? undefined
    : out;
}

const INVALID_RESPONSE_ERRORS = new Set([
  "AI_NoObjectGeneratedError",
  "AI_NoOutputGeneratedError",
  "AI_InvalidResponseDataError",
  "AI_JSONParseError",
  "AI_TypeValidationError",
  "AI_NoContentGeneratedError",
  "AI_InvalidToolInputError",
  "AI_NoSuchToolError",
]);

/** Map an error to the closed enum. Names are only compared, never emitted. */
function classify(err: unknown, signal?: AbortSignal, depth = 0): { status: InferenceStatus; errorCode: InferenceErrorCode } {
  if (signal?.aborted) {
    const reason = signal.reason as { name?: unknown } | undefined;
    return reason?.name === "TimeoutError"
      ? { status: "failed", errorCode: "timeout" }
      : { status: "aborted", errorCode: "aborted" };
  }
  if (APICallError.isInstance(err)) {
    const code = err.statusCode;
    if (code === 429) return { status: "failed", errorCode: "rate_limited" };
    if (code === 401 || code === 403) return { status: "failed", errorCode: "auth" };
    return { status: "failed", errorCode: "provider_error" };
  }
  const name = err && typeof err === "object" ? (err as { name?: unknown }).name : undefined;
  if (name === "AI_RetryError" && depth < 3) {
    return classify((err as { lastError?: unknown }).lastError, undefined, depth + 1);
  }
  if (name === "AbortError") return { status: "aborted", errorCode: "aborted" };
  if (name === "TimeoutError") return { status: "failed", errorCode: "timeout" };
  if (typeof name === "string" && INVALID_RESPONSE_ERRORS.has(name)) {
    return { status: "failed", errorCode: "invalid_response" };
  }
  if (name === "AI_InvalidArgumentError" || name === "AI_InvalidPromptError") {
    return { status: "failed", errorCode: "invalid_request" };
  }
  if (err instanceof TypeError) return { status: "failed", errorCode: "network" };
  return { status: "failed", errorCode: "unknown" };
}

/** Receipt fields for a call whose model finished with finishReason "error". */
const ERROR_FINISH = { status: "failed", errorCode: "provider_error" } as const;

/**
 * Pass-through over `source` that observes a reader error. It is lazy
 * (highWaterMark 0: it reads only when its consumer pulls), forwards
 * cancellation and rethrows the original error unchanged.
 */
function observeReader<T>(source: ReadableStream<T>, onReaderError: (err: unknown) => void): ReadableStream<T> {
  const reader = source.getReader();
  return new ReadableStream<T>(
    {
      async pull(controller) {
        const next = await reader.read().catch((err: unknown) => {
          onReaderError(err);
          throw err;
        });
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );
}

/**
 * The caller's language model with only the public protocol method
 * `doStream` intercepted (LanguageModelV2/V3: `doStream(options)` resolves to
 * `{ stream, ... }`). The returned `stream` passes through `observeReader`, so
 * an error raised by the model's own stream (`controller.error`) — which the
 * SDK turns into a stream error without calling onError — is observed when
 * the SDK's own read meets it. The SDK reads provider streams eagerly, so
 * that can be before the caller consumes; the observer adds no reads.
 *
 * Same shape as the SDK's own v2→v3 adapter: a `get` trap reading everything
 * else (ids, supportedUrls, doGenerate, provider fields) from the original.
 * Returned unchanged, and therefore not observed: string model ids (resolved
 * by the SDK's global provider) and objects whose `doStream` is missing or a
 * frozen own property a Proxy may not redefine.
 */
function withStreamObserver(model: unknown, onReaderError: (err: unknown) => void): unknown {
  if (!model || typeof model !== "object") return model;
  const target = model as { doStream?: unknown };
  if (typeof target.doStream !== "function") return model;
  const own = Object.getOwnPropertyDescriptor(target, "doStream");
  if (own && !own.configurable && own.writable === false) return model;
  const doStream = async (...callArgs: unknown[]) => {
    const result: unknown = await (target.doStream as (...a: unknown[]) => Promise<unknown>).apply(target, callArgs);
    const source = (result as { stream?: unknown } | undefined)?.stream;
    if (!(source instanceof ReadableStream)) return result;
    return { ...(result as object), stream: observeReader(source, onReaderError) };
  };
  return new Proxy(target, {
    get(t, prop) {
      return prop === "doStream" ? doStream : Reflect.get(t, prop, t);
    },
  });
}

/** Wrap a promise-returning SDK function; generics of `fn` are preserved. */
function boundGenerate<A extends unknown[], R>(fn: (...args: A) => R): (ctx: InferenceContext, ...args: A) => R {
  return (ctx, ...args) => {
    const params = (args[0] ?? {}) as LooseParams;
    const base = { kind: "generate" as const, purpose: ctx.purpose, route: routeOf(ctx), modelId: modelIdOf(params.model) };
    const startedAt = Date.now();
    const run = async () => {
      let result: unknown;
      try {
        result = await (fn(...args) as unknown as Promise<unknown>);
      } catch (err) {
        emitReceipt(ctx, { ...base, ...classify(err, params.abortSignal), latencyMs: Date.now() - startedAt });
        throw err;
      }
      const r = result as { finishReason?: unknown; totalUsage?: unknown; usage?: unknown; steps?: unknown[] };
      emitReceipt(ctx, {
        ...base,
        // The result is returned unchanged; an explicit error finish is still a failure.
        ...(r.finishReason === "error" ? ERROR_FINISH : { status: "completed" as const }),
        latencyMs: Date.now() - startedAt,
        ...(typeof r.finishReason === "string" ? { finishReason: r.finishReason } : {}),
        usage: usageOf(r.totalUsage ?? r.usage),
        ...(Array.isArray(r.steps) ? { steps: r.steps.length } : {}),
      });
      return result;
    };
    return run() as unknown as R;
  };
}

/**
 * Wrap a synchronous stream-returning SDK function via its lifecycle
 * callbacks, a synchronous-throw guard and — for the installed SDK — a
 * protocol-level observer on every model it streams from (the call's model
 * and any `prepareStep` model override).
 */
function boundStream<A extends unknown[], R>(
  fn: (...args: A) => R,
  observeModels: boolean,
): (ctx: InferenceContext, ...args: A) => R {
  return (ctx, ...args) => {
    const params = (args[0] ?? {}) as LooseParams;
    const base = { kind: "stream" as const, purpose: ctx.purpose, route: routeOf(ctx), modelId: modelIdOf(params.model) };
    const startedAt = Date.now();
    let reported = false;
    const report = (fields: Partial<InferenceReceipt> & { status: InferenceStatus }) => {
      if (reported) return;
      reported = true;
      emitReceipt(ctx, { ...base, ...fields, latencyMs: Date.now() - startedAt });
    };
    // A caller abort that reaches the model stream is turned by the SDK into
    // onAbort, which reports after the caller's handler; anything else that
    // errors the model's stream reaches no SDK callback and is reported here.
    const onReaderError = (err: unknown) => {
      if (params.abortSignal?.aborted && isAbortLike(err)) return;
      report(classify(err, params.abortSignal));
    };
    const observe = (model: unknown) => withStreamObserver(model, onReaderError);
    const prepareStep = params.prepareStep;
    const observed = observeModels
      ? {
          model: observe(params.model),
          ...(typeof prepareStep === "function"
            ? {
                prepareStep: async (options: unknown) => {
                  const step = (await prepareStep(options as never)) as { model?: unknown } | undefined | null;
                  return step && typeof step === "object" && step.model !== undefined
                    ? { ...step, model: observe(step.model) }
                    : step;
                },
              }
            : {}),
        }
      : {};
    const wrapped = {
      ...params,
      ...observed,
      onFinish: async (event: { finishReason?: unknown; totalUsage?: unknown; usage?: unknown; steps?: unknown[] }) => {
        const finished = {
          ...(typeof event?.finishReason === "string" ? { finishReason: event.finishReason } : {}),
          usage: usageOf(event?.totalUsage ?? event?.usage),
          ...(Array.isArray(event?.steps) ? { steps: event.steps.length } : {}),
        };
        try {
          await params.onFinish?.(event as never);
        } catch (err) {
          // The SDK errors the stream with the caller's own error; the call
          // did not complete, so it is never reported as completed.
          report({ status: "failed", errorCode: "unknown", ...finished });
          throw err;
        }
        report({ ...(event?.finishReason === "error" ? ERROR_FINISH : { status: "completed" as const }), ...finished });
      },
      onError: async (event: { error: unknown }) => {
        const outcome = classify(event?.error, params.abortSignal);
        try {
          // An explicit caller handler receives the original error. Without
          // one, log only the closed error code — never provider content.
          if (params.onError) await params.onError(event);
          else console.error(`[inference] stream ${outcome.status} (${outcome.errorCode})`);
        } finally {
          report(outcome);
        }
      },
      onAbort: async (event: unknown) => {
        try {
          await params.onAbort?.(event as never);
        } finally {
          report({ status: "aborted", errorCode: "aborted" });
        }
      },
    };
    try {
      return fn(...([wrapped, ...args.slice(1)] as unknown as A));
    } catch (err) {
      // Synchronous construction errors (e.g. invalid maxRetries) reach no
      // lifecycle callback: report once and rethrow the original error.
      report(classify(err, params.abortSignal));
      throw err;
    }
  };
}

/** Error names the SDK treats as an abort (its `isAbortError`). */
function isAbortLike(err: unknown): boolean {
  const name = err && typeof err === "object" ? (err as { name?: unknown }).name : undefined;
  return name === "AbortError" || name === "ResponseAborted" || name === "TimeoutError";
}

/**
 * `generateText` through the boundary. Same params, result object and errors.
 * `impl` is an optional trusted, code-supplied SDK-compatible implementation
 * (e.g. a test double); it still runs inside the receipt boundary.
 */
export function generate<TOOLS extends ToolSet = {}, OUTPUT extends Output.Output = Output.Output<string, string>>(
  ctx: InferenceContext,
  params: Parameters<typeof generateText<TOOLS, OUTPUT>>[0],
  impl?: typeof generateText<TOOLS, OUTPUT>,
): ReturnType<typeof generateText<TOOLS, OUTPUT>> {
  return boundGenerate(impl ?? generateText<TOOLS, OUTPUT>)(ctx, params);
}

/**
 * `streamText` through the boundary. Returns the SDK result synchronously.
 * `impl` is an optional trusted SDK-compatible implementation; its lifecycle
 * callbacks are wrapped exactly like the SDK's.
 */
export function stream<TOOLS extends ToolSet = {}, OUTPUT extends Output.Output = Output.Output<string, string, never>>(
  ctx: InferenceContext,
  params: Parameters<typeof streamText<TOOLS, OUTPUT>>[0],
  impl?: typeof streamText<TOOLS, OUTPUT>,
): ReturnType<typeof streamText<TOOLS, OUTPUT>> {
  // An injected impl receives the caller's params (models included) as given.
  return boundStream(impl ?? streamText<TOOLS, OUTPUT>, impl === undefined)(ctx, params);
}

/** Native image generation through the boundary. Errors are rethrown unchanged. */
export async function image(
  ctx: InferenceContext,
  provider: LLMProvider,
  prompt: string,
  size?: string,
  aspectRatio?: string,
  model?: string,
  abortSignal?: AbortSignal,
): Promise<GeneratedImage> {
  const base = { kind: "image" as const, purpose: ctx.purpose, route: routeOf(ctx) };
  const startedAt = Date.now();
  try {
    const generated = await generateImageForProvider(provider, prompt, size, aspectRatio, model, abortSignal);
    emitReceipt(ctx, { ...base, modelId: safeModelId(generated.model), status: "completed", latencyMs: Date.now() - startedAt });
    return generated;
  } catch (err) {
    const outcome = classify(err, abortSignal);
    // Provider bodies live in the error message; only the enum is recorded.
    emitReceipt(ctx, {
      ...base,
      ...outcome,
      errorCode: outcome.errorCode === "unknown" ? "provider_error" : outcome.errorCode,
      latencyMs: Date.now() - startedAt,
    });
    throw err;
  }
}
