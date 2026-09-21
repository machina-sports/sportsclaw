/**
 * stdin → stdout decision worker.
 *
 * One process, one bounded decision. It reads a `{ state, questions }` body on
 * stdin, hands it to `JevDecisionClient` and writes exactly one serialized
 * `DecisionResult` on stdout. Nothing else happens: no engine, no CLI, no MCP,
 * no memory, no generative model, no listener. This module imports the decision
 * client and Node stdlib and nothing more, so the import graph cannot pull one
 * of those in behind it.
 *
 * Everything the caller does not own is fixed here, server side: the endpoint
 * is the client's, the model is the pinned default, the deadline is fixed, and
 * cloud consent comes from a dedicated environment variable rather than from
 * the body. A request carrying anything besides `state` and `questions` is
 * refused before dispatch.
 *
 * Output is always a typed, sanitized result — never a raw error, never an echo
 * of the input, never a credential.
 */

import { pathToFileURL } from "node:url";

import {
  DEFAULT_JEV_MODEL,
  JevDecisionClient,
  type DecisionFailure,
  type DecisionReasonCode,
  type DecisionRequest,
  type DecisionResult,
  type DecisionTransport,
} from "./decision-client.js";

/** Bytes accepted on stdin. Smaller than the client's own request bound. */
export const MAX_RELAY_BODY_BYTES = 32 * 1024;

/** Fixed per-request deadline. Callers cannot lengthen or shorten it. */
export const RELAY_TIMEOUT_MS = 8_000;

/** The one environment variable that grants cloud egress. */
export const DATA_POLICY_ENV = "SPORTSCLAW_DECISION_DATA_POLICY";

type Env = Record<string, string | undefined>;

/**
 * A refusal that never reached the client, shaped exactly like one that did so
 * the caller has a single result type to inspect.
 */
function refuse(reasonCode: DecisionReasonCode, latencyMs: number): DecisionFailure {
  return {
    ok: false,
    reasonCode,
    receipt: {
      provider: "jev",
      status: "blocked",
      reasonCode,
      requestedModel: DEFAULT_JEV_MODEL,
      latencyMs,
      questionCount: 0,
      kindCounts: { choice: 0, score: 0, noul: 0 },
    },
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Exactly `state` and `questions`, both present. Transport, provider, model,
 * credential, data policy and deadline are server configuration; a body that
 * tries to carry one of them is refused rather than silently ignored.
 */
function parseBody(raw: string): DecisionRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("invalid");
  }
  if (!isPlainObject(parsed)) throw new Error("invalid");
  const keys = Object.keys(parsed);
  if (keys.length !== 2 || !keys.includes("state") || !keys.includes("questions")) {
    throw new Error("invalid");
  }
  return parsed as unknown as DecisionRequest;
}

/**
 * Consent is read from its own variable and nothing else. An unset variable is
 * `local_only`; a value that is neither recognized spelling fails closed rather
 * than being coerced into the permissive one.
 */
function readDataPolicy(env: Env): "local_only" | "cloud_allowed" | "invalid" {
  const raw = env[DATA_POLICY_ENV];
  if (raw === undefined || raw === "") return "local_only";
  if (raw === "cloud_allowed" || raw === "local_only") return raw;
  return "invalid";
}

export interface DecisionWorkerOptions {
  /** Environment source. Defaults to `process.env`. Never mutated. */
  env?: Env;
  /** Injected for offline tests; production always uses global fetch. */
  transport?: DecisionTransport;
  abortSignal?: AbortSignal;
}

/**
 * Run one decision over an already-read body. Never throws and never returns
 * anything but a typed result.
 */
export async function runDecision(
  body: string,
  options: DecisionWorkerOptions = {}
): Promise<DecisionResult> {
  const startedAt = Date.now();
  const env = options.env ?? process.env;
  const elapsed = () => Date.now() - startedAt;

  if (options.abortSignal?.aborted) return refuse("aborted", elapsed());
  if (typeof body !== "string") return refuse("invalid_request", elapsed());
  if (Buffer.byteLength(body, "utf8") > MAX_RELAY_BODY_BYTES) {
    return refuse("request_too_large", elapsed());
  }

  const dataPolicy = readDataPolicy(env);
  if (dataPolicy === "invalid") return refuse("local_only", elapsed());

  let request: DecisionRequest;
  try {
    request = parseBody(body);
  } catch {
    return refuse("invalid_request", elapsed());
  }

  try {
    const client = new JevDecisionClient({
      dataPolicy,
      model: DEFAULT_JEV_MODEL,
      timeoutMs: RELAY_TIMEOUT_MS,
      transport: options.transport,
      // Only the decision credential is visible to the client: no other
      // provider key in this process's environment can be forwarded.
      env: Object.defineProperty({}, "TYPESAFE_API_KEY", {
        get: () => env.TYPESAFE_API_KEY,
      }),
    });
    const result = await client.decide(request, { abortSignal: options.abortSignal });
    return options.abortSignal?.aborted ? refuse("aborted", elapsed()) : result;
  } catch {
    // The client documents that it never throws; if that ever changes, the
    // caller still gets a sanitized result rather than an Error string.
    return refuse("invalid_request", elapsed());
  }
}

/** Read stdin with a hard byte cap, so an oversized body is never buffered. */
async function readStdin(): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const buffer = chunk as Buffer;
    total += buffer.byteLength;
    if (total > MAX_RELAY_BODY_BYTES) return undefined;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  let result: DecisionResult;
  try {
    const body = await readStdin();
    result =
      body === undefined
        ? refuse("request_too_large", Date.now() - startedAt)
        : await runDecision(body);
  } catch {
    result = refuse("invalid_request", Date.now() - startedAt);
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

// Importing this module for tests must not consume stdin or emit a result.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
