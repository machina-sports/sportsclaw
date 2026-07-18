export interface SmokeResult {
  sport: string;
  check: string;
  status: "pass" | "fail" | "skip";
  latencyMs: number;
  notes: string;
}

export interface SelfTestReport {
  version: string;
  passed: number;
  failed: number;
  skipped: number;
  results: SmokeResult[];
  toJSON(): Record<string, unknown>;
}

export function renderMarkdown(report: SelfTestReport): string {
  const lines = [
    "| Sport | Check | Status | Latency | Notes |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const r of report.results) {
    lines.push(`| ${r.sport} | ${r.check} | ${r.status} | ${r.latencyMs}ms | ${r.notes} |`);
  }
  lines.push("");
  lines.push(`**${report.passed} passed, ${report.failed} failed, ${report.skipped} skipped**`);
  return lines.join("\n");
}
