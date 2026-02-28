import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MIN_PYTHON_VERSION = { major: 3, minor: 10 } as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PythonVersionResult {
  ok: boolean;
  version: string;
  major: number;
  minor: number;
  micro: number;
  error?: string;
}

export interface PrerequisiteStatus {
  homebrew: { installed: boolean; path?: string };
  python: { found: boolean; path?: string; version?: string };
  pythonVersion: PythonVersionResult | null;
}

// ---------------------------------------------------------------------------
// Shell quoting helper (existing)
// ---------------------------------------------------------------------------

function shellQuote(value: string): string {
  if (/^[a-zA-Z0-9_./:-]+$/.test(value)) {
    return value;
  }
  return `"${value.replace(/"/g, '\\"')}"`;
}

export function buildSportsSkillsRepairCommand(
  pythonPath: string,
  userInstall = false
): string {
  const userFlag = userInstall ? " --user" : "";
  return `${shellQuote(pythonPath)} -m pip install --upgrade${userFlag} sports-skills`;
}

// ---------------------------------------------------------------------------
// Python version check
// ---------------------------------------------------------------------------

/**
 * Run the given Python interpreter and check its version.
 * Returns `ok: true` only when >= MIN_PYTHON_VERSION.
 */
export function checkPythonVersion(pythonPath: string): PythonVersionResult {
  try {
    const output = execFileSync(
      pythonPath,
      ["-c", "import sys; v=sys.version_info; print(f'{v.major}.{v.minor}.{v.micro}')"],
      { timeout: 10_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
    ).trim();

    const parts = output.split(".");
    if (parts.length < 3) {
      return { ok: false, version: output, major: 0, minor: 0, micro: 0, error: "Could not parse version" };
    }

    const major = Number.parseInt(parts[0], 10);
    const minor = Number.parseInt(parts[1], 10);
    const micro = Number.parseInt(parts[2], 10);

    const ok =
      major > MIN_PYTHON_VERSION.major ||
      (major === MIN_PYTHON_VERSION.major && minor >= MIN_PYTHON_VERSION.minor);

    return { ok, version: output, major, minor, micro };
  } catch (err) {
    return {
      ok: false,
      version: "",
      major: 0,
      minor: 0,
      micro: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// Homebrew detection (macOS)
// ---------------------------------------------------------------------------

export function detectHomebrew(): { installed: boolean; path?: string } {
  if (platform() !== "darwin") {
    return { installed: false };
  }
  try {
    const output = execFileSync("which", ["brew"], {
      timeout: 5_000,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return { installed: true, path: output };
  } catch {
    // Also check common Homebrew paths directly
    for (const p of ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"]) {
      if (existsSync(p)) {
        return { installed: true, path: p };
      }
    }
    return { installed: false };
  }
}

// ---------------------------------------------------------------------------
// Find the best available Python >= 3.10
// ---------------------------------------------------------------------------

const PYTHON_CANDIDATES = [
  "/opt/homebrew/bin/python3",
  "/usr/local/bin/python3",
  "python3.13",
  "python3.12",
  "python3.11",
  "python3.10",
  "python3",
];

/**
 * Probe candidates in priority order.
 * Returns the first one that exists AND is >= 3.10, or `null`.
 */
export function findBestPython(): { path: string; version: PythonVersionResult } | null {
  for (const candidate of PYTHON_CANDIDATES) {
    const result = checkPythonVersion(candidate);
    if (result.ok) {
      return { path: candidate, version: result };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Platform package manager detection
// ---------------------------------------------------------------------------

export type PackageManager = "brew" | "apt" | "dnf" | "pacman";

export function detectPlatformPackageManager(): PackageManager | null {
  const os = platform();
  if (os === "darwin") {
    const hb = detectHomebrew();
    return hb.installed ? "brew" : null;
  }

  // Linux: check common package managers
  const managers: Array<{ bin: string; name: PackageManager }> = [
    { bin: "apt-get", name: "apt" },
    { bin: "dnf", name: "dnf" },
    { bin: "pacman", name: "pacman" },
  ];

  for (const { bin, name } of managers) {
    try {
      execFileSync("which", [bin], {
        timeout: 5_000,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      return name;
    } catch {
      // try next
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Install helpers
// ---------------------------------------------------------------------------

/**
 * Install Homebrew using the official install script.
 * Returns `{ ok: true }` on success.
 */
export function installHomebrew(): { ok: boolean; error?: string } {
  try {
    execFileSync(
      "/bin/bash",
      ["-c", '$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)'],
      { timeout: 300_000, stdio: "inherit" }
    );
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Install Python via the detected platform package manager.
 */
export function installPythonViaPackageManager(
  manager: PackageManager
): { ok: boolean; error?: string } {
  const commands: Record<PackageManager, { bin: string; args: string[] }> = {
    brew: { bin: "brew", args: ["install", "python@3.12"] },
    apt: { bin: "sudo", args: ["apt-get", "install", "-y", "python3"] },
    dnf: { bin: "sudo", args: ["dnf", "install", "-y", "python3"] },
    pacman: { bin: "sudo", args: ["pacman", "-S", "--noconfirm", "python"] },
  };

  const cmd = commands[manager];
  try {
    execFileSync(cmd.bin, cmd.args, { timeout: 300_000, stdio: "inherit" });
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// Orchestrated prerequisite check
// ---------------------------------------------------------------------------

export function checkPrerequisites(): PrerequisiteStatus {
  const homebrew = detectHomebrew();
  const best = findBestPython();

  return {
    homebrew,
    python: best
      ? { found: true, path: best.path, version: best.version.version }
      : { found: false },
    pythonVersion: best ? best.version : null,
  };
}

// ---------------------------------------------------------------------------
// Managed venv at ~/.sportsclaw/venv/
// ---------------------------------------------------------------------------

const VENV_DIR = join(homedir(), ".sportsclaw", "venv");

export function getVenvDir(): string {
  return VENV_DIR;
}

export function getVenvPythonPath(): string {
  return join(VENV_DIR, "bin", "python3");
}

export function isVenvSetup(): boolean {
  return existsSync(getVenvPythonPath());
}

export interface EnsureVenvResult {
  ok: boolean;
  pythonPath: string;
  created?: boolean;
  error?: string;
}

/** The pip install target — includes polymarket extra for trading support */
const PIP_INSTALL_TARGET = "sports-skills[polymarket]";

/**
 * Check whether a Python module is importable in the venv.
 */
function isModuleInstalled(moduleName: string): boolean {
  try {
    execFileSync(
      getVenvPythonPath(),
      ["-c", `import ${moduleName}`],
      { timeout: 10_000, stdio: ["pipe", "pipe", "pipe"] }
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure a managed venv exists at ~/.sportsclaw/venv/.
 * If it already exists, checks for missing extras and installs them.
 * Otherwise creates one using the provided base Python (or auto-detected),
 * and installs sports-skills[polymarket] into it.
 */
export function ensureVenv(basePythonPath?: string): EnsureVenvResult {
  if (isVenvSetup()) {
    // Venv exists — check for missing extras (e.g. py_clob_client for polymarket)
    if (!isModuleInstalled("py_clob_client")) {
      try {
        execFileSync(
          getVenvPythonPath(),
          ["-m", "pip", "install", "--upgrade", PIP_INSTALL_TARGET],
          { timeout: 120_000, stdio: ["pipe", "pipe", "pipe"] }
        );
      } catch {
        // Non-fatal — tools will error at call time with a clear message
      }
    }
    return { ok: true, pythonPath: getVenvPythonPath() };
  }

  const systemPython = basePythonPath ?? findBestPython()?.path ?? "python3";

  try {
    // Ensure parent dir exists
    const parentDir = join(homedir(), ".sportsclaw");
    if (!existsSync(parentDir)) {
      mkdirSync(parentDir, { recursive: true });
    }

    // Create venv
    execFileSync(systemPython, ["-m", "venv", VENV_DIR], {
      timeout: 30_000,
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Install/upgrade pip and sports-skills[polymarket] into it
    execFileSync(
      getVenvPythonPath(),
      ["-m", "pip", "install", "--upgrade", "pip", PIP_INSTALL_TARGET],
      {
        timeout: 120_000,
        stdio: ["pipe", "pipe", "pipe"],
      }
    );

    return { ok: true, pythonPath: getVenvPythonPath(), created: true };
  } catch (err) {
    return {
      ok: false,
      pythonPath: systemPython,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
