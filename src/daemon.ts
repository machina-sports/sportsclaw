/**
 * sportsclaw — Daemon Management (PM2 wrapper)
 *
 * Delegates process lifecycle to PM2 instead of manual PID files and spawn.
 * Each listener runs as a named PM2 process: `sportsclaw-<platform>`.
 */

import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DaemonPlatform = "discord" | "telegram";
const VALID_PLATFORMS: DaemonPlatform[] = ["discord", "telegram"];

export function isValidPlatform(value: string): value is DaemonPlatform {
  return VALID_PLATFORMS.includes(value as DaemonPlatform);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** PM2 process name for a given platform. */
function pm2Name(platform: DaemonPlatform): string {
  return `sportsclaw-${platform}`;
}

/** Resolve the compiled entry point (dist/index.js). */
function entryPoint(): string {
  return fileURLToPath(new URL("../dist/index.js", import.meta.url));
}

/** Verify PM2 is installed and accessible. Exits with guidance if missing. */
function requirePm2(): void {
  try {
    execSync("which pm2", { stdio: "ignore" });
  } catch {
    console.error(
      'PM2 is required to run background processes. Install it via `npm install -g pm2` or use the official install script: `curl -fsSL https://sportsclaw.gg/install.sh | bash`'
    );
    process.exit(1);
  }
}

/** Run a pm2 command and return stdout. */
function pm2Exec(args: string, quiet = false): string {
  try {
    return execSync(`pm2 ${args}`, {
      encoding: "utf-8",
      stdio: quiet ? ["ignore", "pipe", "ignore"] : ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (err: unknown) {
    if (!quiet) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`pm2 error: ${msg}`);
    }
    return "";
  }
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

export function daemonStart(platform: DaemonPlatform): void {
  requirePm2();

  const name = pm2Name(platform);
  const entry = entryPoint();

  // Check if already running
  const info = pm2Exec(`show ${name}`, true);
  if (info.includes("online")) {
    console.error(`${platform} daemon is already running.`);
    console.error(`Stop it first with: sportsclaw stop ${platform}`);
    process.exit(1);
  }

  // Start via PM2 — args after `--` are forwarded to the script
  execSync(`pm2 start ${entry} --name ${name} -- listen ${platform}`, {
    stdio: "inherit",
  });

  console.log(`${platform} daemon started via PM2.`);
  console.log(`  Status: sportsclaw status`);
  console.log(`  Logs:   sportsclaw logs ${platform}`);
  console.log(`  Stop:   sportsclaw stop ${platform}`);
}

// ---------------------------------------------------------------------------
// Stop
// ---------------------------------------------------------------------------

export function daemonStop(platform: DaemonPlatform): void {
  requirePm2();

  const name = pm2Name(platform);

  try {
    execSync(`pm2 stop ${name}`, { stdio: "inherit" });
    execSync(`pm2 delete ${name}`, { stdio: "ignore" });
  } catch {
    console.error(`${platform} daemon is not running or already stopped.`);
    process.exit(1);
  }

  console.log(`${platform} daemon stopped.`);
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export function daemonStatus(): void {
  requirePm2();

  // pm2 jlist outputs JSON; filter to sportsclaw processes
  const raw = pm2Exec("jlist", true);
  if (!raw) {
    console.log("No daemons running.");
    console.log("");
    console.log("Start one with: sportsclaw start <discord|telegram>");
    return;
  }

  let procs: Array<{ name: string; pm2_env?: { status?: string }; pid?: number }>;
  try {
    procs = JSON.parse(raw);
  } catch {
    // Fallback: just run pm2 list for human-readable output
    execSync("pm2 list", { stdio: "inherit" });
    return;
  }

  const ours = procs.filter((p) => p.name.startsWith("sportsclaw-"));

  if (ours.length === 0) {
    console.log("No daemons running.");
    console.log("");
    console.log("Start one with: sportsclaw start <discord|telegram>");
    return;
  }

  console.log("Daemon Status:");
  console.log("");
  for (const p of ours) {
    const status = p.pm2_env?.status ?? "unknown";
    const online = status === "online";
    const icon = online ? "\x1b[32m●\x1b[0m" : "\x1b[2m○\x1b[0m";
    const platform = p.name.replace("sportsclaw-", "");
    const label = online ? `online (PID ${p.pid})` : status;
    console.log(`  ${icon} ${platform.padEnd(12)} ${label}`);
  }
  console.log("");
  console.log("Full details: pm2 list");
}

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

export function daemonLogs(platform: DaemonPlatform, lines = 50): void {
  requirePm2();

  const name = pm2Name(platform);

  try {
    execSync(`pm2 logs ${name} --nostream --lines ${lines}`, {
      stdio: "inherit",
    });
  } catch {
    console.error(`No logs found for ${platform}. Is the daemon running?`);
    console.error(`Start it with: sportsclaw start ${platform}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Restart
// ---------------------------------------------------------------------------

export function daemonRestart(platform: DaemonPlatform): void {
  const pid = readPid(platform);
  if (pid !== null && isProcessAlive(pid)) {
    console.log(`Stopping existing ${platform} daemon (PID ${pid})...`);
    daemonStop(platform);
  } else {
    console.log(`${platform} daemon is not currently running.`);
  }

  // Allow a moment for the port/process to cleanly release
  setTimeout(() => {
    console.log(`Starting ${platform} daemon...`);
    daemonStart(platform);
  }, 1500);
}
