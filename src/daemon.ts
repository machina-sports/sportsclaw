/**
 * sportsclaw — Cross-platform Daemon Manager
 *
 * Supervises listener processes via the host OS's native service manager:
 *   - macOS  : launchd (~/Library/LaunchAgents/gg.sportsclaw.<platform>.plist)
 *   - Linux  : systemd --user (~/.config/systemd/user/sportsclaw-<platform>.service)
 *   - Windows: Task Scheduler (schtasks) + a tiny .cmd respawn wrapper
 *
 * Why not pm2: pm2 6.0.x's fork-mode pipe machinery hangs silently under
 * Node 25 on macOS — the listener loads, prints nothing, never connects to
 * the network, and pm2 still reports it "online". OS-native supervisors
 * don't have that failure mode.
 *
 * Logs always live at ~/.sportsclaw/logs/<platform>-out.log and -err.log,
 * regardless of platform.
 */

import { execSync, execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  statSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";
import { homedir, platform as osPlatform } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Public types and validation
// ---------------------------------------------------------------------------

export type DaemonPlatform = "discord" | "telegram" | "watch" | "operator";
/** Platforms that take no second positional argument. */
const SIMPLE_PLATFORMS: DaemonPlatform[] = ["discord", "telegram", "watch"];
const VALID_PLATFORMS: DaemonPlatform[] = ["discord", "telegram", "watch", "operator"];

export function isValidPlatform(value: string): value is DaemonPlatform {
  return VALID_PLATFORMS.includes(value as DaemonPlatform);
}

/**
 * Platforms whose service / log / pid identity is keyed by a jobId in
 * addition to the platform itself. Operator daemons are the only such
 * platform in v1.
 */
export function platformRequiresJobId(platform: DaemonPlatform): boolean {
  return platform === "operator";
}

const JOB_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

function assertJobId(platform: DaemonPlatform, jobId: string | undefined): string {
  if (!platformRequiresJobId(platform)) {
    throw new Error(
      `[daemon] platform "${platform}" does not take a jobId argument`,
    );
  }
  if (!jobId || !JOB_ID_PATTERN.test(jobId)) {
    throw new Error(
      `[daemon] platform "${platform}" requires a jobId matching ${JOB_ID_PATTERN.source}`,
    );
  }
  return jobId;
}

function assertNoJobId(platform: DaemonPlatform, jobId: string | undefined): void {
  if (jobId !== undefined && !platformRequiresJobId(platform)) {
    throw new Error(
      `[daemon] platform "${platform}" does not accept a jobId (got "${jobId}")`,
    );
  }
}

/** Cross-driver service-key composition. Used in error messages + status output. */
function serviceKey(platform: DaemonPlatform, jobId?: string): string {
  return jobId ? `${platform}/${jobId}` : platform;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function entryPoint(): string {
  return fileURLToPath(new URL("../dist/index.js", import.meta.url));
}

function nodeBin(): string {
  return process.execPath;
}

function logsDir(): string {
  const dir = join(homedir(), ".sportsclaw", "logs");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function logPaths(
  platform: DaemonPlatform,
  jobId?: string,
): { out: string; err: string } {
  const suffix = jobId ? `${platform}-${jobId}` : platform;
  return {
    out: join(logsDir(), `${suffix}-out.log`),
    err: join(logsDir(), `${suffix}-err.log`),
  };
}

export function scriptArgsFor(
  platform: DaemonPlatform,
  jobId?: string,
): string[] {
  if (platform === "watch") {
    return ["watch", `--config=${join(homedir(), ".sportsclaw", "watchers.json")}`];
  }
  if (platform === "operator") {
    return ["operate", "--job", assertJobId(platform, jobId)];
  }
  return ["listen", platform];
}

/** Tail the last N lines of a file. Cross-platform replacement for `tail`. */
function tailFile(path: string, lines: number): string {
  if (!existsSync(path)) return "";
  const size = statSync(path).size;
  if (size === 0) return "";
  // Read the last ~64KB; for log tails that's plenty.
  const readBytes = Math.min(size, 64 * 1024);
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(readBytes);
    readSync(fd, buf, 0, readBytes, size - readBytes);
    const text = buf.toString("utf-8");
    const all = text.split(/\r?\n/);
    const trimmed = all.slice(-lines - 1).join("\n");
    return trimmed;
  } finally {
    closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// Driver interface
// ---------------------------------------------------------------------------

interface Driver {
  name: string;
  start(platform: DaemonPlatform, jobId?: string): void;
  stop(platform: DaemonPlatform, jobId?: string): void;
  status(): void;
  logs(platform: DaemonPlatform, lines: number, jobId?: string): void;
  restart(platform: DaemonPlatform, jobId?: string): void;
}

function driver(): Driver {
  switch (osPlatform()) {
    case "darwin":
      return launchdDriver;
    case "linux":
      return systemdDriver;
    case "win32":
      return windowsDriver;
    default:
      throw new Error(
        `Unsupported platform: ${osPlatform()}. sportsclaw daemons require macOS, Linux, or Windows.`
      );
  }
}

// ---------------------------------------------------------------------------
// pm2 migration — auto-clean any pm2-registered sportsclaw-<platform> entry
// before installing the OS-native supervisor. Two supervisors managing the
// same listener = duplicate Telegram polls / Discord gateways. The pm2 entry
// was originally created by an older sportsclaw, so deleting it is safe.
//
// Opt out by setting SPORTSCLAW_KEEP_PM2=1 in the environment.
// ---------------------------------------------------------------------------

interface Pm2Process {
  name: string;
  pid?: number;
  pm2_env?: { status?: string };
}

function migratePm2IfPresent(platform: DaemonPlatform): void {
  if (process.env.SPORTSCLAW_KEEP_PM2 === "1") return;
  // operator daemons never had pm2 supervision (this PR introduces the platform).
  if (platform === "operator") return;

  // Only proceed if pm2 is actually on PATH.
  const which = spawnSync(osPlatform() === "win32" ? "where.exe" : "which", ["pm2"], {
    encoding: "utf-8",
  });
  if (which.status !== 0) return;

  const list = spawnSync("pm2", ["jlist"], { encoding: "utf-8" });
  if (list.status !== 0 || !list.stdout) return;

  let procs: Pm2Process[];
  try {
    procs = JSON.parse(list.stdout) as Pm2Process[];
  } catch {
    return;
  }

  const target = `sportsclaw-${platform}`;
  const match = procs.find((p) => p.name === target);
  if (!match) return;

  const status = match.pm2_env?.status ?? "unknown";
  const pidPart = match.pid ? ` (PID ${match.pid})` : "";
  console.log(
    `Migrating from pm2: removing ${target}${pidPart}, status: ${status}`
  );
  // delete includes stop, idempotent. Discard output unless it fails loudly.
  const del = spawnSync("pm2", ["delete", target], { encoding: "utf-8" });
  if (del.status !== 0) {
    console.error(
      `pm2 delete ${target} failed (exit ${del.status}). Continuing — but you may end up with two supervisors. ` +
        `Run \`pm2 delete ${target}\` manually if so, or set SPORTSCLAW_KEEP_PM2=1 to skip this check.`
    );
    return;
  }
  console.log(`  pm2 entry removed. The OS supervisor will take over now.`);
}

// ---------------------------------------------------------------------------
// Public API — same surface as before, dispatched per-OS
// ---------------------------------------------------------------------------

export function daemonStart(platform: DaemonPlatform, jobId?: string): void {
  if (platformRequiresJobId(platform)) assertJobId(platform, jobId);
  else assertNoJobId(platform, jobId);
  migratePm2IfPresent(platform);
  driver().start(platform, jobId);
}

export function daemonStop(platform: DaemonPlatform, jobId?: string): void {
  if (platformRequiresJobId(platform)) assertJobId(platform, jobId);
  else assertNoJobId(platform, jobId);
  // Migration is silent when no pm2 entry exists, so this only fires when
  // the user has a leftover pm2 daemon — exactly when stopping it is helpful.
  migratePm2IfPresent(platform);
  driver().stop(platform, jobId);
}

export function daemonStatus(): void {
  driver().status();
}

export function daemonLogs(
  platform: DaemonPlatform,
  lines = 50,
  jobId?: string,
): void {
  if (platformRequiresJobId(platform)) assertJobId(platform, jobId);
  else assertNoJobId(platform, jobId);
  driver().logs(platform, lines, jobId);
}

export function daemonRestart(platform: DaemonPlatform, jobId?: string): void {
  if (platformRequiresJobId(platform)) assertJobId(platform, jobId);
  else assertNoJobId(platform, jobId);
  migratePm2IfPresent(platform);
  driver().restart(platform, jobId);
}

// ---------------------------------------------------------------------------
// macOS — launchd
// ---------------------------------------------------------------------------

const LAUNCHD_LABEL_PREFIX = "gg.sportsclaw.";

function launchdLabel(p: DaemonPlatform, jobId?: string): string {
  if (p === "operator") {
    return `${LAUNCHD_LABEL_PREFIX}operator.${assertJobId(p, jobId)}`;
  }
  return `${LAUNCHD_LABEL_PREFIX}${p}`;
}

function launchdPlistPath(p: DaemonPlatform, jobId?: string): string {
  return join(
    homedir(),
    "Library",
    "LaunchAgents",
    `${launchdLabel(p, jobId)}.plist`,
  );
}

/**
 * Enumerate every installed sportsclaw plist, returning the parsed
 * (platform, jobId?) tuple. Used by `status` to surface every operator
 * job alongside the simple platforms.
 */
function launchdInstalledServices(): Array<{ platform: DaemonPlatform; jobId?: string }> {
  const dir = join(homedir(), "Library", "LaunchAgents");
  if (!existsSync(dir)) return [];
  const out: Array<{ platform: DaemonPlatform; jobId?: string }> = [];
  for (const file of readdirSync(dir)) {
    if (!file.startsWith(LAUNCHD_LABEL_PREFIX) || !file.endsWith(".plist")) continue;
    const label = file.slice(0, -".plist".length);
    const rest = label.slice(LAUNCHD_LABEL_PREFIX.length);
    if (rest.startsWith("operator.")) {
      const jobId = rest.slice("operator.".length);
      if (JOB_ID_PATTERN.test(jobId)) out.push({ platform: "operator", jobId });
    } else if (SIMPLE_PLATFORMS.includes(rest as DaemonPlatform)) {
      out.push({ platform: rest as DaemonPlatform });
    }
  }
  return out;
}

function launchdRenderPlist(p: DaemonPlatform, jobId?: string): string {
  const { out, err } = logPaths(p, jobId);
  const args = [nodeBin(), entryPoint(), ...scriptArgsFor(p, jobId)];
  const xmlArgs = args
    .map((a) => `        <string>${escapeXml(a)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${launchdLabel(p, jobId)}</string>

    <key>ProgramArguments</key>
    <array>
${xmlArgs}
    </array>

    <key>WorkingDirectory</key>
    <string>${escapeXml(homedir())}</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
        <key>HOME</key>
        <string>${escapeXml(homedir())}</string>
    </dict>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
        <key>Crashed</key>
        <true/>
    </dict>

    <key>ThrottleInterval</key>
    <integer>10</integer>

    <key>StandardOutPath</key>
    <string>${escapeXml(out)}</string>

    <key>StandardErrorPath</key>
    <string>${escapeXml(err)}</string>
</dict>
</plist>
`;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function launchctlList(label: string): { running: boolean; pid?: number } {
  const out = spawnSync("launchctl", ["list", label], { encoding: "utf-8" });
  if (out.status !== 0) return { running: false };
  // launchctl list <label> prints: PID Status Label
  const lines = out.stdout.trim().split("\n");
  for (const line of lines) {
    // Plist format output: "PID" = 12345;
    const m = line.match(/"PID"\s*=\s*(\d+);/);
    if (m) return { running: true, pid: Number.parseInt(m[1], 10) };
  }
  return { running: true };
}

/** Compose the supervisor display tag for "<platform>[ <jobId>]". */
function tag(p: DaemonPlatform, jobId?: string): string {
  return jobId ? `${p} ${jobId}` : p;
}

/** Compose the `stop`-style CLI suffix: `<platform> [<jobId>]`. */
function cliSuffix(p: DaemonPlatform, jobId?: string): string {
  return jobId ? `${p} ${jobId}` : p;
}

const launchdDriver: Driver = {
  name: "launchd",
  start(p, jobId) {
    const plistPath = launchdPlistPath(p, jobId);
    const dir = join(homedir(), "Library", "LaunchAgents");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const existing = launchctlList(launchdLabel(p, jobId));
    if (existing.running && existing.pid) {
      console.error(`${tag(p, jobId)} daemon is already running (PID ${existing.pid}).`);
      console.error(`Stop it first with: sportsclaw stop ${cliSuffix(p, jobId)}`);
      process.exit(1);
    }

    writeFileSync(plistPath, launchdRenderPlist(p, jobId), "utf-8");
    // load is the legacy command but works across all macOS versions we target.
    spawnSync("launchctl", ["load", plistPath], { stdio: "inherit" });

    console.log(`${tag(p, jobId)} daemon started via launchd.`);
    console.log(`  Status: sportsclaw status`);
    console.log(`  Logs:   sportsclaw logs ${cliSuffix(p, jobId)}`);
    console.log(`  Stop:   sportsclaw stop ${cliSuffix(p, jobId)}`);
  },
  stop(p, jobId) {
    const plistPath = launchdPlistPath(p, jobId);
    if (!existsSync(plistPath)) {
      console.error(`${tag(p, jobId)} daemon is not installed.`);
      process.exit(1);
    }
    spawnSync("launchctl", ["unload", plistPath], { stdio: "inherit" });
    console.log(`${tag(p, jobId)} daemon stopped.`);
  },
  status() {
    const services = launchdInstalledServices();
    console.log("Daemon Status:");
    console.log("");
    if (services.length === 0) {
      console.log("No daemons installed.");
      console.log("");
      console.log("Start one with: sportsclaw start <discord|telegram|watch>");
      console.log("            or: sportsclaw start operator <jobId>");
      return;
    }
    for (const { platform, jobId } of services) {
      const info = launchctlList(launchdLabel(platform, jobId));
      const online = info.running && info.pid;
      const icon = online ? "\x1b[32m●\x1b[0m" : "\x1b[2m○\x1b[0m";
      const status = online ? `online (PID ${info.pid})` : "stopped";
      const left = jobId ? `${platform} [${jobId}]` : platform;
      console.log(`  ${icon} ${left.padEnd(36)} ${status}`);
    }
    console.log("");
    console.log(`Logs: ${logsDir()}`);
  },
  logs(p, lines, jobId) {
    const { out, err } = logPaths(p, jobId);
    if (!existsSync(out) && !existsSync(err)) {
      console.error(`No logs found for ${tag(p, jobId)}. Is the daemon running?`);
      console.error(`Start it with: sportsclaw start ${cliSuffix(p, jobId)}`);
      process.exit(1);
    }
    if (existsSync(out)) {
      console.log(`=== ${out} ===`);
      console.log(tailFile(out, lines));
    }
    if (existsSync(err) && statSync(err).size > 0) {
      console.log(`\n=== ${err} ===`);
      console.log(tailFile(err, lines));
    }
  },
  restart(p, jobId) {
    const plistPath = launchdPlistPath(p, jobId);
    if (!existsSync(plistPath)) {
      console.log(`${tag(p, jobId)} daemon is not currently installed. Starting fresh...`);
      this.start(p, jobId);
      return;
    }
    // kickstart -k restarts cleanly, surviving even a hung process.
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    const r =
      uid !== null
        ? spawnSync(
            "launchctl",
            ["kickstart", "-k", `gui/${uid}/${launchdLabel(p, jobId)}`],
            { stdio: "inherit" }
          )
        : { status: 1 };
    if (r.status !== 0) {
      // Fall back to unload + load (always works; just slower).
      spawnSync("launchctl", ["unload", plistPath], { stdio: "inherit" });
      spawnSync("launchctl", ["load", plistPath], { stdio: "inherit" });
    }
    console.log(`Restarted ${tag(p, jobId)} daemon.`);
  },
};

// ---------------------------------------------------------------------------
// Linux — systemd user units
// ---------------------------------------------------------------------------

function systemdUnitName(p: DaemonPlatform, jobId?: string): string {
  if (p === "operator") {
    return `sportsclaw-operator-${assertJobId(p, jobId)}.service`;
  }
  return `sportsclaw-${p}.service`;
}

function systemdUnitPath(p: DaemonPlatform, jobId?: string): string {
  return join(homedir(), ".config", "systemd", "user", systemdUnitName(p, jobId));
}

/** Enumerate installed systemd user units belonging to sportsclaw. */
function systemdInstalledServices(): Array<{ platform: DaemonPlatform; jobId?: string }> {
  const dir = join(homedir(), ".config", "systemd", "user");
  if (!existsSync(dir)) return [];
  const out: Array<{ platform: DaemonPlatform; jobId?: string }> = [];
  for (const file of readdirSync(dir)) {
    if (!file.startsWith("sportsclaw-") || !file.endsWith(".service")) continue;
    const rest = file.slice("sportsclaw-".length, -".service".length);
    if (rest.startsWith("operator-")) {
      const jobId = rest.slice("operator-".length);
      if (JOB_ID_PATTERN.test(jobId)) out.push({ platform: "operator", jobId });
    } else if (SIMPLE_PLATFORMS.includes(rest as DaemonPlatform)) {
      out.push({ platform: rest as DaemonPlatform });
    }
  }
  return out;
}

function systemdRenderUnit(p: DaemonPlatform, jobId?: string): string {
  const { out, err } = logPaths(p, jobId);
  const args = [nodeBin(), entryPoint(), ...scriptArgsFor(p, jobId)];
  const execStart = args.map(quoteIfNeeded).join(" ");
  const description = jobId ? `sportsclaw ${p} ${jobId}` : `sportsclaw ${p} listener`;
  return `[Unit]
Description=${description}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${homedir()}
ExecStart=${execStart}
Restart=on-failure
RestartSec=10
# StandardOutput append: requires systemd 240+ (released 2018-12); ubiquitous now.
StandardOutput=append:${out}
StandardError=append:${err}
Environment=PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin

[Install]
WantedBy=default.target
`;
}

function quoteIfNeeded(s: string): string {
  return /\s/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s;
}

function systemctlUser(args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync("systemctl", ["--user", ...args], { encoding: "utf-8" });
  return {
    ok: r.status === 0,
    stdout: r.stdout?.trim() ?? "",
    stderr: r.stderr?.trim() ?? "",
  };
}

const systemdDriver: Driver = {
  name: "systemd",
  start(p, jobId) {
    const unitName = systemdUnitName(p, jobId);
    const unitPath = systemdUnitPath(p, jobId);
    const dir = join(homedir(), ".config", "systemd", "user");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const active = systemctlUser(["is-active", unitName]);
    if (active.stdout === "active") {
      console.error(`${tag(p, jobId)} daemon is already running.`);
      console.error(`Stop it first with: sportsclaw stop ${cliSuffix(p, jobId)}`);
      process.exit(1);
    }

    writeFileSync(unitPath, systemdRenderUnit(p, jobId), "utf-8");
    const reload = systemctlUser(["daemon-reload"]);
    if (!reload.ok) {
      console.error(`systemctl --user daemon-reload failed: ${reload.stderr}`);
      process.exit(1);
    }
    const enable = systemctlUser(["enable", "--now", unitName]);
    if (!enable.ok) {
      console.error(`systemctl --user enable --now ${unitName} failed:`);
      console.error(enable.stderr);
      process.exit(1);
    }

    console.log(`${tag(p, jobId)} daemon started via systemd (--user).`);
    console.log(`  Status: sportsclaw status`);
    console.log(`  Logs:   sportsclaw logs ${cliSuffix(p, jobId)}`);
    console.log(`  Stop:   sportsclaw stop ${cliSuffix(p, jobId)}`);
    console.log(`  Note: enable lingering with \`loginctl enable-linger\` if you want this to`);
    console.log(`        survive logout. Otherwise it stops when you log out.`);
  },
  stop(p, jobId) {
    const unitPath = systemdUnitPath(p, jobId);
    if (!existsSync(unitPath)) {
      console.error(`${tag(p, jobId)} daemon is not installed.`);
      process.exit(1);
    }
    systemctlUser(["disable", "--now", systemdUnitName(p, jobId)]);
    console.log(`${tag(p, jobId)} daemon stopped.`);
  },
  status() {
    const services = systemdInstalledServices();
    console.log("Daemon Status:");
    console.log("");
    if (services.length === 0) {
      console.log("No daemons installed.");
      console.log("");
      console.log("Start one with: sportsclaw start <discord|telegram|watch>");
      console.log("            or: sportsclaw start operator <jobId>");
      return;
    }
    for (const { platform, jobId } of services) {
      const active = systemctlUser(["is-active", systemdUnitName(platform, jobId)]);
      const online = active.stdout === "active";
      const icon = online ? "\x1b[32m●\x1b[0m" : "\x1b[2m○\x1b[0m";
      const status = online ? "online" : active.stdout || "inactive";
      const left = jobId ? `${platform} [${jobId}]` : platform;
      console.log(`  ${icon} ${left.padEnd(36)} ${status}`);
    }
    console.log("");
    console.log(`Logs: ${logsDir()}`);
  },
  logs(p, lines, jobId) {
    const { out, err } = logPaths(p, jobId);
    if (existsSync(out) || existsSync(err)) {
      if (existsSync(out)) {
        console.log(`=== ${out} ===`);
        console.log(tailFile(out, lines));
      }
      if (existsSync(err) && statSync(err).size > 0) {
        console.log(`\n=== ${err} ===`);
        console.log(tailFile(err, lines));
      }
      return;
    }
    // Fall back to journalctl for older systemd setups that didn't take StandardOutput=append.
    const r = systemctlUser([
      "status",
      "--no-pager",
      "-n",
      String(lines),
      systemdUnitName(p, jobId),
    ]);
    console.log(r.stdout || r.stderr);
  },
  restart(p, jobId) {
    const unitPath = systemdUnitPath(p, jobId);
    if (!existsSync(unitPath)) {
      console.log(`${tag(p, jobId)} daemon is not currently installed. Starting fresh...`);
      this.start(p, jobId);
      return;
    }
    const r = systemctlUser(["restart", systemdUnitName(p, jobId)]);
    if (!r.ok) {
      console.error(`systemctl --user restart failed: ${r.stderr}`);
      process.exit(1);
    }
    console.log(`Restarted ${tag(p, jobId)} daemon.`);
  },
};

// ---------------------------------------------------------------------------
// Windows — Task Scheduler + .cmd respawn wrapper
// ---------------------------------------------------------------------------

function windowsTaskName(p: DaemonPlatform, jobId?: string): string {
  if (p === "operator") return `sportsclaw-operator-${assertJobId(p, jobId)}`;
  return `sportsclaw-${p}`;
}

function windowsWrapperPath(p: DaemonPlatform, jobId?: string): string {
  return join(
    homedir(),
    ".sportsclaw",
    "scripts",
    `${windowsTaskName(p, jobId)}.cmd`,
  );
}

/** Enumerate installed sportsclaw task names. */
function windowsInstalledServices(): Array<{ platform: DaemonPlatform; jobId?: string }> {
  const dir = join(homedir(), ".sportsclaw", "scripts");
  if (!existsSync(dir)) return [];
  const out: Array<{ platform: DaemonPlatform; jobId?: string }> = [];
  for (const file of readdirSync(dir)) {
    if (!file.startsWith("sportsclaw-") || !file.endsWith(".cmd")) continue;
    const rest = file.slice("sportsclaw-".length, -".cmd".length);
    if (rest.startsWith("operator-")) {
      const jobId = rest.slice("operator-".length);
      if (JOB_ID_PATTERN.test(jobId)) out.push({ platform: "operator", jobId });
    } else if (SIMPLE_PLATFORMS.includes(rest as DaemonPlatform)) {
      out.push({ platform: rest as DaemonPlatform });
    }
  }
  return out;
}

/**
 * Render a Windows .cmd that respawns the listener forever with a 10s back-off.
 * Logs append to the same files used on macOS/Linux.
 */
function windowsRenderWrapper(p: DaemonPlatform, jobId?: string): string {
  const { out, err } = logPaths(p, jobId);
  const args = [`"${nodeBin()}"`, `"${entryPoint()}"`, ...scriptArgsFor(p, jobId)].join(" ");
  const label = jobId ? `${p} ${jobId}` : p;
  return `@echo off
REM sportsclaw ${label} — respawn loop
:loop
${args} 1>>"${out}" 2>>"${err}"
timeout /t 10 /nobreak >nul
goto loop
`;
}

function schtasks(args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync("schtasks.exe", args, { encoding: "utf-8" });
  return {
    ok: r.status === 0,
    stdout: r.stdout?.trim() ?? "",
    stderr: r.stderr?.trim() ?? "",
  };
}

function windowsTaskExists(name: string): boolean {
  return schtasks(["/Query", "/TN", name]).ok;
}

function windowsTaskRunning(name: string): boolean {
  const r = schtasks(["/Query", "/TN", name, "/FO", "CSV", "/NH", "/V"]);
  if (!r.ok) return false;
  // Status column appears as "Running" or "Ready"; CSV-quoted.
  return /"Running"/i.test(r.stdout);
}

const windowsDriver: Driver = {
  name: "schtasks",
  start(p, jobId) {
    const taskName = windowsTaskName(p, jobId);
    if (windowsTaskRunning(taskName)) {
      console.error(`${tag(p, jobId)} daemon is already running.`);
      console.error(`Stop it first with: sportsclaw stop ${cliSuffix(p, jobId)}`);
      process.exit(1);
    }

    const wrapperPath = windowsWrapperPath(p, jobId);
    const wrapperDir = join(homedir(), ".sportsclaw", "scripts");
    if (!existsSync(wrapperDir)) mkdirSync(wrapperDir, { recursive: true });
    writeFileSync(wrapperPath, windowsRenderWrapper(p, jobId), "utf-8");

    const create = schtasks([
      "/Create",
      "/F",
      "/TN",
      taskName,
      "/TR",
      `cmd.exe /c "${wrapperPath}"`,
      "/SC",
      "ONLOGON",
      "/RL",
      "LIMITED",
    ]);
    if (!create.ok) {
      console.error(`schtasks /Create failed: ${create.stderr || create.stdout}`);
      process.exit(1);
    }
    schtasks(["/Run", "/TN", taskName]);

    console.log(`${tag(p, jobId)} daemon started via Task Scheduler.`);
    console.log(`  Status: sportsclaw status`);
    console.log(`  Logs:   sportsclaw logs ${cliSuffix(p, jobId)}`);
    console.log(`  Stop:   sportsclaw stop ${cliSuffix(p, jobId)}`);
  },
  stop(p, jobId) {
    const taskName = windowsTaskName(p, jobId);
    if (!windowsTaskExists(taskName)) {
      console.error(`${tag(p, jobId)} daemon is not installed.`);
      process.exit(1);
    }
    schtasks(["/End", "/TN", taskName]);
    schtasks(["/Delete", "/TN", taskName, "/F"]);
    console.log(`${tag(p, jobId)} daemon stopped.`);
  },
  status() {
    const services = windowsInstalledServices();
    console.log("Daemon Status:");
    console.log("");
    if (services.length === 0) {
      console.log("No daemons installed.");
      console.log("");
      console.log("Start one with: sportsclaw start <discord|telegram|watch>");
      console.log("            or: sportsclaw start operator <jobId>");
      return;
    }
    for (const { platform, jobId } of services) {
      const taskName = windowsTaskName(platform, jobId);
      if (!windowsTaskExists(taskName)) continue;
      const online = windowsTaskRunning(taskName);
      const icon = online ? "\x1b[32m●\x1b[0m" : "\x1b[2m○\x1b[0m";
      const left = jobId ? `${platform} [${jobId}]` : platform;
      console.log(`  ${icon} ${left.padEnd(36)} ${online ? "online" : "stopped"}`);
    }
    console.log("");
    console.log(`Logs: ${logsDir()}`);
  },
  logs(p, lines, jobId) {
    const { out, err } = logPaths(p, jobId);
    if (!existsSync(out) && !existsSync(err)) {
      console.error(`No logs found for ${tag(p, jobId)}. Is the daemon running?`);
      console.error(`Start it with: sportsclaw start ${cliSuffix(p, jobId)}`);
      process.exit(1);
    }
    if (existsSync(out)) {
      console.log(`=== ${out} ===`);
      console.log(tailFile(out, lines));
    }
    if (existsSync(err) && statSync(err).size > 0) {
      console.log(`\n=== ${err} ===`);
      console.log(tailFile(err, lines));
    }
  },
  restart(p, jobId) {
    const taskName = windowsTaskName(p, jobId);
    if (!windowsTaskExists(taskName)) {
      console.log(`${tag(p, jobId)} daemon is not currently installed. Starting fresh...`);
      this.start(p, jobId);
      return;
    }
    schtasks(["/End", "/TN", taskName]);
    schtasks(["/Run", "/TN", taskName]);
    console.log(`Restarted ${tag(p, jobId)} daemon.`);
  },
};

// ---------------------------------------------------------------------------
// Suppress "unused" warnings for utility imports kept for future drivers.
// ---------------------------------------------------------------------------

void execSync;
void execFileSync;
void readFileSync;
void serviceKey;
