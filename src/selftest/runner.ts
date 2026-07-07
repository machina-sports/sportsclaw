import { SMOKE_TESTS, type SmokeTestCase } from "./cases.js";
import type { SelfTestReport, SmokeResult } from "./report.js";

interface RunOptions {
  sports?: string[];
  live?: boolean;
  version?: string;
  execute?: (c: SmokeTestCase) => Promise<{ ok: boolean; note?: string; latencyMs: number }>;
}

export async function runSelftest(opts: RunOptions): Promise<SelfTestReport> {
  const version = opts.version ?? "0.0.0";
  const live = opts.live ?? false;
  const cases = SMOKE_TESTS.filter((c) => !opts.sports || opts.sports.includes(c.sport));

  const results: SmokeResult[] = [];
  for (const c of cases) {
    if (c.live !== false && !live) {
      results.push({ sport: c.sport, check: c.name, status: "skip", latencyMs: 0, notes: "offline (use --live)" });
      continue;
    }
    if (!opts.execute) {
      results.push({ sport: c.sport, check: c.name, status: "skip", latencyMs: 0, notes: "no executor" });
      continue;
    }
    const r = await opts.execute(c);
    results.push({
      sport: c.sport,
      check: c.name,
      status: r.ok ? "pass" : "fail",
      latencyMs: r.latencyMs,
      notes: r.note ?? "",
    });
  }

  const passed = results.filter((r) => r.status === "pass").length;
  const failed = results.filter((r) => r.status === "fail").length;
  const skipped = results.filter((r) => r.status === "skip").length;

  return {
    version, passed, failed, skipped, results,
    toJSON() {
      return { version, passed, failed, skipped, results };
    },
  };
}
