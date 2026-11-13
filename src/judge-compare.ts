/**
 * sportsclaw — `judge-compare`: one question set, several decision providers, one report.
 *
 * Which provider to trust for a job, and at what confidence, is a measurement. This runs
 * the same cases through each judge and reports, per question, what each one picked, how
 * sure it was, whether the judges agree and — where a case states the expected answer —
 * whether each was right.
 *
 * A case file is JSONL, one case per line:
 *
 *   {"id": "...", "state": <string or JSON>, "questions": {<id>: <question>},
 *    "expected": {<id>: <option id | level number | true/false>}}
 *
 * `expected` is optional, per question. `"images": ["frame.png"]` and `"videos": ["clip.mp4"]`
 * attach files (paths relative to the case file); a judge that cannot read them refuses that case.
 * The report carries ids, picks and numbers only: never a case's state, images or a
 * question's wording.
 */

import type {
  DecisionAnswer,
  DecisionMedia,
  DecisionProvider,
  DecisionProviderName,
  DecisionQuestion,
  DecisionState,
} from "./decision-client.js";
import { decide } from "./inference/decide.js";
import { JUDGE_PROVIDERS, type JudgeConfig } from "./inference/judge.js";

export const JUDGE_COMPARE_USAGE =
  "Usage: sportsclaw judge-compare <cases.jsonl> --cloud-allowed [--judges jev,gemini|jev:jev-1.14.0,...] " +
  "[--out <report.json>] [--timeout <ms>]";

export type JudgeExpected = string | number | boolean;

export interface JudgeCase {
  id: string;
  state: DecisionState;
  questions: Record<string, DecisionQuestion>;
  expected?: Record<string, JudgeExpected>;
  /** Image files the questions are about (png, jpg, jpeg, webp), relative to the case file. */
  images?: string[];
  /** Video files the questions are about (mp4, webm, mov), relative to the case file. */
  videos?: string[];
  /** Those files, loaded. Set by the command; a judge that cannot read media refuses the case. */
  media?: DecisionMedia[];
}

/** What one judge answered: the pick, and the numbers behind it. */
export type JudgePick =
  | { pick: string; confidence: number; /** Top probability minus the runner-up's. */ margin: number; correct?: boolean }
  | { /** The nearest level. */ pick: number; score: number; confidence: number; correct?: boolean }
  | { /** Which side of one half the probability falls on. */ pick: boolean; probability: number; correct?: boolean };

export interface JudgeCompareReport {
  judges: { provider: DecisionProviderName; model: string }[];
  cases: {
    id: string;
    /** Images and videos sent with the case, when it has any. */
    images?: number;
    videos?: number;
    /** Per judge, keyed by model. */
    calls: Record<string, { ok: boolean; reasonCode: string; latencyMs: number }>;
    questions: Record<
      string,
      {
        type: DecisionAnswer["type"];
        expected?: JudgeExpected;
        /** Per judge that answered, keyed by model. */
        answers: Record<string, JudgePick>;
        /** Set when every judge answered the case and there are at least two. */
        agree?: boolean;
      }
    >;
  }[];
  summary: {
    judges: Record<
      string,
      {
        cases: number;
        answered: number;
        failed: Record<string, number>;
        /** Over answered calls. */
        meanLatencyMs?: number;
        /** Answers that had an expected answer to be marked against. */
        expected: number;
        correct: number;
      }
    >;
    /** Questions every judge answered, and those where all picks were the same. */
    agreement: { questions: number; agreed: number };
  };
}

const isRow = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const IMAGE_FILE = /\.(png|jpe?g|webp)$/i;
const VIDEO_FILE = /\.(mp4|webm|mov)$/i;

/** A case's image or video file as media for a request: `read` returns the file's bytes as base64. */
export function judgeMedia(path: string, read: (path: string) => string): DecisionMedia {
  const ext = path.toLowerCase().split(".").pop();
  if (VIDEO_FILE.test(path)) {
    return { kind: "video", data: read(path), mimeType: ext === "webm" ? "video/webm" : ext === "mov" ? "video/quicktime" : "video/mp4" };
  }
  return { kind: "image", data: read(path), mimeType: ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg" };
}

/** Whether `expected` is an answer the question could give. The providers check the question itself. */
function expectedFits(question: unknown, expected: unknown): boolean {
  if (!isRow(question)) return false;
  if (question.type === "choice") {
    return typeof expected === "string" && isRow(question.criteria) && Object.hasOwn(question.criteria, expected);
  }
  if (question.type === "score") {
    return Number.isInteger(expected) && Array.isArray(question.criteria) &&
      (expected as number) >= 0 && (expected as number) < question.criteria.length;
  }
  return question.type === "noul" && typeof expected === "boolean";
}

/** The cases of a JSONL file. Throws with the line number of a case that cannot be used. */
export function parseJudgeCases(text: string): JudgeCase[] {
  const cases: JudgeCase[] = [];
  const seen = new Set<string>();
  text.split("\n").forEach((line, index) => {
    if (line.trim() === "") return;
    const fail = (message: string): never => {
      throw new Error(`line ${index + 1}: ${message}`);
    };
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      fail("not valid JSON");
    }
    if (!isRow(row)) return fail("a case must be a JSON object");
    const { id, state, questions, expected, images, videos } = row;
    if (typeof id !== "string" || id === "") return fail('a case needs an "id"');
    if (seen.has(id)) return fail(`case id "${id}" is already used`);
    if (state === undefined) return fail('a case needs a "state"');
    if (!isRow(questions)) return fail('a case needs a "questions" object');
    if (expected !== undefined) {
      if (!isRow(expected)) return fail('"expected" must be an object keyed by question id');
      for (const [questionId, value] of Object.entries(expected)) {
        if (!expectedFits(questions[questionId], value)) {
          fail(`expected answer for "${questionId}" is not one that question can give`);
        }
      }
    }
    if (images !== undefined && !(Array.isArray(images) && images.every((path) => typeof path === "string" && IMAGE_FILE.test(path)))) {
      return fail('"images" must be a list of png, jpg, jpeg or webp file paths');
    }
    if (videos !== undefined && !(Array.isArray(videos) && videos.every((path) => typeof path === "string" && VIDEO_FILE.test(path)))) {
      return fail('"videos" must be a list of mp4, webm or mov file paths');
    }
    seen.add(id);
    cases.push({ id, state, questions, ...(expected ? { expected } : {}), ...(images ? { images } : {}), ...(videos ? { videos } : {}) } as JudgeCase);
  });
  return cases;
}

export interface JudgeCompareArgs {
  casesPath: string;
  judges: JudgeConfig[];
  /** The user's consent to send each case's state to the providers' hosted services. */
  cloudAllowed: boolean;
  out?: string;
  timeoutMs?: number;
}

/** Parse `judge-compare` arguments. Throws with a user-facing message on bad input. */
export function parseJudgeCompareArgs(argv: readonly string[]): JudgeCompareArgs {
  const positional: string[] = [];
  const values: Record<string, string> = {};
  let cloudAllowed = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--cloud-allowed") {
      cloudAllowed = true;
    } else if (arg.startsWith("--")) {
      const [flag, inline] = arg.split(/=(.*)/s, 2);
      if (!["--judges", "--out", "--timeout"].includes(flag)) throw new Error(`unknown option ${flag}`);
      const value = inline ?? argv[++i];
      if (value === undefined || value === "" || value.startsWith("--")) throw new Error(`${flag} requires a value`);
      values[flag] = value;
    } else {
      positional.push(arg);
    }
  }
  if (positional.length !== 1) throw new Error("give one cases file");

  const judges = (values["--judges"] ?? JUDGE_PROVIDERS.join(",")).split(",").map((spec): JudgeConfig => {
    const [provider, model] = spec.trim().split(":", 2);
    if (!(JUDGE_PROVIDERS as readonly string[]).includes(provider)) {
      throw new Error(`--judges takes ${JUDGE_PROVIDERS.join(", ")}, each optionally as provider:model (got ${JSON.stringify(spec)})`);
    }
    return { provider: provider as DecisionProviderName, ...(model ? { model } : {}) };
  });

  let timeoutMs: number | undefined;
  if (values["--timeout"] !== undefined) {
    timeoutMs = Number(values["--timeout"]);
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error(`--timeout must be a whole number of milliseconds (got ${JSON.stringify(values["--timeout"])})`);
    }
  }
  return {
    casesPath: positional[0],
    judges,
    cloudAllowed,
    ...(values["--out"] !== undefined ? { out: values["--out"] } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
}

function pickOf(answer: DecisionAnswer): JudgePick {
  if (answer.type === "choice") {
    const [top = 0, runnerUp = 0] = Object.values(answer.probabilities).sort((a, b) => b - a);
    return { pick: answer.choice, confidence: answer.confidence, margin: top - runnerUp };
  }
  if (answer.type === "score") {
    return { pick: Math.round(answer.score), score: answer.score, confidence: answer.confidence };
  }
  return { pick: answer.noul >= 0.5, probability: answer.noul };
}

/** Run every case through every judge. Cases run one at a time; a case's judges run together. */
export async function runJudgeCompare(
  cases: readonly JudgeCase[],
  judges: readonly DecisionProvider[],
  onCase?: (done: number, total: number) => void
): Promise<JudgeCompareReport> {
  const models = judges.map((judge) => judge.model);
  const repeated = models.find((model, index) => models.indexOf(model) !== index);
  if (repeated) throw new Error(`two judges use ${repeated}: results are keyed by model, so each must differ`);

  const report: JudgeCompareReport = {
    judges: judges.map(({ provider, model }) => ({ provider, model })),
    cases: [],
    summary: {
      judges: Object.fromEntries(models.map((model) => [model, { cases: 0, answered: 0, failed: {}, expected: 0, correct: 0 }])),
      agreement: { questions: 0, agreed: 0 },
    },
  };
  const latency = new Map(models.map((model) => [model, 0]));

  for (const item of cases) {
    const results = await Promise.all(
      judges.map((judge) => decide({ purpose: "other" }, judge, {
        state: item.state, questions: item.questions, ...(item.media?.length ? { media: item.media } : {}),
      }))
    );
    const videoCount = (item.media ?? []).filter((m) => m.kind === "video").length;
    const imageCount = (item.media?.length ?? 0) - videoCount;
    const entry: JudgeCompareReport["cases"][number] = {
      id: item.id, ...(imageCount ? { images: imageCount } : {}), ...(videoCount ? { videos: videoCount } : {}), calls: {}, questions: {},
    };

    results.forEach((result, index) => {
      const model = models[index];
      const tally = report.summary.judges[model];
      tally.cases += 1;
      entry.calls[model] = {
        ok: result.ok,
        reasonCode: result.ok ? "answered" : result.reasonCode,
        latencyMs: result.receipt.latencyMs,
      };
      if (!result.ok) {
        tally.failed[result.reasonCode] = (tally.failed[result.reasonCode] ?? 0) + 1;
        return;
      }
      tally.answered += 1;
      latency.set(model, (latency.get(model) ?? 0) + result.receipt.latencyMs);
      for (const [questionId, answer] of Object.entries(result.answers)) {
        const expected = item.expected?.[questionId];
        const question = (entry.questions[questionId] ??= {
          type: answer.type,
          ...(expected !== undefined ? { expected } : {}),
          answers: {},
        });
        const pick = pickOf(answer);
        if (expected !== undefined) {
          pick.correct = pick.pick === expected;
          tally.expected += 1;
          if (pick.correct) tally.correct += 1;
        }
        question.answers[model] = pick;
      }
    });

    if (judges.length > 1 && results.every((result) => result.ok)) {
      for (const question of Object.values(entry.questions)) {
        const picks = Object.values(question.answers).map((answer) => answer.pick);
        question.agree = picks.every((pick) => pick === picks[0]);
        report.summary.agreement.questions += 1;
        if (question.agree) report.summary.agreement.agreed += 1;
      }
    }
    report.cases.push(entry);
    onCase?.(report.cases.length, cases.length);
  }

  for (const model of models) {
    const tally = report.summary.judges[model];
    if (tally.answered > 0) tally.meanLatencyMs = Math.round((latency.get(model) ?? 0) / tally.answered);
  }
  return report;
}
