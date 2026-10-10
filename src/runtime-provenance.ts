/**
 * sportsclaw Engine — Runtime Provenance
 *
 * Reports which Node, CLI entrypoint, Python interpreter, and sports_skills
 * install are actually in use. The Python probe runs in the same sandboxed env
 * the bridge uses (buildSubprocessEnv), so it sees what tool calls see.
 *
 * Failures are reported as short fixed messages — never raw stderr, which can
 * be unbounded and may echo env or paths from an untrusted install.
 */

import { execFile } from "node:child_process";
import { buildSubprocessEnv } from "./bridge.js";

export interface RuntimeProvenance {
  nodeExecutable: string;
  cliEntrypoint: string | null;
  engineVersion: string;
  pythonPath: string;
  pythonExecutable: string | null;
  sportsSkillsFile: string | null;
  sportsSkillsVersion: string | null;
  probe: { ok: boolean; error?: string };
}

const PROBE_TIMEOUT_MS = 10_000;
const MAX_ERROR_LENGTH = 200;

// Prints one JSON line last; anything sports_skills prints on import comes before it.
const PROBE_SCRIPT = [
  "import json, sys",
  'out = {"executable": sys.executable}',
  "try:",
  "    import sports_skills",
  '    out["file"] = getattr(sports_skills, "__file__", None)',
  '    v = getattr(sports_skills, "__version__", None)',
  '    out["version"] = None if v is None else str(v)',
  "except Exception as e:",
  '    out["importError"] = type(e).__name__',
  "print(json.dumps(out))",
].join("\n");

function describeExecError(err: Error & { code?: string | number; killed?: boolean; signal?: string | null }): string {
  if (err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return "Probe output exceeded the size limit";
  if (err.code === "ENOENT") return "Python interpreter not found at configured path";
  if (err.code === "EACCES" || err.code === "EPERM") return "Python interpreter is not executable";
  if (err.killed || err.signal) return `Probe timed out or was killed after ${PROBE_TIMEOUT_MS / 1000}s`;
  if (typeof err.code === "number") return `Probe exited with code ${err.code}`;
  return "Probe failed to run";
}

export async function probeRuntimeProvenance(
  pythonPath: string,
  engineVersion: string
): Promise<RuntimeProvenance> {
  const result: RuntimeProvenance = {
    nodeExecutable: process.execPath,
    cliEntrypoint: process.argv[1] ?? null,
    engineVersion,
    pythonPath,
    pythonExecutable: null,
    sportsSkillsFile: null,
    sportsSkillsVersion: null,
    probe: { ok: false },
  };

  // -B: don't write __pycache__ into the sports_skills install.
  const stdout = await new Promise<string | Error>((resolve) => {
    execFile(
      pythonPath,
      ["-B", "-c", PROBE_SCRIPT],
      { encoding: "utf-8", timeout: PROBE_TIMEOUT_MS, env: buildSubprocessEnv() },
      (err, out) => resolve(err ?? out)
    );
  });
  if (stdout instanceof Error) {
    result.probe.error = describeExecError(stdout);
    return result;
  }

  let parsed: { executable?: unknown; file?: unknown; version?: unknown; importError?: unknown };
  try {
    parsed = JSON.parse(stdout.trim().split("\n").pop() ?? "");
  } catch {
    result.probe.error = "Probe returned unparseable output";
    return result;
  }

  const str = (v: unknown) => (typeof v === "string" ? v : null);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    result.probe.error = "Probe returned unparseable output";
    return result;
  }
  result.pythonExecutable = str(parsed.executable);
  if (parsed.importError !== undefined) {
    result.probe.error = `sports_skills import failed: ${String(parsed.importError)}`.slice(0, MAX_ERROR_LENGTH);
    return result;
  }
  result.sportsSkillsFile = str(parsed.file);
  result.sportsSkillsVersion = str(parsed.version);
  result.probe.ok = true;
  return result;
}
