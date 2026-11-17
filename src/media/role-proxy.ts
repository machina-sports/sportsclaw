/**
 * Role proxy — a loopback HTTP front for the model roles, so media job scripts can call models
 * without ever holding an API key.
 *
 *   POST {url}/role/<role>   Authorization: Bearer <token>   body { input, system?, media?, sampling? }
 *   -> 200 { output }
 *
 * The proxy runs in the harness process, which owns the keys; the job only gets `url` and `token`
 * (see LocalJobRunner's `roleProxy`). Checks run in this order: Host (403), token (401), role
 * allowlist (403), body size (413), JSON (400), then the model call (502 on failure, with the body
 * `{ error: "model call failed: <router error code>" }` and nothing logged: provider text can echo keys).
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import http from "node:http";
import type { Socket } from "node:net";

import { invokeModelRole, type ModelRoleRouterConfig } from "../inference/model-role-router.js";
import type { ModelRole } from "../inference/model-roles.js";
import type { InferenceErrorCode, InferenceReceipt } from "../inference/receipt.js";
import type { MediaAttachment } from "../types.js";

/** Largest request body the proxy reads. Media travels inline as base64. */
export const MAX_ROLE_PROXY_BODY_BYTES = 64 * 1024 * 1024;

export interface RoleProxy {
  /** Base URL, e.g. `http://127.0.0.1:41234`; callers POST to `${url}/role/<role>`. */
  url: string;
  /** 32 random bytes, hex; valid until `close()`. */
  token: string;
  /** Stops listening and drops open connections. Safe to call more than once. */
  close(): Promise<void>;
}

class RequestTooLarge extends Error {}

function reply(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

function tokenMatches(header: string | undefined, token: string): boolean {
  const m = /^Bearer (.+)$/.exec(header ?? "");
  if (!m) return false;
  const given = Buffer.from(m[1]);
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}

/** Reads the body, giving up as soon as it passes the cap. */
function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (declared > MAX_ROLE_PROXY_BODY_BYTES) return reject(new RequestTooLarge());
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_ROLE_PROXY_BODY_BYTES) {
        chunks.length = 0;
        req.removeAllListeners("data");
        reject(new RequestTooLarge());
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
    req.on("aborted", () => reject(new Error("request aborted")));
  });
}

export async function startRoleProxy(opts: {
  inference: ModelRoleRouterConfig;
  allowRoles: ModelRole[];
  onReceipt?: (r: InferenceReceipt) => void;
}): Promise<RoleProxy> {
  const token = randomBytes(32).toString("hex");
  const allowed = new Set<string>(opts.allowRoles);
  const sockets = new Set<Socket>();
  let port = 0;

  const server = http.createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) reply(res, 500, { error: "internal error" });
      else res.destroy();
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const host = req.headers.host;
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return reply(res, 403, { error: "forbidden host" });

    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const match = /^\/role\/([^/]+)$/.exec(url.pathname);
    if (!match) return reply(res, 404, { error: "not found" });
    if (req.method !== "POST") return reply(res, 405, { error: "method not allowed" });

    if (!tokenMatches(req.headers.authorization, token)) return reply(res, 401, { error: "unauthorized" });

    const role = match[1];
    if (!allowed.has(role)) return reply(res, 403, { error: "role not allowed" });

    let raw: Buffer;
    try {
      raw = await readBody(req);
    } catch (err) {
      if (!(err instanceof RequestTooLarge)) throw err;
      reply(res, 413, { error: "request body too large" });
      // Discard what is still arriving so the client can read the 413, then cut the connection.
      req.resume();
      setTimeout(() => req.destroy(), 2000).unref();
      return;
    }

    let body: { input?: unknown; system?: unknown; media?: unknown; sampling?: unknown };
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {
      return reply(res, 400, { error: "body must be JSON" });
    }
    if (!body || typeof body !== "object" || Array.isArray(body) || body.input === undefined) {
      return reply(res, 400, { error: "body must be a JSON object with an input" });
    }

    let observed = false;
    let errorCode: InferenceErrorCode | undefined;
    try {
      const result = await invokeModelRole({
        role: role as ModelRole,
        input: body.input,
        source: "sportsclaw-operator",
        config: opts.inference,
        system: body.system as string | undefined,
        media: body.media as MediaAttachment[] | undefined,
        sampling: body.sampling as { maxOutputTokens?: number; temperature?: number; topP?: number } | undefined,
        onReceipt: (receipt) => {
          observed = true;
          errorCode = receipt.errorCode;
          opts.onReceipt?.(receipt);
        },
      });
      // Chat routes report their own receipt; the mock route makes none, so report from the trace.
      if (!observed) {
        opts.onReceipt?.({
          kind: "generate",
          purpose: "model_role",
          route: result.trace.route,
          modelId: result.trace.model,
          status: "completed",
          latencyMs: result.trace.latencyMs,
        });
      }
      reply(res, 200, { output: result.output });
    } catch {
      // A provider's error text can echo key fragments: send a fixed message and the router's code, log nothing.
      reply(res, 502, { error: `model call failed: ${errorCode ?? "unknown"}` });
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  port = (server.address() as { port: number }).port;

  let closing: Promise<void> | undefined;
  return {
    url: `http://127.0.0.1:${port}`,
    token,
    close() {
      closing ??= new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const socket of sockets) socket.destroy();
      });
      return closing;
    },
  };
}
