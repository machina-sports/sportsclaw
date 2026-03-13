/**
 * sportsclaw Auto-Clipper — Conversational CLI Wizard
 *
 * Interactive flow:
 *   1. Gemini credential check (multi-LLM keychain)
 *   2. Match selection via natural language → sports-skills local lookup
 *   3. Video file selection with validation
 *   4. Highlight intent (free-text)
 *   5. Output format (landscape 16:9 / vertical 9:16)
 *   6. Extraction pipeline (Gemini Vision OCR → PBP → FFmpeg → Hype Score)
 *
 * Flags:
 *   --yes, --non-interactive   Skip all prompts (agentic mode)
 *   --file <path>              Video file path (skip prompt)
 *   --match <query>            Match query (skip prompt)
 *   --intent <text>            Highlight intent (skip prompt)
 *   --format <landscape|vertical>  Output format (skip prompt)
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve, join, basename } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import * as p from "@clack/prompts";
import pc from "picocolors";
import {
  GoogleAIFileManager,
  FileState,
} from "@google/generative-ai/server";
import { GoogleGenerativeAI } from "@google/generative-ai";
import type { FfprobeData } from "fluent-ffmpeg";
import { ensureCredential, resolveCredential, printCredentialStatus } from "./credentials.js";
import { executePythonBridge } from "./tools.js";
import { resolveConfig } from "./config.js";

const require = createRequire(import.meta.url);
const ffmpeg = require("fluent-ffmpeg") as typeof import("fluent-ffmpeg");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MatchOption {
  value: string;
  label: string;
  hint?: string;
}

interface ClipFlags {
  nonInteractive: boolean;
  file?: string;
  match?: string;
  intent?: string;
  format?: "landscape" | "vertical";
}

interface PBPTimestamp {
  startSec: number;
  label: string;
}

interface ScoredChunk {
  file: string;
  startSec: number;
  durationSec: number;
  hypeScore: number;
  summary: string;
}

const CHUNK_DURATION_SEC = 30;
const HIGHLIGHTS_DIR = "./highlights";

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function parseClipArgs(args: string[]): ClipFlags {
  const flags: ClipFlags = { nonInteractive: false };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--yes" || arg === "--non-interactive") {
      flags.nonInteractive = true;
    } else if (arg === "--file" && args[i + 1]) {
      flags.file = args[++i];
    } else if (arg === "--match" && args[i + 1]) {
      flags.match = args[++i];
    } else if (arg === "--intent" && args[i + 1]) {
      flags.intent = args[++i];
    } else if (arg === "--format" && args[i + 1]) {
      const fmt = args[++i];
      if (fmt === "landscape" || fmt === "vertical") {
        flags.format = fmt;
      }
    }
  }

  return flags;
}

// ---------------------------------------------------------------------------
// Sports-skills match discovery
// ---------------------------------------------------------------------------

/** Sport modules to query for recent matches */
const MATCH_SPORTS = [
  { skill: "football", label: "Football (Soccer)" },
  { skill: "nba",      label: "NBA" },
  { skill: "nfl",      label: "NFL" },
  { skill: "mlb",      label: "MLB" },
  { skill: "nhl",      label: "NHL" },
] as const;

/**
 * Query local sports-skills for recent/live matches across multiple sports.
 * Parses the bridge result and returns a flat array of selectable options.
 */
async function fetchRecentMatches(
  query?: string,
  pythonPath?: string,
): Promise<MatchOption[]> {
  const options: MatchOption[] = [];
  const config = { pythonPath: pythonPath ?? "python3", timeout: 15_000 };

  // Query each sport for scores (recent/live games)
  const sportQueries = MATCH_SPORTS.map(async ({ skill, label }) => {
    try {
      const result = await executePythonBridge(skill, "scores", undefined, config);
      if (!result.success || !result.data) return [];

      const data = result.data as Record<string, unknown>;
      const events = extractEvents(data);

      return events.map((evt) => ({
        value: `${skill}_${evt.id}`,
        label: evt.name,
        hint: label,
      }));
    } catch {
      return [];
    }
  });

  const results = await Promise.allSettled(sportQueries);
  for (const r of results) {
    if (r.status === "fulfilled") {
      options.push(...r.value);
    }
  }

  // Filter by query if provided
  if (query && query.trim().length > 0) {
    const q = query.toLowerCase();
    const filtered = options.filter(
      (o) => o.label.toLowerCase().includes(q) || (o.hint ?? "").toLowerCase().includes(q)
    );
    if (filtered.length > 0) return filtered;
  }

  return options;
}

/**
 * Extract event entries from a sports-skills scores response.
 * Handles the common ESPN data shape: { events: [{ id, name, ... }] }
 * as well as flat arrays and nested data wrappers.
 */
function extractEvents(data: Record<string, unknown>): Array<{ id: string; name: string }> {
  // Direct events array
  if (Array.isArray(data.events)) {
    return (data.events as Array<Record<string, unknown>>)
      .filter((e) => typeof e.id === "string" && typeof e.name === "string")
      .map((e) => ({ id: e.id as string, name: e.name as string }));
  }

  // Nested under data.events (sports-skills wrapper)
  if (data.data && typeof data.data === "object") {
    const inner = data.data as Record<string, unknown>;
    if (Array.isArray(inner.events)) {
      return (inner.events as Array<Record<string, unknown>>)
        .filter((e) => typeof e.id === "string" && typeof e.name === "string")
        .map((e) => ({ id: e.id as string, name: e.name as string }));
    }
  }

  // Flat array at top level
  if (Array.isArray(data)) {
    return (data as Array<Record<string, unknown>>)
      .filter((e) => typeof e.id === "string" && typeof e.name === "string")
      .map((e) => ({ id: e.id as string, name: e.name as string }));
  }

  return [];
}

// ---------------------------------------------------------------------------
// FFmpeg helpers
// ---------------------------------------------------------------------------

function probeVideo(filePath: string): Promise<FfprobeData> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err: Error | null, data: FfprobeData) => {
      if (err) return reject(err);
      resolve(data);
    });
  });
}

function extractSegment(
  input: string,
  output: string,
  startSec: number,
  durationSec: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg(input)
      .setStartTime(startSec)
      .duration(durationSec)
      .outputOptions(["-c copy", "-avoid_negative_ts make_zero"])
      .output(output)
      .on("end", () => resolve())
      .on("error", (err: Error) => reject(err))
      .run();
  });
}

// ---------------------------------------------------------------------------
// PBP mock — returns fake timestamps for a given intent
// ---------------------------------------------------------------------------

function searchPBPTimestamps(
  _matchId: string,
  intent: string,
  totalDurationSec: number,
): PBPTimestamp[] {
  // TODO: Wire to real PBP data from sports-skills
  // For now, return 3-5 evenly-spaced candidate windows
  const count = Math.min(5, Math.max(3, Math.floor(totalDurationSec / 600)));
  const spacing = totalDurationSec / (count + 1);
  const timestamps: PBPTimestamp[] = [];
  for (let i = 1; i <= count; i++) {
    const startSec = Math.floor(spacing * i);
    timestamps.push({
      startSec,
      label: `PBP candidate #${i} for "${intent}" @ ${fmtTime(startSec)}`,
    });
  }
  return timestamps;
}

// ---------------------------------------------------------------------------
// Gemini Vision — analyse a single video chunk, return a hype score 0-100
// ---------------------------------------------------------------------------

async function analyzeChunkWithGemini(
  chunkPath: string,
  intent: string,
  apiKey: string,
): Promise<{ hypeScore: number; summary: string }> {
  const fileManager = new GoogleAIFileManager(apiKey);
  const genAI = new GoogleGenerativeAI(apiKey);

  const uploadRes = await fileManager.uploadFile(chunkPath, {
    mimeType: "video/mp4",
    displayName: basename(chunkPath),
  });

  let fileMeta = uploadRes.file;
  while (fileMeta.state === FileState.PROCESSING) {
    await new Promise((r) => setTimeout(r, 3000));
    fileMeta = await fileManager.getFile(fileMeta.name);
  }

  if (fileMeta.state === FileState.FAILED) {
    throw new Error(`Gemini file processing failed for ${chunkPath}`);
  }

  const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
  const result = await model.generateContent([
    {
      fileData: {
        mimeType: fileMeta.mimeType,
        fileUri: fileMeta.uri,
      },
    },
    {
      text: [
        `You are a sports highlight analyst. The user wants: "${intent}".`,
        "Watch this video clip and respond with ONLY valid JSON (no markdown, no code fences):",
        '{ "hypeScore": <0-100>, "summary": "<one sentence>" }',
        "hypeScore: 0 = nothing relevant, 100 = peak highlight moment.",
      ].join("\n"),
    },
  ]);

  const raw = result.response.text().trim();
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");

  try {
    const parsed = JSON.parse(cleaned);
    return {
      hypeScore: Math.max(0, Math.min(100, Number(parsed.hypeScore) || 0)),
      summary: String(parsed.summary || "No summary"),
    };
  } catch {
    return { hypeScore: 0, summary: "Failed to parse Gemini response" };
  } finally {
    await fileManager.deleteFile(fileMeta.name).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// File validation
// ---------------------------------------------------------------------------

const VIDEO_EXTENSIONS = new Set([".mp4", ".mkv", ".mov", ".avi", ".webm", ".ts", ".m4v"]);

function validateVideoPath(filePath: string): string | undefined {
  const resolved = resolve(filePath);
  if (!existsSync(resolved)) {
    return `File not found: ${resolved}`;
  }
  const ext = resolved.slice(resolved.lastIndexOf(".")).toLowerCase();
  if (!VIDEO_EXTENSIONS.has(ext)) {
    return `Unsupported video format: ${ext}. Supported: ${[...VIDEO_EXTENSIONS].join(", ")}`;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Main CLI flow
// ---------------------------------------------------------------------------

export async function cmdClip(args: string[] = []): Promise<void> {
  const flags = parseClipArgs(args);

  p.intro(pc.bold("SportsClaw Auto-Clipper") + pc.dim(" (Vision + PBP Engine)"));

  // Show credential status
  printCredentialStatus();

  // Step 1: Ensure Gemini auth (required for Vision OCR + Hype Scoring)
  await ensureCredential("gemini", {
    nonInteractive: flags.nonInteractive,
    reason: "Auto-Clipper requires Gemini Vision models for multimodal analysis.",
  });

  p.log.success("Gemini authenticated.");

  // Step 2: Match selection — conversational natural language flow
  const { pythonPath } = resolveConfig();
  let selectedMatchId: string;
  let selectedMatchLabel: string;

  if (flags.nonInteractive && flags.match) {
    // Agentic mode: use provided match flag directly
    selectedMatchId = flags.match;
    selectedMatchLabel = flags.match;
    p.log.info(`Match: ${flags.match}`);
  } else {
    const matchQuery = await p.text({
      message: "What match are you clipping?",
      placeholder: "e.g., Corinthians vs Flamengo, Lakers vs Warriors",
    });
    if (p.isCancel(matchQuery)) {
      p.cancel("Cancelled.");
      return process.exit(0);
    }

    const s = p.spinner();
    s.start("Searching local sports-skills for matching fixtures...");

    const matches = await fetchRecentMatches(matchQuery as string, pythonPath);

    if (matches.length === 0) {
      s.stop("No matches found.");
      p.log.warn(
        "Could not find matching fixtures via sports-skills.\n" +
        "  Tip: Try a broader query, or ensure sports-skills is installed:\n" +
        "    sportsclaw init"
      );

      // Allow manual match ID entry as fallback
      const manualId = await p.text({
        message: "Enter a match/event ID manually (or Ctrl+C to cancel):",
        placeholder: "e.g., 401234567",
      });
      if (p.isCancel(manualId)) {
        p.cancel("Cancelled.");
        return process.exit(0);
      }
      selectedMatchId = manualId as string;
      selectedMatchLabel = manualId as string;
    } else {
      s.stop(`Found ${matches.length} fixture(s).`);

      const selection = await p.select({
        message: "Select the match:",
        options: matches.map((m) => ({
          value: m.value,
          label: m.label,
          hint: m.hint,
        })),
      });
      if (p.isCancel(selection)) {
        p.cancel("Cancelled.");
        return process.exit(0);
      }

      selectedMatchId = selection as string;
      selectedMatchLabel =
        matches.find((m) => m.value === selection)?.label ?? (selection as string);
    }
  }

  // Step 3: Video file selection with validation
  let videoPath: string;

  if (flags.file) {
    const err = validateVideoPath(flags.file);
    if (err) {
      p.log.error(err);
      process.exit(1);
    }
    videoPath = resolve(flags.file);
    p.log.info(`Video: ${videoPath}`);
  } else {
    const fileInput = await p.text({
      message: "Where is the local video file?",
      placeholder: "./downloads/match.mp4",
      validate: (val) => val ? validateVideoPath(val) : "File path is required.",
    });
    if (p.isCancel(fileInput)) {
      p.cancel("Cancelled.");
      return process.exit(0);
    }
    videoPath = resolve(fileInput as string);
  }

  // Step 4: Highlight intent
  let intent: string;

  if (flags.intent) {
    intent = flags.intent;
    p.log.info(`Intent: ${intent}`);
  } else {
    const intentInput = await p.text({
      message: "What do you want to highlight?",
      placeholder: "e.g., All goals, Memphis Depay's best moments, Red cards",
    });
    if (p.isCancel(intentInput)) {
      p.cancel("Cancelled.");
      return process.exit(0);
    }
    intent = intentInput as string;
  }

  // Step 5: Output format
  let format: string;

  if (flags.format) {
    format = flags.format;
    p.log.info(`Format: ${format === "vertical" ? "9:16 Vertical" : "16:9 Landscape"}`);
  } else {
    const formatInput = await p.select({
      message: "Output format:",
      options: [
        {
          value: "landscape",
          label: "Original 16:9 (Landscape)",
          hint: "Fast — just cut by timestamps",
        },
        {
          value: "vertical",
          label: "Auto-Track 9:16 (Vertical)",
          hint: "TikTok/Reels — YOLOv8 subject tracking",
        },
      ],
    });
    if (p.isCancel(formatInput)) {
      p.cancel("Cancelled.");
      return process.exit(0);
    }
    format = formatInput as string;
  }

  // Step 6: Extraction pipeline summary
  console.log("");
  p.log.info(
    pc.bold("Pipeline Summary") + "\n" +
    `  Match:   ${selectedMatchLabel}\n` +
    `  Video:   ${videoPath}\n` +
    `  Intent:  ${intent}\n` +
    `  Format:  ${format === "vertical" ? "9:16 Vertical (Auto-Track)" : "16:9 Landscape"}\n` +
    `  Match ID: ${selectedMatchId}`
  );

  if (!flags.nonInteractive) {
    const proceed = await p.confirm({
      message: "Start extraction?",
      initialValue: true,
    });
    if (p.isCancel(proceed) || !proceed) {
      p.cancel("Cancelled.");
      return process.exit(0);
    }
  }

  // Step 7: Run pipeline stages
  const sp = p.spinner();
  const apiKey = resolveCredential("gemini")!;

  // 7a. Probe video metadata
  sp.start("Stage 1/6 — Probing video metadata via FFmpeg...");
  let totalDuration: number;
  try {
    const meta = await probeVideo(videoPath);
    totalDuration = meta.format.duration ?? 0;
    if (totalDuration === 0) {
      sp.stop("Could not determine video duration.");
      return process.exit(1);
    }
  } catch (err) {
    sp.stop("FFmpeg probe failed. Is ffmpeg installed?");
    p.log.error(String(err));
    return process.exit(1);
  }
  sp.stop(`Video duration: ${fmtTime(totalDuration)}`);

  // 7b. Fetch PBP data (best-effort)
  sp.start("Stage 2/6 — Fetching Play-by-Play data from sports-skills...");
  const [sport, eventId] = splitMatchId(selectedMatchId);
  if (sport && eventId) {
    try {
      await executePythonBridge(sport, "playbyplay", { event_id: eventId }, { pythonPath });
    } catch {
      // PBP fetch is best-effort — pipeline continues with Vision-only mode
    }
  }

  // 7c. Search PBP for candidate timestamps (mock for now)
  sp.message(`Stage 3/6 — Scanning PBP for "${intent}"...`);
  const pbpHits = searchPBPTimestamps(selectedMatchId, intent, totalDuration);
  sp.stop(`Found ${pbpHits.length} PBP candidate windows.`);
  for (const hit of pbpHits) {
    p.log.info(`  ${hit.label}`);
  }

  // 7d. Slice chunks around each PBP timestamp
  sp.start("Stage 4/6 — Slicing MP4 chunks via FFmpeg...");
  if (!existsSync(HIGHLIGHTS_DIR)) {
    mkdirSync(HIGHLIGHTS_DIR, { recursive: true });
  }
  const tmpChunkDir = mkdtempSync(join(tmpdir(), "sportsclaw-chunks-"));
  const chunkFiles: { file: string; startSec: number }[] = [];

  for (let i = 0; i < pbpHits.length; i++) {
    const hit = pbpHits[i];
    const startSec = Math.max(0, hit.startSec - CHUNK_DURATION_SEC / 2);
    const duration = Math.min(CHUNK_DURATION_SEC, totalDuration - startSec);
    const chunkFile = join(tmpChunkDir, `chunk_${i}.mp4`);
    try {
      await extractSegment(videoPath, chunkFile, startSec, duration);
      chunkFiles.push({ file: chunkFile, startSec });
    } catch (err) {
      p.log.warn(`Skipping chunk ${i} (FFmpeg error): ${err}`);
    }
  }
  sp.stop(`Sliced ${chunkFiles.length} chunks.`);

  if (chunkFiles.length === 0) {
    p.log.error("No chunks could be extracted. Aborting.");
    return process.exit(1);
  }

  // 7e. Score each chunk with Gemini Vision
  sp.start("Stage 5/6 — Applying Hype Score via Gemini Vision...");
  const scoredChunks: ScoredChunk[] = [];

  for (const chunk of chunkFiles) {
    sp.message(`Scoring chunk @ ${fmtTime(chunk.startSec)} with Gemini...`);
    try {
      const { hypeScore, summary } = await analyzeChunkWithGemini(
        chunk.file,
        intent,
        apiKey,
      );
      scoredChunks.push({
        file: chunk.file,
        startSec: chunk.startSec,
        durationSec: CHUNK_DURATION_SEC,
        hypeScore,
        summary,
      });
    } catch (err) {
      p.log.warn(`Gemini analysis failed for chunk @ ${fmtTime(chunk.startSec)}: ${err}`);
      scoredChunks.push({
        file: chunk.file,
        startSec: chunk.startSec,
        durationSec: CHUNK_DURATION_SEC,
        hypeScore: 0,
        summary: "Analysis failed",
      });
    }
  }
  sp.stop("Hype scoring complete.");

  // 7f. Rank and export top 3 clips
  scoredChunks.sort((a, b) => b.hypeScore - a.hypeScore);
  const topClips = scoredChunks.slice(0, 3);

  p.log.info(pc.bold("Top clips by Hype Score:"));
  for (const clip of topClips) {
    p.log.info(
      `  [${clip.hypeScore}/100] @ ${fmtTime(clip.startSec)} — ${clip.summary}`,
    );
  }

  sp.start("Stage 6/6 — Exporting final highlight clips...");
  const savedFiles: string[] = [];
  for (let i = 0; i < topClips.length; i++) {
    const clip = topClips[i];
    const outFile = join(HIGHLIGHTS_DIR, `highlight_${i + 1}.mp4`);
    try {
      await extractSegment(videoPath, outFile, clip.startSec, clip.durationSec);
      savedFiles.push(outFile);
    } catch (err) {
      p.log.warn(`Failed to export highlight ${i + 1}: ${err}`);
    }
  }
  sp.stop("Export complete.");

  // Clean up temp chunks
  for (const chunk of chunkFiles) {
    rmSync(chunk.file, { force: true });
  }
  rmSync(tmpChunkDir, { recursive: true, force: true });

  if (format === "vertical") {
    p.log.warn(
      "9:16 auto-tracking requires YOLOv8 — not yet implemented. Clips saved as landscape.",
    );
  }

  p.log.success(`${savedFiles.length} highlight clip(s) saved to ${HIGHLIGHTS_DIR}/`);
  for (const f of savedFiles) {
    p.log.info(`  ${f}`);
  }
  p.outro("Ready to post!");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtTime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Split a composite match ID like "nba_401234567" into [sport, eventId].
 * Returns [undefined, undefined] if the format doesn't match.
 */
function splitMatchId(matchId: string): [string | undefined, string | undefined] {
  const idx = matchId.indexOf("_");
  if (idx < 0) return [undefined, undefined];
  return [matchId.slice(0, idx), matchId.slice(idx + 1)];
}
