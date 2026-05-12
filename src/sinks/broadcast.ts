/**
 * Broadcast Sink — the SportsClaw TV operator's domain plugin.
 *
 * Implements OperatorSinkPlugin for the 24/7 broadcast channel use case:
 *   - Parses the structured `<<<DATA>>>...<<<END>>>` packet from broadcast text
 *   - POSTs telemetry events to a tail-server with the overlay's kind vocab
 *     (broadcast / tick / reasoning / error / gate / ingest / image)
 *   - Archives every archivable event to the pod's tv-content-archive doc
 *   - Registers recall_recent_content (per-tick archive) + recall_library
 *     (evergreen hand-curated pieces) tools
 *   - Wraps generate_image with broadcaster-oriented description + a sink
 *     that writes bytes to disk + POSTs kind:"image" telemetry + archives
 *
 * SCHEDULED TO MOVE OUT — this whole file is destined to live in the
 * machina-sports-tv repo (alongside the library JSON it queries, the
 * persona YAML it pairs with, and the overlay's tail-server). It lives in
 * sportsclaw today only for backward compat: legacy operator job configs
 * with `tailServer` set and no `sink` field implicitly resolve to this
 * sink. Once the TV repo ships its own sink package, this file will be
 * deleted from sportsclaw and `cfg.sink: "@machina-sports/tv-operator-sink"`
 * (or similar) will be the only supported path.
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
// `tool` factory from the AI SDK requires literal generic types that fight
// our Record<string, unknown> execute signatures. The `as any` cast is the
// same workaround engine.ts and image-gen.ts use. ToolSet type is not
// needed in this module — the sink mutates the toolSet passed in.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import { tool as defineToolRaw, jsonSchema } from "ai";
const defineTool = defineToolRaw as any;

import type { TickEvent, ToolCallEvent } from "../operator-daemon.js";
import type { OperatorSinkPlugin, SinkContext } from "../operator-sink.js";
import type { OperatorJobConfig } from "../operator-config.js";
import type { McpManager } from "../mcp.js";
import type { CreateGenerateImageToolOpts } from "../image-gen.js";

// ---------------------------------------------------------------------------
// Structured packet — TV-specific narrative + JSON-data hybrid
// ---------------------------------------------------------------------------

interface MarketItem {
  question?: string;
  prob?: number | string;
  trend?: string;
  source?: string;
}
interface FixtureItem {
  home?: string;
  away?: string;
  odds?: string;
  kickoff?: string;
  source?: string;
}
interface NewsItem {
  headline?: string;
  source?: string;
  ts?: string;
}
interface StructuredPacket {
  prediction_markets?: MarketItem[];
  fixtures?: FixtureItem[];
  news?: NewsItem[];
}
interface ParsedBroadcast {
  narrative: string;
  data: StructuredPacket | null;
  parseError?: string;
}

const PACKET_RE = /<<<DATA>>>\s*([\s\S]*?)\s*<<<END>>>/;
const PACKET_OPEN_RE = /<<<DATA>>>/;

export function parseStructuredBroadcast(text: string): ParsedBroadcast {
  const match = text.match(PACKET_RE);
  if (match) {
    const raw = match[1].trim();
    let data: StructuredPacket | null = null;
    let parseError: string | undefined;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        data = parsed as StructuredPacket;
      }
    } catch (err) {
      parseError = err instanceof Error ? err.message : String(err);
    }
    const narrative = text.replace(PACKET_RE, "").trim();
    return { narrative, data, parseError };
  }
  // Defensive: LLM started a packet but never closed it (token-limit truncation,
  // malformed output). Strip from <<<DATA>>> onward so raw JSON doesn't bleed
  // into the renderer card.
  const openMatch = text.match(PACKET_OPEN_RE);
  if (openMatch && openMatch.index !== undefined) {
    return {
      narrative: text.slice(0, openMatch.index).trim(),
      data: null,
      parseError: "packet opened but never closed (truncated)",
    };
  }
  return { narrative: text.trim(), data: null };
}

// ---------------------------------------------------------------------------
// TickEvent → overlay-kind mapping
// ---------------------------------------------------------------------------

function mapTickEventToTelemetry(
  evt: TickEvent,
  jobId: string,
  modelId: string | undefined,
  intervalMs: number | undefined,
): {
  kind: string;
  message: string;
  level: "info" | "warn" | "error";
  model?: string;
  prompt_excerpt?: string;
  phase?: string;
  intervalMs?: number;
} {
  switch (evt.type) {
    case "tick_started":
      return {
        kind: "tick",
        message: `tick ${evt.tickId.slice(0, 12)}… started · job ${jobId}`,
        level: "info",
        phase: "started",
        intervalMs,
      };
    case "tick_published":
      return {
        kind: "broadcast",
        message: `${evt.toolCalls ?? 0} tool calls · ${(evt.text ?? "").length} chars`,
        level: "info",
        model: modelId,
        prompt_excerpt: evt.text,
      };
    case "tick_silent":
      return {
        kind: "reasoning",
        message: `tick ${evt.tickId.slice(0, 12)}… silent · no broadcast`,
        level: "info",
      };
    case "tick_failed":
      return {
        kind: "error",
        message: `tick failed: ${evt.reason ?? "unknown"}`,
        level: "error",
      };
    case "tick_skipped":
      return {
        kind: "gate",
        message: `tick skipped · ${evt.reason ?? "wake gate denied"}`,
        level: "warn",
      };
    default:
      return { kind: "reasoning", message: String(evt.type), level: "info" };
  }
}

async function postTelemetry(url: string, body: Record<string, unknown>): Promise<void> {
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error(
      `[broadcast-sink] tail-server POST failed (${url}): ${err instanceof Error ? err.message : err}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Archive — writes tv-content-archive docs to the pod
// ---------------------------------------------------------------------------

async function archiveToPod(
  mcpManager: McpManager | undefined,
  data: {
    ts: string;
    tickId?: string;
    category: "broadcast" | "prediction_markets" | "fixtures" | "news" | "image";
    workflow_name: string;
    narrative?: string;
    items?: unknown[];
    prompt?: string;
    image_url?: string;
    image_provider?: string;
  },
): Promise<void> {
  // Best-effort, non-fatal: a missing mcpManager or no Machina pod = silent skip.
  if (!mcpManager) return;
  const server = mcpManager.getMachinaServerName();
  if (!server) return;
  const date = data.ts.slice(0, 10);
  const content = {
    ts: data.ts,
    tickId: data.tickId ?? "",
    date,
    category: data.category,
    workflow_name: data.workflow_name,
    narrative: data.narrative ?? "",
    items: data.items ?? [],
    prompt: data.prompt ?? "",
    image_url: data.image_url ?? "",
    image_provider: data.image_provider ?? "",
    replayed_count: 0,
  };
  try {
    const res = await mcpManager.callToolDirect(server, "create_document", {
      name: "tv-content-archive",
      content,
      metadata: {
        document_type: "tv-content-archive",
        date,
        category: data.category,
        workflow_name: data.workflow_name,
        tickId: data.tickId ?? "",
      },
    });
    if (res.isError) {
      console.error(
        `[broadcast-sink] archive returned error · category=${data.category} · ${res.content.slice(0, 200)}`,
      );
    }
  } catch (err) {
    console.error(
      `[broadcast-sink] archive failed: ${err instanceof Error ? err.message : err}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Recall tools — register on the daemon's toolset
// ---------------------------------------------------------------------------

function defineRecallRecentContent(mcpManager: McpManager) {
  return defineTool({
    description:
      "Recall earlier broadcasts, prediction markets, fixtures, news headlines, " +
      "or generated images from today's content archive. Call this when current " +
      "data is thin or the same story has repeated across recent ticks and you " +
      "want to resurface an earlier moment instead of recycling. Returns a JSON " +
      "object {count, results: [...]} with past archive entries — each has ts, " +
      "category, and narrative/items/prompt/image_url depending on category.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        category: {
          type: "string",
          enum: ["broadcast", "image", "prediction_markets", "fixtures", "news"],
          description: "Type of past content to recall.",
        },
        since_minutes: {
          type: "number",
          description: "Look back this many minutes. Defaults to 240 (4 hours).",
        },
        limit: {
          type: "number",
          description: "Max entries to return. Defaults to 5.",
        },
      },
      required: ["category"],
    }),
    execute: async (args: Record<string, unknown>) => {
      const category = typeof args.category === "string" ? args.category : "";
      const sinceMin = typeof args.since_minutes === "number" ? args.since_minutes : 240;
      const limit = typeof args.limit === "number" ? args.limit : 5;
      if (!category) return JSON.stringify({ error: "category required" });
      const server = mcpManager.getMachinaServerName();
      if (!server) return JSON.stringify({ error: "no pod available", count: 0, results: [] });
      const sinceIso = new Date(Date.now() - sinceMin * 60_000).toISOString();
      const result = await mcpManager.callToolDirect(server, "search_documents", {
        filters: {
          name: "tv-content-archive",
          "metadata.category": category,
          created: { $gte: sinceIso },
        },
        sorters: [["created", -1]],
        page_size: limit,
      });
      if (result.isError) return JSON.stringify({ error: result.content, count: 0, results: [] });
      try {
        const parsed = JSON.parse(result.content);
        const docs = (parsed as Record<string, unknown>)?.data ?? [];
        const innerDocs = (docs as Record<string, unknown>)?.data ?? docs;
        const items = (Array.isArray(innerDocs) ? innerDocs : []).map((d: Record<string, unknown>) => {
          const value = (d.value ?? {}) as Record<string, unknown>;
          return {
            ts: value.ts,
            category: value.category,
            narrative: value.narrative,
            items: value.items,
            prompt: value.prompt,
            image_url: value.image_url,
          };
        });
        return JSON.stringify({ count: items.length, results: items });
      } catch (e) {
        return JSON.stringify({ error: e instanceof Error ? e.message : String(e), count: 0, results: [] });
      }
    },
  });
}

function defineRecallLibrary(mcpManager: McpManager) {
  return defineTool({
    description:
      "Recall evergreen library pieces about a specific scope (team, group, venue, " +
      "player, historical moment, tactical concept). Call this when the broadcast " +
      "lead names a scope you have a canonical library piece on — e.g. lead mentions " +
      "Brazil → recall_library({scope_type:'team', scope_ref:'BRA'}) → get the canonical " +
      "Hexa-hunt framing to weave into the live narrative. Returns " +
      "{count, results: [{title, body, scope_type, scope_ref, tags}]} from the pod's " +
      "tv-content-library document store. Library pieces are persistent (not the " +
      "per-tick archive — for that use recall_recent_content).",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        scope_type: {
          type: "string",
          enum: ["team", "group", "venue", "player", "historical", "tactical"],
          description: "Filter by scope type. Omit for any scope.",
        },
        scope_ref: {
          type: "string",
          description:
            "Exact scope reference (e.g. 'BRA' for Brazil, 'group-A', 'metlife', 'messi'). Use with scope_type for canonical lookup.",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description:
            "Filter to pieces tagged with ANY of these tags (e.g. ['favorites'], ['host'], ['europe']).",
        },
        limit: {
          type: "number",
          description: "Max pieces to return. Default 3.",
        },
      },
    }),
    execute: async (args: Record<string, unknown>) => {
      const scope_type = typeof args.scope_type === "string" ? args.scope_type : undefined;
      const scope_ref = typeof args.scope_ref === "string" ? args.scope_ref : undefined;
      const tags = Array.isArray(args.tags)
        ? args.tags.filter((t): t is string => typeof t === "string")
        : undefined;
      const limit = typeof args.limit === "number" ? args.limit : 3;
      const server = mcpManager.getMachinaServerName();
      if (!server) return JSON.stringify({ error: "no pod available", count: 0, results: [] });
      const filters: Record<string, unknown> = { name: "tv-content-library" };
      if (scope_type) filters["metadata.scope_type"] = scope_type;
      if (scope_ref) filters["metadata.scope_ref"] = scope_ref;
      if (tags && tags.length > 0) filters["value.tags"] = { $in: tags };
      const result = await mcpManager.callToolDirect(server, "search_documents", {
        filters,
        sorters: [["created", -1]],
        page_size: limit,
      });
      if (result.isError) return JSON.stringify({ error: result.content, count: 0, results: [] });
      try {
        const parsed = JSON.parse(result.content);
        const docs = (parsed as Record<string, unknown>)?.data ?? [];
        const innerDocs = (docs as Record<string, unknown>)?.data ?? docs;
        const items = (Array.isArray(innerDocs) ? innerDocs : []).map((d: Record<string, unknown>) => {
          const value = (d.value ?? {}) as Record<string, unknown>;
          return {
            title: value.title,
            body: value.body,
            scope_type: value.scope_type,
            scope_ref: value.scope_ref,
            tags: value.tags,
          };
        });
        return JSON.stringify({ count: items.length, results: items });
      } catch (e) {
        return JSON.stringify({ error: e instanceof Error ? e.message : String(e), count: 0, results: [] });
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const BROADCAST_IMAGE_DESCRIPTION =
  "Generate a broadcast-overlay image (poster card, hero graphic, fan-cam still) from a text prompt. " +
  "Routes to Google Gemini image generation. The image is delivered to the on-air overlay as a kind:\"image\" " +
  "telemetry event. Use this when the lead story has strong visual potential (a stadium, an iconic player, " +
  "a final-whistle moment, a tournament-hype beat). Prompts should describe a poster-style composition " +
  "explicitly — e.g. \"broadcast graphic: France national team huddle, World Cup 2026, dramatic stadium " +
  "lighting, hero composition, 16:9 poster.\" Returns a short confirmation string after the image lands.";

function imagesDirFor(cfg: OperatorJobConfig, rootDir: string): string {
  void cfg;
  return path.join(rootDir, "images");
}

export const broadcastSink: OperatorSinkPlugin = {
  name: "broadcast",

  registerTools({ toolSet, toolNames, mcpManager }) {
    toolSet["recall_recent_content"] = defineRecallRecentContent(mcpManager);
    toolNames.push("recall_recent_content");
    toolSet["recall_library"] = defineRecallLibrary(mcpManager);
    toolNames.push("recall_library");
  },

  wrapImageGenerator({ cfg, mcpManager }): CreateGenerateImageToolOpts {
    // Resolve rootDir the same way operate.ts's runOnce/runForeground does.
    // The sink doesn't have access to the already-resolved inputs because it
    // is constructed before resolveJobInputs runs, so we recompute the path
    // from cfg here. Keeps the sink standalone.
    const rawRoot = cfg.rootDir ?? defaultRootDirFor(cfg.jobId);
    const rootDir = expandTilde(rawRoot);
    const imagesDir = imagesDirFor(cfg, rootDir);
    const provider = cfg.provider ?? "google";
    const wfName = `sportsclaw-operate:${cfg.jobId}`;
    return {
      provider,
      description: BROADCAST_IMAGE_DESCRIPTION,
      onImage: async (image) => {
        try {
          fs.mkdirSync(imagesDir, { recursive: true });
        } catch {
          /* noop */
        }
        const ext = (image.mimeType || "").includes("png") ? "png" : "jpg";
        const id = randomUUID();
        const filePath = path.join(imagesDir, `${id}.${ext}`);
        fs.writeFileSync(filePath, Buffer.from(image.data, "base64"));

        const publicUrl = cfg.tailServer
          ? `${cfg.tailServer.replace(/\/+$/, "")}/images/${id}.${ext}`
          : `file://${filePath}`;

        if (cfg.tailServer) {
          const url = cfg.tailServer.replace(/\/+$/, "") + "/ingest";
          try {
            await fetch(url, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                ts: new Date().toISOString(),
                kind: "image",
                message: `image generated · ${image.prompt.slice(0, 80)}`,
                level: "info",
                model:
                  image.provider === "google"
                    ? "gemini-3.1-flash-image-preview"
                    : "dall-e-3",
                prompt_excerpt: image.prompt,
                workflow_name: wfName,
                src: publicUrl,
              }),
            });
          } catch {
            /* non-fatal */
          }
        }
        await archiveToPod(mcpManager, {
          ts: new Date().toISOString(),
          category: "image",
          workflow_name: wfName,
          prompt: image.prompt,
          image_url: publicUrl,
          image_provider: image.provider,
        });
      },
    };
  },

  async onTickEvent(evt: TickEvent, ctx: SinkContext) {
    const tailServer = ctx.cfg.tailServer;
    if (!tailServer) return;
    const url = tailServer.replace(/\/+$/, "") + "/ingest";
    const wfName = `sportsclaw-operate:${ctx.jobId}`;

    // For tick_published, strip the structured packet from the narrative
    // before posting, then fan out the packet's arrays as their own
    // kind-specific events (+ archive each one).
    let textOverride: string | undefined;
    let packet: StructuredPacket | null = null;
    if (evt.type === "tick_published" && evt.text) {
      const parsed = parseStructuredBroadcast(evt.text);
      textOverride = parsed.narrative;
      packet = parsed.data;
      if (parsed.parseError) {
        console.error(`[broadcast-sink] structured packet parse error: ${parsed.parseError}`);
      }
    }

    const eventForMap: TickEvent =
      textOverride !== undefined ? { ...evt, text: textOverride } : evt;
    const mapped = mapTickEventToTelemetry(
      eventForMap,
      ctx.jobId,
      ctx.modelId,
      ctx.intervalMs,
    );
    try {
      await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ts: evt.timestamp,
          kind: mapped.kind,
          message: mapped.message,
          level: mapped.level,
          model: mapped.model ?? "",
          prompt_excerpt: mapped.prompt_excerpt ?? "",
          phase: mapped.phase ?? "",
          intervalMs: mapped.intervalMs ?? 0,
          workflow_name: wfName,
        }),
      });
    } catch (err) {
      console.error(
        `[broadcast-sink] tail-server POST failed (${url}): ${err instanceof Error ? err.message : err}`,
      );
    }

    // Archive the broadcast narrative.
    if (evt.type === "tick_published" && textOverride !== undefined) {
      await archiveToPod(ctx.mcpManager, {
        ts: evt.timestamp,
        tickId: "tickId" in evt && typeof evt.tickId === "string" ? evt.tickId : undefined,
        category: "broadcast",
        workflow_name: wfName,
        narrative: textOverride,
      });
    }

    // Fan out the packet — each array becomes a widget event AND an archive doc.
    if (packet) {
      const ts = evt.timestamp;
      const tickId =
        "tickId" in evt && typeof evt.tickId === "string" ? evt.tickId : undefined;
      if (Array.isArray(packet.prediction_markets) && packet.prediction_markets.length > 0) {
        await postTelemetry(url, {
          ts,
          kind: "prediction_markets",
          message: `${packet.prediction_markets.length} markets live`,
          level: "info",
          workflow_name: wfName,
          items: packet.prediction_markets,
        });
        await archiveToPod(ctx.mcpManager, {
          ts,
          tickId,
          category: "prediction_markets",
          workflow_name: wfName,
          items: packet.prediction_markets,
        });
      }
      if (Array.isArray(packet.fixtures) && packet.fixtures.length > 0) {
        await postTelemetry(url, {
          ts,
          kind: "fixtures",
          message: `${packet.fixtures.length} fixtures`,
          level: "info",
          workflow_name: wfName,
          items: packet.fixtures,
        });
        await archiveToPod(ctx.mcpManager, {
          ts,
          tickId,
          category: "fixtures",
          workflow_name: wfName,
          items: packet.fixtures,
        });
      }
      if (Array.isArray(packet.news) && packet.news.length > 0) {
        await postTelemetry(url, {
          ts,
          kind: "news",
          message: `${packet.news.length} headlines`,
          level: "info",
          workflow_name: wfName,
          items: packet.news,
        });
        await archiveToPod(ctx.mcpManager, {
          ts,
          tickId,
          category: "news",
          workflow_name: wfName,
          items: packet.news,
        });
      }
    }
  },

  onToolCall(evt: ToolCallEvent, ctx: SinkContext) {
    const tailServer = ctx.cfg.tailServer;
    if (!tailServer) return;
    const url = tailServer.replace(/\/+$/, "") + "/ingest";
    const level: "info" | "warn" | "error" =
      evt.outcome === "ok" ? "info" : evt.outcome === "blocked" ? "warn" : "error";
    const msg =
      `${evt.toolName} · ${evt.outcome} · ${evt.durationMs}ms` +
      (evt.reason ? ` · ${evt.reason}` : "");
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ts: evt.timestamp,
        kind: "ingest",
        message: msg,
        level,
        workflow_name: `sportsclaw-operate:${ctx.jobId}`,
      }),
    }).catch(() => {
      /* non-fatal */
    });
  },
};

// Helpers duplicated from operate.ts so the sink is standalone. These are
// trivial and will move out with the sink when it migrates to the TV repo.
function defaultRootDirFor(jobId: string): string {
  return path.join(
    process.env.HOME ?? process.env.USERPROFILE ?? ".",
    ".sportsclaw",
    "operator",
    jobId,
  );
}
function expandTilde(p: string): string {
  if (p === "~") return process.env.HOME ?? process.env.USERPROFILE ?? p;
  if (p.startsWith("~/")) {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
    return path.join(home, p.slice(2));
  }
  return p;
}

// Test re-exports — used by test/operate.test.mjs assertions against the
// extracted helpers. Not part of the public surface.
export const _internal = {
  parseStructuredBroadcast,
  mapTickEventToTelemetry,
  archiveToPod,
};
