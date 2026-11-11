/**
 * sportsclaw — speech: text in, WAV audio out, on a route chosen in config.
 *
 * The `voice` model role writes narration. This speaks it. Speech is configured beside
 * the roles as `inference.speech` and uses the same routes:
 *
 *   - `nim`  — a speech server you run (for example NVIDIA's Magpie TTS NIM). Keyless.
 *   - `api`  — a hosted speech service that needs a key. The config names the environment
 *              variable holding it (`credentialEnv`); HTTPS is required unless on loopback.
 *   - `mock` — a short silent WAV, no network. For tests and CI.
 *
 * `format` names the service's request shape, so changing provider is a config edit:
 *
 *   - `riva`   — NVIDIA Riva / Magpie TTS: a form POST to `<baseUrl>/audio/synthesize`
 *                with `text`, `voice`, `language`.
 *   - `openai` — OpenAI's `<baseUrl>/audio/speech` and the services and local servers
 *                that copy it: JSON with `model`, `input`, `voice`.
 *
 * The result is always WAV: it is what Riva returns and what this asks an OpenAI-style
 * service for, so callers handle one format. Another service is one more entry in WIRES.
 */

import { ENV_NAME, LOOPBACK_HOSTS, USABLE_KEY } from "./endpoint-rules.js";
import type { ModelRoleRouterConfig } from "./model-role-router.js";
import { emitReceipt, safeModelId, type InferenceErrorCode, type InferenceReceipt } from "./receipt.js";

export const SPEECH_ROUTES = ["nim", "api", "mock"] as const;
export type SpeechRoute = (typeof SPEECH_ROUTES)[number];

export const SPEECH_FORMATS = ["riva", "openai"] as const;
export type SpeechFormat = (typeof SPEECH_FORMATS)[number];

export const SPEECH_LIMITS = {
  /** Characters in one call. Longer text is refused, never cut: split it into lines. */
  maxTextChars: 4_096,
  /** Bytes of audio accepted from a service. */
  maxAudioBytes: 64 * 1024 * 1024,
  defaultTimeoutMs: 60_000,
} as const;

export interface SpeechRouteConfig {
  route: SpeechRoute;
  /** The service's request shape. Required unless the route is `mock`. */
  format?: SpeechFormat;
  /** Default voice, as the service names it ("Magpie-Multilingual.EN-US.Jason", "alloy"). */
  voice: string;
  /** Model id. Required by the `openai` format; `riva` servers serve one model and are not sent it. */
  model?: string;
  /** Language code for the `riva` format. Default "en-US". */
  language?: string;
  /** Endpoint base URL including its version prefix, e.g. "http://127.0.0.1:9000/v1". */
  baseUrl?: string;
  /** `api` route: the NAME of the environment variable that holds the key, never the key. */
  credentialEnv?: string;
  timeoutMs?: number;
}

const SPEECH_KEYS: readonly string[] = ["route", "format", "voice", "model", "language", "baseUrl", "credentialEnv", "timeoutMs"];

interface SpeechWire {
  path: string;
  needsModel: boolean;
  request(call: { text: string; voice: string; language: string; model?: string }): { headers?: Record<string, string>; body: BodyInit };
}

const WIRES: Record<SpeechFormat, SpeechWire> = {
  riva: {
    path: "/audio/synthesize",
    needsModel: false,
    request({ text, voice, language }) {
      const form = new FormData();
      form.append("language", language);
      form.append("voice", voice);
      form.append("text", text);
      return { body: form };
    },
  },
  openai: {
    path: "/audio/speech",
    needsModel: true,
    request: ({ text, voice, model }) => ({
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, input: text, voice, response_format: "wav" }),
    }),
  },
};

const isText = (value: unknown): value is string => typeof value === "string" && value !== "";

/** What is wrong with an `inference.speech` entry, or undefined when it is usable. */
export function speechConfigIssue(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "Speech config must be an object with a route.";
  const c = value as Record<string, unknown>;
  const unknown = Object.keys(c).filter((key) => !SPEECH_KEYS.includes(key));
  if (unknown.length > 0) {
    return `Speech config has no ${unknown.join(", ")}: it takes ${SPEECH_KEYS.join(", ")}, and a key comes from the environment.`;
  }
  if (!(SPEECH_ROUTES as readonly unknown[]).includes(c.route)) return `Speech route must be one of ${SPEECH_ROUTES.join(", ")}.`;
  if (!isText(c.voice)) return "Speech config needs a voice.";
  if (c.language !== undefined && !isText(c.language)) return "Speech language must be a language code such as en-US.";
  if (c.timeoutMs !== undefined && (typeof c.timeoutMs !== "number" || !Number.isInteger(c.timeoutMs) || c.timeoutMs <= 0)) {
    return "Speech timeoutMs must be a positive integer.";
  }
  if (c.route === "mock") return undefined;

  if (!(SPEECH_FORMATS as readonly unknown[]).includes(c.format)) return `Speech format must be one of ${SPEECH_FORMATS.join(", ")}.`;
  if (WIRES[c.format as SpeechFormat].needsModel ? !isText(c.model) : c.model !== undefined && !isText(c.model)) {
    return `Speech format "${String(c.format)}" needs a model.`;
  }
  let url: URL;
  try {
    url = new URL(c.baseUrl as string);
  } catch {
    return "Speech config needs a baseUrl, including its version prefix (for example http://127.0.0.1:9000/v1).";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "Speech baseUrl must be http(s).";
  if (c.route === "api") {
    if (typeof c.credentialEnv !== "string" || !ENV_NAME.test(c.credentialEnv)) {
      return "Speech credentialEnv must be the name of an environment variable that holds the key (for example OPENAI_API_KEY), never the key itself.";
    }
    // A key travels with every request on this route: plain HTTP only to this machine.
    if (url.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname)) return 'Speech route "api" baseUrl must be https, except on loopback.';
  } else if (c.credentialEnv !== undefined) {
    return 'Speech credentialEnv applies only to route "api".';
  }
  return undefined;
}

export interface SpeechTrace {
  route: SpeechRoute;
  format?: SpeechFormat;
  model?: string;
  voice: string;
  startedAt: string;
  endedAt: string;
  latencyMs: number;
  /** Only `completed` carries audio. */
  status: "completed" | "failed" | "timed_out" | "cancelled";
  error?: string;
  /** Characters of text sent. */
  characters: number;
  audioBytes?: number;
}

export interface SpeechResult {
  /** A complete WAV file. */
  audio: Uint8Array;
  mimeType: "audio/wav";
  durationMs: number;
  trace: SpeechTrace;
}

/** A speech call that reached its route and failed there. Carries the trace, never the service's text. */
export class SpeechRouteError extends Error {
  readonly trace: SpeechTrace;
  constructor(message: string, trace: SpeechTrace) {
    super(message);
    this.name = "SpeechRouteError";
    this.trace = trace;
  }
}

export interface SynthesizeSpeechArgs {
  /** What to say. Apply `speechText()` first when it may contain markup. */
  text: string;
  /** The inference config; its `speech` entry is the route. */
  config: ModelRoleRouterConfig;
  /** Voice for this call, when it differs from the configured one (a second speaker, an emotion). */
  voice?: string;
  /** Language for this call (`riva` format). */
  language?: string;
  abortSignal?: AbortSignal;
  /** Per-call sanitized receipt observer (no text, voice or endpoint). */
  onReceipt?: (receipt: InferenceReceipt) => void;
  /** Environment for the key lookup. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
}

/** The length of a WAV file's audio, or undefined when the bytes are not a WAV file. */
function wavDurationMs(audio: Uint8Array): number | undefined {
  const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength);
  const tag = (at: number): string => String.fromCharCode(...audio.subarray(at, at + 4));
  if (audio.byteLength < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") return undefined;
  let byteRate: number | undefined;
  for (let at = 12; at + 8 <= audio.byteLength; ) {
    const id = tag(at);
    const size = view.getUint32(at + 4, true);
    if (id === "fmt " && at + 20 <= audio.byteLength) byteRate = view.getUint32(at + 16, true);
    if (id === "data") {
      if (!byteRate) return undefined;
      // A streamed WAV may state a placeholder size; the audio is what actually arrived.
      const bytes = Math.min(size, audio.byteLength - at - 8);
      return Math.round((bytes / byteRate) * 1000);
    }
    at += 8 + size + (size % 2);
  }
  return undefined;
}

/** A tenth of a second of silence: mono, 16-bit, 22.05 kHz. */
function mockWav(): Uint8Array {
  const rate = 22_050;
  const dataBytes = Math.round(rate / 10) * 2;
  const audio = new Uint8Array(44 + dataBytes);
  const view = new DataView(audio.buffer);
  const write = (at: number, text: string): void => {
    for (let i = 0; i < text.length; i++) audio[at + i] = text.charCodeAt(i);
  };
  write(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  write(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, dataBytes, true);
  return audio;
}

class SpeechFailure extends Error {
  constructor(message: string, readonly code: InferenceErrorCode) {
    super(message);
  }
}

/** Say `text` on the configured speech route. Returns a WAV file, or throws. */
export async function synthesizeSpeech(args: SynthesizeSpeechArgs): Promise<SpeechResult> {
  const speech = args.config?.speech;
  if (!speech) throw new Error("No speech route configured — add inference.speech to the router config.");
  const issue = speechConfigIssue(speech);
  if (issue) throw new Error(`Invalid inference.speech: ${issue}`);
  const { text } = args;
  if (typeof text !== "string" || text.trim() === "") throw new Error("Speech needs text to say.");
  if (text.length > SPEECH_LIMITS.maxTextChars) {
    throw new Error(`Speech text is too long: ${text.length} characters, limit ${SPEECH_LIMITS.maxTextChars}. Split it into lines.`);
  }

  const voice = args.voice ?? speech.voice;
  const startedAtMs = Date.now();
  const trace = (status: SpeechTrace["status"], error?: string, audioBytes?: number): SpeechTrace => ({
    route: speech.route,
    ...(speech.format ? { format: speech.format } : {}),
    ...(speech.model ? { model: speech.model } : {}),
    voice,
    startedAt: new Date(startedAtMs).toISOString(),
    endedAt: new Date().toISOString(),
    latencyMs: Date.now() - startedAtMs,
    status,
    ...(error !== undefined ? { error } : {}),
    characters: text.length,
    ...(audioBytes !== undefined ? { audioBytes } : {}),
  });
  const receipt = (status: InferenceReceipt["status"], errorCode?: InferenceErrorCode): void => {
    const modelId = safeModelId(speech.model);
    emitReceipt({ purpose: "speech", route: speech.route, onReceipt: args.onReceipt }, {
      kind: "speech",
      purpose: "speech",
      route: speech.route,
      ...(modelId ? { modelId } : {}),
      status,
      ...(errorCode ? { errorCode } : {}),
      latencyMs: Date.now() - startedAtMs,
    });
  };
  const fail = (message: string, code: InferenceErrorCode, status: SpeechTrace["status"] = "failed"): never => {
    receipt(status === "cancelled" ? "aborted" : "failed", code);
    throw new SpeechRouteError(`Speech (route "${speech.route}"${speech.format ? `, format "${speech.format}"` : ""}) failed: ${message}`, trace(status, message));
  };

  let audio: Uint8Array;
  if (speech.route === "mock") {
    audio = mockWav();
  } else {
    let key: string | undefined;
    if (speech.route === "api") {
      // Read here, at call time, from the variable the config names. No fallback to any other key.
      const name = speech.credentialEnv as string;
      key = (args.env ?? process.env)[name];
      if (!key) return fail(`${name} is not set — export the key for this route's service; there is no fallback.`, "auth");
      if (!USABLE_KEY.test(key)) return fail(`${name} does not hold a usable key (printable characters, no spaces).`, "auth");
    }
    const wire = WIRES[speech.format as SpeechFormat];
    const request = wire.request({ text, voice, language: args.language ?? speech.language ?? "en-US", model: speech.model });

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, speech.timeoutMs ?? SPEECH_LIMITS.defaultTimeoutMs);
    const onCallerAbort = (): void => controller.abort();
    if (args.abortSignal?.aborted) controller.abort();
    args.abortSignal?.addEventListener("abort", onCallerAbort, { once: true });
    try {
      const res = await fetch((speech.baseUrl as string).replace(/\/+$/, "") + wire.path, {
        method: "POST",
        // A redirect would carry the key and the text somewhere the config did not name.
        redirect: "error",
        headers: { ...request.headers, ...(key ? { authorization: `Bearer ${key}` } : {}) },
        body: request.body,
        signal: controller.signal,
      });
      if (!res.ok) {
        void res.body?.cancel().catch(() => {});
        const code: InferenceErrorCode =
          res.status === 401 || res.status === 403 ? "auth" : res.status === 429 ? "rate_limited" : "provider_error";
        throw new SpeechFailure(`HTTP ${res.status}`, code);
      }
      if (Number(res.headers.get("content-length")) > SPEECH_LIMITS.maxAudioBytes) {
        void res.body?.cancel().catch(() => {});
        throw new SpeechFailure("the service returned more audio than the limit", "invalid_response");
      }
      audio = new Uint8Array(await res.arrayBuffer());
      if (audio.byteLength > SPEECH_LIMITS.maxAudioBytes) throw new SpeechFailure("the service returned more audio than the limit", "invalid_response");
    } catch (err) {
      if (args.abortSignal?.aborted) return fail("the caller cancelled the request", "aborted", "cancelled");
      if (timedOut) return fail("the service did not answer within the time limit", "timeout", "timed_out");
      if (err instanceof SpeechFailure) return fail(err.message, err.code);
      return fail("the service could not be reached", "network");
    } finally {
      clearTimeout(timer);
      args.abortSignal?.removeEventListener("abort", onCallerAbort);
    }
  }

  const durationMs = wavDurationMs(audio);
  if (durationMs === undefined) return fail("the service did not return WAV audio", "invalid_response");
  receipt("completed");
  return { audio, mimeType: "audio/wav", durationMs, trace: trace("completed", undefined, audio.byteLength) };
}

/**
 * Text ready to be spoken: markup a voice would read aloud is removed. Links keep their
 * words, an italic source tag ("*Live match feed*") is dropped, dashes become pauses.
 */
export function speechText(text: string): string {
  return String(text ?? "")
    // An italic provenance tag belongs on screen, not in the voice. Keyword-gated so real emphasis survives.
    .replace(/\*[^*]{0,40}\b(feeds?|posts?|reports?|reporting|sources?|via|per)\b[^*]{0,40}\*/gi, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_`#>]/g, "")
    .replace(/\s*[—–―]\s*/g, ", ")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/…/g, "...")
    .replace(/\s+/g, " ")
    .trim();
}
