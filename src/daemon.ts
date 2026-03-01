/**
 * sportsclaw — Daemon Management
 *
 * Spawn, stop, and monitor long-running listener processes as background
 * daemons. PID files live in ~/.sportsclaw/run/ and logs in ~/.sportsclaw/logs/.
 */

import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  openSync,
} from "node:fs";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const SPORTSCLAW_DIR = join(homedir(), ".sportsclaw");
const RUN_DIR = join(SPORTSCLAW_DIR, "run");
const LOG_DIR = join(SPORTSCLAW_DIR, "logs");

export type DaemonPlatform = "discord" | "telegram";
const VALID_PLATFORMS: DaemonPlatform[] = ["discord", "telegram"];

function pidPath(platform: DaemonPlatform): string {
  return join(RUN_DIR, `${platform}.pid`);
}

function logPath(platform: DaemonPlatform): string {
  return join(LOG_DIR, `${platform}.log`);
}

export function isValidPlatform(value: string): value is DaemonPlatform {
  return VALID_PLATFORMS.includes(value as DaemonPlatform);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/** Read a PID file, returning the numeric PID or null. */
function readPid(platform: DaemonPlatform): number | null {
  const p = pidPath(platform);
  if (!existsSync(p)) return null;
  const raw = readFileSync(p, "utf-8").trim();
  const pid = Number.parseInt(raw, 10);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

/** Check whether a process with the given PID is alive. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = existence check
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

export function daemonStart(platform: DaemonPlatform): void {
  ensureDir(RUN_DIR);
  ensureDir(LOG_DIR);

  // Refuse if already running
  const existingPid = readPid(platform);
  if (existingPid !== null && isProcessAlive(existingPid)) {
    console.error(
      `${platform} daemon is already running (PID ${existingPid}).`
    );
    console.error(`Stop it first with: sportsclaw stop ${platform}`);
    process.exit(1);
  }

  // Resolve the entry point: dist/index.js relative to this file
  const entryPoint = fileURLToPath(
    new URL("../dist/index.js", import.meta.url)
  );

  // Open log file for append
  const logFd = openSync(logPath(platform), "a");

  const child = spawn("node", [entryPoint, "listen", platform], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env },
  });

  // Write PID file
  if (child.pid) {
    writeFileSync(pidPath(platform), String(child.pid), "utf-8");
  }

  // Unref so the parent can exit immediately
  child.unref();

  console.log(`${platform} daemon started (PID ${child.pid}).`);
  console.log(`  Logs: ${logPath(platform)}`);
  console.log(`  Stop: sportsclaw stop ${platform}`);
}

// ---------------------------------------------------------------------------
// Stop
// ---------------------------------------------------------------------------

export function daemonStop(platform: DaemonPlatform): void {
  const pid = readPid(platform);
  if (pid === null) {
    console.error(`No PID file found for ${platform}. Is it running?`);
    process.exit(1);
  }

  if (!isProcessAlive(pid)) {
    // Stale PID file — clean up
    unlinkSync(pidPath(platform));
    console.log(
      `${platform} daemon is not running (stale PID file removed).`
    );
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch (err: unknown) {
    console.error(`Failed to stop ${platform} daemon (PID ${pid}):`, err);
    process.exit(1);
  }

  // Clean up PID file
  try {
    unlinkSync(pidPath(platform));
  } catch {
    // PID file may already be gone
  }

  console.log(`${platform} daemon stopped (PID ${pid}).`);
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export function daemonStatus(): void {
  ensureDir(RUN_DIR);

  const statuses = VALID_PLATFORMS.map((platform) => {
    const pid = readPid(platform);
    const running = pid !== null && isProcessAlive(pid);

    // Clean up stale PID files
    if (pid !== null && !running) {
      try {
        unlinkSync(pidPath(platform));
      } catch {
        // ignore
      }
    }

    return {
      platform,
      running,
      pid: running ? pid : null,
      logFile: logPath(platform),
    };
  });

  const anyRunning = statuses.some((s) => s.running);

  if (!anyRunning) {
    console.log("No daemons running.");
    console.log("");
    console.log("Start one with: sportsclaw start <discord|telegram>");
    return;
  }

  console.log("Daemon Status:");
  console.log("");
  for (const s of statuses) {
    const icon = s.running ? "\x1b[32m●\x1b[0m" : "\x1b[2m○\x1b[0m";
    const label = s.running ? `running (PID ${s.pid})` : "stopped";
    console.log(`  ${icon} ${s.platform.padEnd(12)} ${label}`);
  }
  console.log("");
  console.log(`Logs: ${LOG_DIR}/`);
}

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

export function daemonLogs(platform: DaemonPlatform, lines = 50): void {
  const file = logPath(platform);
  if (!existsSync(file)) {
    console.error(`No log file found for ${platform}.`);
    console.error(`Expected at: ${file}`);
    process.exit(1);
  }

  // Read the file and show the last N lines
  const content = readFileSync(file, "utf-8");
  const allLines = content.split("\n");
  const tail = allLines.slice(-lines).join("\n");

  console.log(`--- ${platform} logs (last ${lines} lines) ---`);
  console.log(tail);
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
