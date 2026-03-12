/**
 * sportsclaw Plugin System — Install & manage optional plugins.
 *
 * Subcommands:
 *   sportsclaw plugin install auto-clipper   Install the auto-clipper plugin
 *   sportsclaw plugin list                   List installed plugins
 *
 * Flags:
 *   --yes, --non-interactive   Skip all prompts (agentic mode)
 */

import { execFileSync } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { get as httpsGet } from "node:https";
import pc from "picocolors";
import * as p from "@clack/prompts";
import { detectPlatformPackageManager, type PackageManager } from "./python.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SPORTSCLAW_DIR = join(homedir(), ".sportsclaw");
const PLUGINS_DIR = join(SPORTSCLAW_DIR, "plugins");
const MODELS_DIR = join(SPORTSCLAW_DIR, "models");

const YOLO_MODEL_URL =
  "https://github.com/ultralytics/assets/releases/download/v8.3.0/yolov8n.onnx";
const YOLO_MODEL_FILENAME = "yolov8n.onnx";

/** Manifest written after successful install */
interface PluginManifest {
  name: string;
  version: string;
  installedAt: string;
  dependencies: {
    ffmpeg: boolean;
    model: string;
    nodePackages: string[];
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isNonInteractive(args: string[]): boolean {
  return args.includes("--yes") || args.includes("--non-interactive");
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// ffmpeg detection & installation
// ---------------------------------------------------------------------------

function detectFfmpeg(): { installed: boolean; path?: string } {
  try {
    const output = execFileSync("which", ["ffmpeg"], {
      timeout: 5_000,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return { installed: true, path: output };
  } catch {
    return { installed: false };
  }
}

function ffmpegInstallCommand(
  manager: PackageManager
): { bin: string; args: string[] } {
  const commands: Record<PackageManager, { bin: string; args: string[] }> = {
    brew: { bin: "brew", args: ["install", "ffmpeg"] },
    apt: { bin: "sudo", args: ["apt-get", "install", "-y", "ffmpeg"] },
    dnf: { bin: "sudo", args: ["dnf", "install", "-y", "ffmpeg"] },
    pacman: { bin: "sudo", args: ["pacman", "-S", "--noconfirm", "ffmpeg"] },
  };
  return commands[manager];
}

function installFfmpeg(manager: PackageManager): { ok: boolean; error?: string } {
  const cmd = ffmpegInstallCommand(manager);
  try {
    execFileSync(cmd.bin, cmd.args, { timeout: 600_000, stdio: "inherit" });
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// Model downloader
// ---------------------------------------------------------------------------

function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest);

    const request = (currentUrl: string) => {
      httpsGet(currentUrl, (response) => {
        // Follow redirects (GitHub releases use 302)
        if (
          response.statusCode &&
          response.statusCode >= 300 &&
          response.statusCode < 400 &&
          response.headers.location
        ) {
          request(response.headers.location);
          return;
        }

        if (response.statusCode !== 200) {
          reject(new Error(`HTTP ${response.statusCode} downloading ${currentUrl}`));
          return;
        }

        response.pipe(file);
        file.on("finish", () => {
          file.close();
          resolve();
        });
      }).on("error", (err: Error) => {
        reject(err);
      });
    };

    request(url);
  });
}

// ---------------------------------------------------------------------------
// Node package installer
// ---------------------------------------------------------------------------

function installNodePackages(packages: string[]): { ok: boolean; error?: string } {
  try {
    execFileSync("npm", ["install", "--save-optional", ...packages], {
      timeout: 120_000,
      stdio: "inherit",
      cwd: process.cwd(),
    });
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// Plugin manifest
// ---------------------------------------------------------------------------

function getPluginManifestPath(pluginName: string): string {
  return join(PLUGINS_DIR, `${pluginName}.json`);
}

function isPluginInstalled(pluginName: string): boolean {
  return existsSync(getPluginManifestPath(pluginName));
}

function writePluginManifest(manifest: PluginManifest): void {
  ensureDir(PLUGINS_DIR);
  writeFileSync(
    getPluginManifestPath(manifest.name),
    JSON.stringify(manifest, null, 2),
    "utf-8"
  );
}

function readPluginManifest(pluginName: string): PluginManifest | null {
  const path = getPluginManifestPath(pluginName);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as PluginManifest;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// auto-clipper install wizard
// ---------------------------------------------------------------------------

async function installAutoClipper(args: string[]): Promise<void> {
  const autoYes = isNonInteractive(args);

  p.intro(pc.bold("Auto-Clipper Plugin Installer"));

  // -- Check if already installed -----------------------------------------
  if (isPluginInstalled("auto-clipper")) {
    const manifest = readPluginManifest("auto-clipper");
    const when = manifest?.installedAt ?? "unknown";
    p.log.warn(`auto-clipper is already installed (installed: ${when}).`);

    if (!autoYes) {
      const reinstall = await p.confirm({
        message: "Reinstall auto-clipper?",
        initialValue: false,
      });
      if (p.isCancel(reinstall) || !reinstall) {
        p.outro("Installation cancelled.");
        return;
      }
    } else {
      p.log.info("--yes flag: reinstalling.");
    }
  }

  // -- Step 1: ffmpeg check -----------------------------------------------
  p.log.step("Checking system dependencies...");

  const ffmpeg = detectFfmpeg();
  if (ffmpeg.installed) {
    p.log.success(`ffmpeg found at ${ffmpeg.path}`);
  } else {
    p.log.warn("ffmpeg is not installed.");

    const manager = detectPlatformPackageManager();
    if (!manager) {
      p.log.error(
        "No supported package manager found (brew, apt-get, dnf, pacman).\n" +
          "Please install ffmpeg manually and re-run this command."
      );
      process.exit(1);
    }

    let shouldInstall = autoYes;

    if (!shouldInstall) {
      const answer = await p.confirm({
        message: `ffmpeg is missing. Would you like SportsClaw to install it for you? (via ${manager})`,
        initialValue: true,
      });
      if (p.isCancel(answer)) {
        p.outro("Installation cancelled.");
        return;
      }
      shouldInstall = answer;
    }

    if (shouldInstall) {
      const s = p.spinner();
      s.start(`Installing ffmpeg via ${manager}...`);
      const result = installFfmpeg(manager);
      if (!result.ok) {
        s.stop(`ffmpeg installation failed: ${result.error}`);
        process.exit(1);
      }
      s.stop("ffmpeg installed successfully.");

      // Verify it's now reachable
      const recheck = detectFfmpeg();
      if (!recheck.installed) {
        p.log.warn(
          "ffmpeg was installed but is not yet in your PATH.\n" +
            "You may need to restart your terminal or run: source ~/.zshrc"
        );
      }
    } else {
      p.log.error("ffmpeg is required. Install it manually and re-run.");
      process.exit(1);
    }
  }

  // -- Step 2: Download ONNX model ----------------------------------------
  p.log.step("Checking vision model...");
  ensureDir(MODELS_DIR);
  const modelPath = join(MODELS_DIR, YOLO_MODEL_FILENAME);

  if (existsSync(modelPath)) {
    p.log.success(`YOLOv8 Nano model already cached at ${modelPath}`);
  } else {
    let shouldDownload = autoYes;

    if (!shouldDownload) {
      const answer = await p.confirm({
        message: "Download YOLOv8 Nano ONNX model (~6MB) to ~/.sportsclaw/models/?",
        initialValue: true,
      });
      if (p.isCancel(answer)) {
        p.outro("Installation cancelled.");
        return;
      }
      shouldDownload = answer;
    }

    if (shouldDownload) {
      const s = p.spinner();
      s.start("Downloading YOLOv8 Nano ONNX model...");
      try {
        await downloadFile(YOLO_MODEL_URL, modelPath);
        s.stop(`Model saved to ${modelPath}`);
      } catch (err) {
        s.stop(
          `Download failed: ${err instanceof Error ? err.message : String(err)}`
        );
        process.exit(1);
      }
    } else {
      p.log.warn("Skipping model download. auto-clipper will not work without it.");
    }
  }

  // -- Step 3: Install Node packages --------------------------------------
  p.log.step("Installing Node dependencies...");
  const nodePackages = ["onnxruntime-node", "fluent-ffmpeg"];

  if (autoYes) {
    p.log.info(`--yes flag: installing ${nodePackages.join(", ")}`);
  }

  const s = p.spinner();
  s.start(`npm install --save-optional ${nodePackages.join(" ")}...`);
  const npmResult = installNodePackages(nodePackages);
  if (!npmResult.ok) {
    s.stop(`npm install failed: ${npmResult.error}`);
    process.exit(1);
  }
  s.stop("Node dependencies installed.");

  // -- Step 4: Write manifest ---------------------------------------------
  const manifest: PluginManifest = {
    name: "auto-clipper",
    version: "0.1.0",
    installedAt: new Date().toISOString(),
    dependencies: {
      ffmpeg: true,
      model: modelPath,
      nodePackages,
    },
  };
  writePluginManifest(manifest);

  p.outro(
    pc.green("auto-clipper plugin installed successfully!") +
      "\n\n" +
      `  Model:    ${modelPath}\n` +
      `  Manifest: ${getPluginManifestPath("auto-clipper")}`
  );
}

// ---------------------------------------------------------------------------
// plugin list
// ---------------------------------------------------------------------------

function cmdPluginList(): void {
  ensureDir(PLUGINS_DIR);
  const files = readdirSync(PLUGINS_DIR).filter((f) => f.endsWith(".json"));

  if (files.length === 0) {
    console.log("No plugins installed.");
    console.log(
      `\nInstall one with: ${pc.bold("sportsclaw plugin install auto-clipper")}`
    );
    return;
  }

  console.log(pc.bold("Installed plugins:"));
  console.log("");
  for (const file of files) {
    const manifest = readPluginManifest(file.replace(".json", ""));
    if (manifest) {
      console.log(
        `  ${pc.green(manifest.name)} v${manifest.version}  (installed ${manifest.installedAt})`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Plugin CLI router — entry point
// ---------------------------------------------------------------------------

const AVAILABLE_PLUGINS = ["auto-clipper"] as const;
type PluginName = (typeof AVAILABLE_PLUGINS)[number];

export async function cmdPlugin(args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);

  switch (sub) {
    case "install": {
      const pluginName = rest[0];
      if (!pluginName) {
        console.log("Usage: sportsclaw plugin install <plugin-name>");
        console.log("");
        console.log("Available plugins:");
        for (const name of AVAILABLE_PLUGINS) {
          console.log(`  ${name}`);
        }
        return;
      }
      if (!AVAILABLE_PLUGINS.includes(pluginName as PluginName)) {
        console.error(
          pc.red(`Unknown plugin: ${pluginName}`) +
            `\nAvailable: ${AVAILABLE_PLUGINS.join(", ")}`
        );
        process.exit(1);
      }
      if (pluginName === "auto-clipper") {
        return installAutoClipper(rest.slice(1));
      }
      return;
    }

    case "list":
      return cmdPluginList();

    default:
      console.log("Usage: sportsclaw plugin <install|list>");
      console.log("");
      console.log("  install <name>   Install a plugin");
      console.log("  list             List installed plugins");
      console.log("");
      console.log("Flags:");
      console.log("  --yes            Skip all prompts (agentic / non-interactive mode)");
      return;
  }
}
