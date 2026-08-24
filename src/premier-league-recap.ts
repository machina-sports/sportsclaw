import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { executePythonBridge } from "./bridge.js";
import { resolveConfig } from "./config.js";

const PREMIER_LEAGUE = "premier-league";
const CLOSED_STATUSES = new Set([
  "closed",
  "complete",
  "completed",
  "final",
  "finished",
  "full time",
  "full-time",
  "ft",
  "post",
  "status_final",
]);
const PACKAGE_FILES = [
  "evidence.json",
  "concept.md",
  "style.json",
  "scenes.json",
  "overlays.json",
  "qa.json",
  "receipts.jsonl",
  "RESULTS.md",
] as const;

type JsonRecord = Record<string, unknown>;

export interface RecapFixture {
  eventId: string;
  matchweek: number;
  status: string;
  kickoff: string | null;
  homeTeam: string;
  awayTeam: string;
  homeScore: string | null;
  awayScore: string | null;
  raw: JsonRecord;
}

export interface RecapOptions {
  outputRoot?: string;
  seasonId?: string;
  matchweek?: number;
  asOf?: Date;
  generate?: boolean;
  imageCommand?: string[];
  videoCommand?: string[];
}

export interface RecapResult {
  outputDir: string;
  evidenceHash: string;
  seasonId: string;
  matchweek: number;
  deduped: boolean;
  generated: boolean;
}

export interface RecapDependencies {
  fetch: (command: string, args: Record<string, unknown>) => Promise<unknown>;
  runProvider: (command: string[], cwd: string, env: NodeJS.ProcessEnv) => Promise<ProviderResult>;
}

interface ProviderResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface SourceReceipt {
  type: "sports-skills" | "provider";
  command: string;
  args?: Record<string, unknown>;
  status: "ok" | "failed";
  exitCode?: number;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function firstString(record: JsonRecord, keys: string[]): string {
  for (const key of keys) {
    const value = stringValue(record[key]);
    if (value) return value;
  }
  return "";
}

function nestedRecord(record: JsonRecord, key: string): JsonRecord | undefined {
  const value = record[key];
  return isRecord(value) ? value : undefined;
}

function unwrapEnvelope(value: unknown): unknown {
  if (!isRecord(value)) return value;
  if (value.status === true && "data" in value) return value.data;
  return value;
}

function parseNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  const text = stringValue(value);
  if (!text) return null;
  const direct = /^\d+$/.exec(text);
  if (direct) return Number.parseInt(direct[0], 10);
  const labeled = /(?:matchweek|matchday|gameweek|week|round)\D*(\d+)/i.exec(text);
  return labeled ? Number.parseInt(labeled[1], 10) : null;
}

function matchweekOf(record: JsonRecord): number | null {
  for (const key of ["matchweek", "match_week", "gameweek", "game_week", "week", "round"]) {
    const direct = parseNumber(record[key]);
    if (direct !== null) return direct;
    if (isRecord(record[key])) {
      const nested = record[key] as JsonRecord;
      for (const nestedKey of ["number", "value", "name", "label", "displayName"]) {
        const parsed = parseNumber(nested[nestedKey]);
        if (parsed !== null) return parsed;
      }
    }
  }
  for (const key of ["round_name", "roundName", "week_name", "matchweek_name", "label", "title"]) {
    const parsed = parseNumber(record[key]);
    if (parsed !== null) return parsed;
  }
  return null;
}

function teamName(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!isRecord(value)) return "";
  return firstString(value, ["displayName", "display_name", "shortDisplayName", "short_name", "name", "abbreviation"]);
}

function competitors(record: JsonRecord): JsonRecord[] {
  return Array.isArray(record.competitors) ? record.competitors.filter(isRecord) : [];
}

function competitor(record: JsonRecord, side: "home" | "away"): JsonRecord | undefined {
  const competitors = record.competitors;
  if (!Array.isArray(competitors)) return undefined;
  return competitors.find((entry) => {
    if (!isRecord(entry)) return false;
    return firstString(entry, ["homeAway", "home_away", "side", "qualifier"]).toLowerCase() === side;
  }) as JsonRecord | undefined;
}

function fixtureTeam(record: JsonRecord, side: "home" | "away"): string {
  const snake = `${side}_team`;
  const camel = `${side}Team`;
  const direct = teamName(record[snake]) || teamName(record[camel]) || firstString(record, [`${side}_team_name`, `${side}TeamName`]);
  if (direct) return direct;
  const sideRecord = competitor(record, side) ?? competitors(record)[side === "home" ? 0 : 1];
  if (!sideRecord) return "";
  return teamName(sideRecord.team) || teamName(sideRecord.competitor) || teamName(sideRecord);
}

function fixtureScore(record: JsonRecord, side: "home" | "away"): string | null {
  const value = record[`${side}_score`] ?? record[`${side}Score`];
  const direct = stringValue(value);
  if (direct) return direct;
  const score = nestedRecord(record, "score");
  const nested = score ? stringValue(score[side]) : "";
  if (nested) return nested;
  const sideRecord = competitor(record, side) ?? competitors(record)[side === "home" ? 0 : 1];
  if (!sideRecord) return null;
  const competitorScore = stringValue(sideRecord.score);
  if (competitorScore) return competitorScore;
  const scoreRecord = nestedRecord(sideRecord, "score");
  return scoreRecord ? firstString(scoreRecord, ["displayValue", "display_value", "value"]) || null : null;
}

function fixtureStatus(record: JsonRecord): string {
  const direct = firstString(record, ["status", "state", "status_type", "statusType"]);
  if (direct) return direct.toLowerCase();
  for (const key of ["status", "state"]) {
    const status = nestedRecord(record, key);
    if (!status) continue;
    if (status.completed === true) return "completed";
    const value = firstString(status, ["state", "type", "name", "description", "detail"]);
    if (value) return value.toLowerCase();
    const type = nestedRecord(status, "type");
    if (type) {
      if (type.completed === true) return "completed";
      const typeValue = firstString(type, ["state", "name", "description", "detail"]);
      if (typeValue) return typeValue.toLowerCase();
    }
  }
  if (record.completed === true) return "completed";
  return "";
}

function kickoffOf(record: JsonRecord): string | null {
  const value = firstString(record, ["date", "start_date", "startDate", "kickoff", "kickoff_at", "start_time", "startTime"]);
  return value || null;
}

function looksLikeFixture(record: JsonRecord): boolean {
  const hasTeams = Boolean(fixtureTeam(record, "home") && fixtureTeam(record, "away"));
  return hasTeams && matchweekOf(record) !== null;
}

function collectArrays(value: unknown, arrays: JsonRecord[][], depth = 0): void {
  if (depth > 8) return;
  if (Array.isArray(value)) {
    const records = value.filter(isRecord);
    if (records.length > 0) arrays.push(records);
    for (const item of value) collectArrays(item, arrays, depth + 1);
    return;
  }
  if (isRecord(value)) {
    for (const child of Object.values(value)) collectArrays(child, arrays, depth + 1);
  }
}

export function extractScheduleFixtures(schedule: unknown): RecapFixture[] {
  const arrays: JsonRecord[][] = [];
  collectArrays(schedule, arrays);
  let candidate = arrays
    .map((items) => ({ items, score: items.filter(looksLikeFixture).length }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || b.items.length - a.items.length)[0];
  if (!candidate) {
    candidate = arrays
      .map((items) => ({
        items,
        score: items.filter((raw) => Boolean(fixtureTeam(raw, "home") && fixtureTeam(raw, "away") && kickoffOf(raw))).length,
      }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score || b.items.length - a.items.length)[0];
  }
  if (!candidate) return [];

  const explicit = candidate.items.filter(looksLikeFixture);
  if (explicit.length > 0) {
    return explicit.map((raw) => ({
      eventId: firstString(raw, ["event_id", "eventId", "id", "uid"]),
      matchweek: matchweekOf(raw) as number,
      status: fixtureStatus(raw),
      kickoff: kickoffOf(raw),
      homeTeam: fixtureTeam(raw, "home"),
      awayTeam: fixtureTeam(raw, "away"),
      homeScore: fixtureScore(raw, "home"),
      awayScore: fixtureScore(raw, "away"),
      raw,
    }));
  }

  // Current football schedules can omit round/matchweek labels while returning
  // the completed season-to-date sequence in kickoff order. Assign provisional
  // ten-fixture blocks; the strict gate below refuses a partial current block,
  // empty IDs, or open fixtures before any package/generation step.
  const unlabeled = candidate.items
    .filter((raw) => Boolean(fixtureTeam(raw, "home") && fixtureTeam(raw, "away") && kickoffOf(raw)))
    .sort((a, b) => Date.parse(kickoffOf(a) as string) - Date.parse(kickoffOf(b) as string));
  if (unlabeled.length === 0) return [];
  return unlabeled.map((raw, index) => ({
    eventId: firstString(raw, ["event_id", "eventId", "id", "uid"]),
    matchweek: Math.floor(index / 10) + 1,
    status: fixtureStatus(raw),
    kickoff: kickoffOf(raw),
    homeTeam: fixtureTeam(raw, "home"),
    awayTeam: fixtureTeam(raw, "away"),
    homeScore: fixtureScore(raw, "home"),
    awayScore: fixtureScore(raw, "away"),
    raw,
  }));
}

export function selectTargetMatchweek(fixtures: RecapFixture[], asOf: Date, requested?: number): number {
  if (!Number.isFinite(asOf.getTime())) throw new Error("Invalid --as-of date.");
  const grouped = new Map<number, RecapFixture[]>();
  for (const fixture of fixtures) {
    const group = grouped.get(fixture.matchweek) ?? [];
    group.push(fixture);
    grouped.set(fixture.matchweek, group);
  }
  if (requested !== undefined) {
    if (!grouped.has(requested)) throw new Error(`Matchweek ${requested} was not found in the season schedule.`);
    return requested;
  }

  const dated = [...grouped.entries()]
    .map(([matchweek, games]) => {
      const dates = games.map((game) => game.kickoff ? Date.parse(game.kickoff) : Number.NaN).filter(Number.isFinite);
      return { matchweek, latestKickoff: dates.length > 0 ? Math.max(...dates) : Number.NaN };
    })
    .filter(({ latestKickoff }) => Number.isFinite(latestKickoff) && latestKickoff <= asOf.getTime())
    .sort((a, b) => b.latestKickoff - a.latestKickoff || b.matchweek - a.matchweek);
  if (dated[0]) return dated[0].matchweek;

  const statusFallback = [...grouped.entries()]
    .filter(([, games]) => games.some((game) => CLOSED_STATUSES.has(game.status)))
    .map(([matchweek]) => matchweek)
    .sort((a, b) => b - a);
  if (statusFallback[0] !== undefined) return statusFallback[0];
  throw new Error("Could not identify a started Premier League matchweek from the season schedule.");
}

function assertEvidenceGate(fixtures: RecapFixture[], matchweek: number): void {
  const errors: string[] = [];
  if (fixtures.length !== 10) errors.push(`expected exactly 10 fixtures, found ${fixtures.length}`);
  const emptyIds = fixtures.filter((fixture) => !fixture.eventId).length;
  if (emptyIds > 0) errors.push(`${emptyIds} fixture(s) have empty event IDs`);
  const open = fixtures.filter((fixture) => !CLOSED_STATUSES.has(fixture.status));
  if (open.length > 0) {
    errors.push(`${open.length} fixture(s) are not closed: ${open.map((fixture) => fixture.eventId || "<missing-id>").join(", ")}`);
  }
  if (errors.length > 0) throw new Error(`Refusing Premier League matchweek ${matchweek} recap: ${errors.join("; ")}.`);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableValue).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function evidenceHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

function seasonFor(date: Date): string {
  const year = date.getUTCMonth() >= 6 ? date.getUTCFullYear() : date.getUTCFullYear() - 1;
  return `${PREMIER_LEAGUE}-${year}`;
}

function extractFplIds(leaders: unknown): string[] {
  const ids = new Set<string>();
  const visit = (value: unknown, depth = 0): void => {
    if (depth > 8) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (!isRecord(value)) return;
    const id = firstString(value, ["fpl_id", "fplId"]);
    if (id) ids.add(id);
    for (const child of Object.values(value)) visit(child, depth + 1);
  };
  visit(leaders);
  return [...ids].sort((a, b) => a.localeCompare(b)).slice(0, 3);
}

function resultText(fixture: RecapFixture): string {
  const score = fixture.homeScore !== null && fixture.awayScore !== null
    ? ` ${fixture.homeScore}-${fixture.awayScore}`
    : "";
  return `${fixture.homeTeam}${score} ${fixture.awayTeam}`;
}

function providerCommandFromEnv(name: string): string[] | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${name} must be a JSON array of command arguments.`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((part) => typeof part !== "string" || part.length === 0)) {
    throw new Error(`${name} must be a non-empty JSON string array.`);
  }
  return parsed as string[];
}

function runProvider(command: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<ProviderResult> {
  return new Promise((resolvePromise, reject) => {
    execFile(command[0], command.slice(1), { cwd, env, timeout: 10 * 60_000, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const code = typeof error.code === "number" ? error.code : 1;
        resolvePromise({ exitCode: code, stdout: stdout ?? "", stderr: stderr ?? error.message });
        return;
      }
      resolvePromise({ exitCode: 0, stdout: stdout ?? "", stderr: stderr ?? "" });
    }).once("error", reject);
  });
}

async function defaultFetch(command: string, args: Record<string, unknown>): Promise<unknown> {
  const { pythonPath } = resolveConfig();
  const result = await executePythonBridge("football", command, args, { pythonPath, timeout: 60_000 }, "football");
  if (!result.success) throw new Error(`sports-skills football ${command} failed: ${result.error ?? result.stderr ?? "unknown error"}`);
  return result.data;
}

async function safeOutputRoot(rawRoot: string): Promise<string> {
  const repositoryRoot = resolve(process.cwd());
  const outputRoot = resolve(repositoryRoot, rawRoot);
  const pathFromRepository = relative(repositoryRoot, outputRoot);
  if (pathFromRepository === ".." || pathFromRepository.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error("--output-root must resolve inside the current repository.");
  }
  let current = repositoryRoot;
  for (const part of pathFromRepository.split(/[\\/]/).filter(Boolean)) {
    current = resolve(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new Error("--output-root must not traverse symbolic links.");
      }
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") break;
      throw error;
    }
  }
  return outputRoot;
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export async function createPremierLeagueRecap(
  options: RecapOptions = {},
  dependencies: Partial<RecapDependencies> = {},
): Promise<RecapResult> {
  const fetch = dependencies.fetch ?? defaultFetch;
  const executeProvider = dependencies.runProvider ?? runProvider;
  const asOf = options.asOf ?? new Date();
  if (!Number.isFinite(asOf.getTime())) throw new Error("--as-of must be a valid ISO date.");
  const seasonId = options.seasonId ?? seasonFor(asOf);
  if (!/^premier-league-\d{4}$/.test(seasonId)) {
    throw new Error('--season-id must use the form "premier-league-YYYY".');
  }

  const scheduleArgs = { season_id: seasonId };
  const schedule = unwrapEnvelope(await fetch("get_season_schedule", scheduleArgs));
  const allFixtures = extractScheduleFixtures(schedule);
  const matchweek = selectTargetMatchweek(allFixtures, asOf, options.matchweek);
  const fixtures = allFixtures
    .filter((fixture) => fixture.matchweek === matchweek)
    .sort((a, b) => {
      const aTime = a.kickoff ? Date.parse(a.kickoff) : Number.MAX_SAFE_INTEGER;
      const bTime = b.kickoff ? Date.parse(b.kickoff) : Number.MAX_SAFE_INTEGER;
      return aTime - bTime || a.eventId.localeCompare(b.eventId);
    });
  assertEvidenceGate(fixtures, matchweek);

  const [standings, leaders] = await Promise.all([
    fetch("get_season_standings", { season_id: seasonId }).then(unwrapEnvelope),
    fetch("get_season_leaders", { season_id: seasonId }).then(unwrapEnvelope),
  ]);
  const fplIds = extractFplIds(leaders);
  const profiles = await Promise.all(fplIds.map(async (fplId) => ({
    fplId,
    data: unwrapEnvelope(await fetch("get_player_profile", { fpl_id: fplId })),
  })));

  const hashInput = { seasonId, matchweek, fixtures: fixtures.map((fixture) => fixture.raw), standings, leaders, profiles };
  const hash = evidenceHash(hashInput);
  const outputRoot = await safeOutputRoot(options.outputRoot ?? "review-packages");
  const packageName = `${seasonId}-mw-${String(matchweek).padStart(2, "0")}-${hash.slice(0, 12)}`;
  const outputDir = resolve(outputRoot, packageName);
  const evidencePath = resolve(outputDir, "evidence.json");
  try {
    const [existingText] = await Promise.all(PACKAGE_FILES.map((file) => readFile(resolve(outputDir, file), "utf-8")));
    const existing = JSON.parse(existingText) as { evidenceHash?: unknown };
    if (existing.evidenceHash === hash) {
      return { outputDir, evidenceHash: hash, seasonId, matchweek, deduped: true, generated: false };
    }
  } catch {
    // A missing or invalid package is rebuilt below.
  }

  const evidenceItems = [
    ...fixtures.map((fixture) => ({ ref: `fixture:${fixture.eventId}`, kind: "fixture", data: fixture })),
    { ref: "source:standings", kind: "standings", data: standings },
    { ref: "source:leaders", kind: "leaders", data: leaders },
    ...profiles.map((profile) => ({ ref: `profile:fpl:${profile.fplId}`, kind: "fpl-profile", data: profile.data })),
  ];
  const evidence = {
    schemaVersion: 1,
    evidenceHash: hash,
    competition: "Premier League",
    seasonId,
    matchweek,
    asOf: asOf.toISOString(),
    gate: { fixtureCount: fixtures.length, eventIdsNonEmpty: true, allClosed: true },
    evidenceItems,
    rawSources: { schedule, standings, leaders, profiles },
  };
  const facts = fixtures.map((fixture) => ({ text: resultText(fixture), evidenceRefs: [`fixture:${fixture.eventId}`] }));
  const scenes = {
    schemaVersion: 1,
    evidenceHash: hash,
    scenes: [
      {
        id: "opening",
        title: `Premier League Matchweek ${matchweek} recap`,
        durationSeconds: 5,
        facts: [{ text: `All 10 Matchweek ${matchweek} fixtures are closed.`, evidenceRefs: fixtures.map((fixture) => `fixture:${fixture.eventId}`) }],
      },
      ...fixtures.map((fixture, index) => ({
        id: `result-${String(index + 1).padStart(2, "0")}`,
        title: `${fixture.homeTeam} vs ${fixture.awayTeam}`,
        durationSeconds: 4,
        facts: [{ text: resultText(fixture), evidenceRefs: [`fixture:${fixture.eventId}`] }],
      })),
      {
        id: "context",
        title: "Table and leaders",
        durationSeconds: 6,
        facts: [
          { text: "Standings snapshot loaded for editorial review.", evidenceRefs: ["source:standings"] },
          { text: "Season leaders snapshot loaded for editorial review.", evidenceRefs: ["source:leaders"] },
        ],
      },
    ],
  };
  const overlays = {
    schemaVersion: 1,
    evidenceHash: hash,
    overlays: fixtures.map((fixture, index) => ({
      id: `score-${String(index + 1).padStart(2, "0")}`,
      sceneId: `result-${String(index + 1).padStart(2, "0")}`,
      text: resultText(fixture),
      evidenceRefs: [`fixture:${fixture.eventId}`],
    })),
  };
  const style = {
    schemaVersion: 1,
    evidenceHash: hash,
    format: "review-package",
    aspectRatio: "16:9",
    palette: { background: "#101820", foreground: "#ffffff", accent: "#00ff85" },
    typography: { headline: "bold condensed sans", body: "neutral sans" },
    motion: "reserved scoreboard transitions; no generated media in dry-run mode",
  };
  const validRefs = new Set(evidenceItems.map((item) => item.ref));
  const referenced = [
    ...scenes.scenes.flatMap((scene) => scene.facts.flatMap((fact) => fact.evidenceRefs)),
    ...overlays.overlays.flatMap((overlay) => overlay.evidenceRefs),
  ];
  const missingRefs = [...new Set(referenced.filter((ref) => !validRefs.has(ref)))];
  const qa = {
    schemaVersion: 1,
    evidenceHash: hash,
    passed: missingRefs.length === 0,
    checks: {
      fixtureCount: fixtures.length === 10,
      eventIdsNonEmpty: fixtures.every((fixture) => fixture.eventId.length > 0),
      allFixturesClosed: fixtures.every((fixture) => CLOSED_STATUSES.has(fixture.status)),
      everyFactTraceable: missingRefs.length === 0,
      generationRequested: options.generate === true,
      publishingEnabled: false,
    },
    missingEvidenceRefs: missingRefs,
  };
  const concept = [
    `# Premier League Matchweek ${matchweek} Monday Recap`,
    "",
    "A review-first recap package. Media generation and publishing are disabled by default.",
    "",
    "## Editorial Spine",
    "",
    ...facts.map((fact) => `- ${fact.text} [${fact.evidenceRefs.join(", ")}]`),
    "",
    "## Context",
    "",
    "- Verify table implications against [source:standings].",
    "- Verify player-leader framing against [source:leaders].",
    ...profiles.map((profile) => `- Optional FPL profile available at [profile:fpl:${profile.fplId}].`),
    "",
  ].join("\n");
  const sourceReceipts: SourceReceipt[] = [
    { type: "sports-skills", command: "football get_season_schedule", args: scheduleArgs, status: "ok" },
    { type: "sports-skills", command: "football get_season_standings", args: { season_id: seasonId }, status: "ok" },
    { type: "sports-skills", command: "football get_season_leaders", args: { season_id: seasonId }, status: "ok" },
    ...profiles.map((profile) => ({ type: "sports-skills" as const, command: "football get_player_profile", args: { fpl_id: profile.fplId }, status: "ok" as const })),
  ];

  await mkdir(outputDir, { recursive: true });
  await Promise.all([
    writeFile(evidencePath, json(evidence), "utf-8"),
    writeFile(resolve(outputDir, "concept.md"), concept, "utf-8"),
    writeFile(resolve(outputDir, "style.json"), json(style), "utf-8"),
    writeFile(resolve(outputDir, "scenes.json"), json(scenes), "utf-8"),
    writeFile(resolve(outputDir, "overlays.json"), json(overlays), "utf-8"),
    writeFile(resolve(outputDir, "qa.json"), json(qa), "utf-8"),
  ]);

  const providerReceipts: SourceReceipt[] = [];
  let generated = false;
  if (options.generate) {
    const commands = [
      options.imageCommand ?? providerCommandFromEnv("SPORTSCLAW_RECAP_IMAGE_COMMAND"),
      options.videoCommand ?? providerCommandFromEnv("SPORTSCLAW_RECAP_VIDEO_COMMAND"),
    ].filter((command): command is string[] => command !== undefined);
    if (commands.length === 0) {
      throw new Error("--generate requires SPORTSCLAW_RECAP_IMAGE_COMMAND and/or SPORTSCLAW_RECAP_VIDEO_COMMAND as a JSON command array.");
    }
    for (const command of commands) {
      const providerResult = await executeProvider(command, outputDir, {
        ...process.env,
        SPORTSCLAW_REVIEW_PACKAGE_DIR: outputDir,
        SPORTSCLAW_EVIDENCE_HASH: hash,
      });
      providerReceipts.push({
        type: "provider",
        command: command.join(" "),
        status: providerResult.exitCode === 0 ? "ok" : "failed",
        exitCode: providerResult.exitCode,
      });
      if (providerResult.exitCode !== 0) {
        await writeFile(resolve(outputDir, "receipts.jsonl"), [...sourceReceipts, ...providerReceipts].map((receipt) => JSON.stringify(receipt)).join("\n") + "\n", "utf-8");
        throw new Error(`Generation provider failed (${command[0]}): ${providerResult.stderr.trim() || `exit ${providerResult.exitCode}`}`);
      }
    }
    generated = true;
  }

  const receipts = [...sourceReceipts, ...providerReceipts];
  const results = [
    `# Results: Premier League Matchweek ${matchweek}`,
    "",
    `- Evidence hash: \`${hash}\``,
    `- Evidence gate: PASS (${fixtures.length} fixtures, all IDs present, all closed)`,
    `- Review package: \`${outputDir}\``,
    `- Generation: ${generated ? "completed" : "not requested (dry run)"}`,
    "- Publishing: disabled",
    `- QA: ${qa.passed ? "PASS" : "FAIL"}`,
    "",
  ].join("\n");
  await Promise.all([
    writeFile(resolve(outputDir, "receipts.jsonl"), receipts.map((receipt) => JSON.stringify(receipt)).join("\n") + "\n", "utf-8"),
    writeFile(resolve(outputDir, "RESULTS.md"), results, "utf-8"),
  ]);

  return { outputDir, evidenceHash: hash, seasonId, matchweek, deduped: false, generated };
}

function valueAfter(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return value;
}

export async function cmdPremierLeagueRecap(args: string[]): Promise<void> {
  const target = args[0];
  if (target !== "premier-league" && target !== "premier-league-monday") {
    throw new Error("Usage: sportsclaw recap premier-league [--output-root <path>] [--season-id <id>] [--matchweek <n>] [--as-of <ISO>] [--generate]");
  }
  const options: RecapOptions = {};
  for (let index = 1; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--generate") options.generate = true;
    else if (arg === "--dry-run") options.generate = false;
    else if (arg === "--publish") throw new Error("Publishing is not supported by the review-package command.");
    else if (arg === "--output-root") options.outputRoot = valueAfter(args, index++, arg);
    else if (arg.startsWith("--output-root=")) options.outputRoot = arg.slice("--output-root=".length);
    else if (arg === "--season-id") options.seasonId = valueAfter(args, index++, arg);
    else if (arg.startsWith("--season-id=")) options.seasonId = arg.slice("--season-id=".length);
    else if (arg === "--matchweek") options.matchweek = Number.parseInt(valueAfter(args, index++, arg), 10);
    else if (arg.startsWith("--matchweek=")) options.matchweek = Number.parseInt(arg.slice("--matchweek=".length), 10);
    else if (arg === "--as-of") options.asOf = new Date(valueAfter(args, index++, arg));
    else if (arg.startsWith("--as-of=")) options.asOf = new Date(arg.slice("--as-of=".length));
    else throw new Error(`Unknown recap option: ${arg}`);
  }
  if (options.matchweek !== undefined && (!Number.isInteger(options.matchweek) || options.matchweek < 1 || options.matchweek > 38)) {
    throw new Error("--matchweek must be an integer from 1 to 38.");
  }
  const result = await createPremierLeagueRecap(options);
  console.log(result.deduped ? `Review package already exists: ${result.outputDir}` : `Review package written: ${result.outputDir}`);
  console.log(`Evidence hash: ${result.evidenceHash}`);
  console.log(`Generation: ${result.generated ? "completed" : "not requested (dry run)"}; publishing: disabled`);
}
