/**
 * sportsclaw — AI-Native Setup Wizard (`sportsclaw setup [prompt]`)
 *
 * Three-phase approach:
 *   1. Deterministic bootstrap — ensure an LLM API key is available (no AI needed)
 *   2. Docker sandbox verification — detect container runtime, handle legacy venv
 *      migration, pull the sandbox image, and configure OS-specific networking
 *   3. Agentic loop — AI guides the user through platform tokens, sport selection,
 *      and daemon startup via conversational tool use
 */

import { createInterface } from "node:readline/promises";
import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  generateText,
  tool as defineTool,
  jsonSchema,
  stepCountIs,
  type ToolSet,
  type ModelMessage,
} from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { google } from "@ai-sdk/google";
import pc from "picocolors";

import {
  ENV_PATH,
  PROVIDER_ENV,
  parseEnvFile,
  writeEnvVar,
  loadConfig,
  saveConfig,
  applyConfigToEnv,
  ASCII_LOGO,
} from "./config.js";
import {
  SKILL_DESCRIPTIONS,
  fetchSportSchema,
  saveSchema,
  listSchemas,
} from "./schema.js";
import { daemonStart, isValidPlatform } from "./daemon.js";
import { formatResponse } from "./formatters/index.js";
import { DEFAULT_MODELS, type LLMProvider } from "./types.js";
import {
  detectHostEnvironment,
  resolveBindAddress,
  resolveContainerHost,
  type HostEnvironment,
} from "./cred-proxy.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SANDBOX_IMAGE = "machina/sportsclaw-sandbox";
const LEGACY_VENV_DIR = join(homedir(), ".sportsclaw", "venv");

// ---------------------------------------------------------------------------
// Model resolver (local copy — avoids importing engine.ts dependency chain)
// ---------------------------------------------------------------------------

function resolveModel(provider: LLMProvider, modelId: string) {
  switch (provider) {
    case "anthropic":
      return anthropic(modelId);
    case "openai":
      return openai(modelId);
    case "google":
      return google(modelId);
    default:
      throw new Error(`Unsupported provider: "${provider}".`);
  }
}

// ---------------------------------------------------------------------------
// Phase 1 — Deterministic API key bootstrap
// ---------------------------------------------------------------------------

interface BootstrapResult {
  provider: LLMProvider;
  apiKey: string;
}

async function bootstrapApiKey(): Promise<BootstrapResult> {
  // Load ~/.sportsclaw/.env into process.env (existing vars win)
  const envVars = parseEnvFile(ENV_PATH);
  for (const [k, v] of Object.entries(envVars)) {
    if (!process.env[k]) process.env[k] = v;
  }

  // Check if any provider key is already available
  const checks: Array<{ provider: LLMProvider; envVar: string }> = [
    { provider: "anthropic", envVar: "ANTHROPIC_API_KEY" },
    { provider: "openai", envVar: "OPENAI_API_KEY" },
    { provider: "google", envVar: "GOOGLE_GENERATIVE_AI_API_KEY" },
  ];

  for (const { provider, envVar } of checks) {
    const val = process.env[envVar];
    if (val && val.trim().length > 0) {
      console.log(pc.dim(`Using existing ${envVar} from environment.`));
      return { provider, apiKey: val.trim() };
    }
  }

  // No key found — prompt the user
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(
      pc.dim(
        "No API key detected. Paste an Anthropic, OpenAI, or Gemini key to get started."
      )
    );
    const raw = await rl.question(pc.bold("API Key: "));
    const key = raw.trim();
    if (!key) {
      console.error("No key provided. Exiting.");
      process.exit(1);
    }

    // Detect provider from key prefix
    let provider: LLMProvider;
    if (key.startsWith("sk-")) {
      provider = "openai";
    } else if (key.startsWith("AIza")) {
      provider = "google";
    } else {
      provider = "anthropic";
    }

    const envVar = PROVIDER_ENV[provider];
    writeEnvVar(ENV_PATH, envVar, key);
    writeEnvVar(ENV_PATH, "SPORTSCLAW_PROVIDER", provider);
    process.env[envVar] = key;
    process.env.SPORTSCLAW_PROVIDER = provider;

    console.log(
      pc.green(`Saved ${envVar} to ~/.sportsclaw/.env (provider: ${provider})`)
    );
    return { provider, apiKey: key };
  } finally {
    rl.close();
  }
}

// ---------------------------------------------------------------------------
// Phase 2 — Docker sandbox verification
// ---------------------------------------------------------------------------

type ContainerRuntime = "docker-desktop" | "colima" | "orbstack" | "generic-docker";

interface RuntimeDetection {
  available: boolean;
  runtime: ContainerRuntime | null;
  version: string | null;
  error: string | null;
}

/**
 * Detect which container runtime is available and running.
 * Checks for Docker Desktop, Colima, and OrbStack in priority order.
 */
function detectContainerRuntime(): RuntimeDetection {
  // First verify the docker CLI exists
  if (!isCommandAvailable("docker")) {
    return {
      available: false,
      runtime: null,
      version: null,
      error: "Docker CLI not found. Install Docker Desktop, Colima, or OrbStack.",
    };
  }

  // Check if the docker daemon is responsive
  try {
    const versionOutput = execFileSync("docker", ["version", "--format", "{{.Server.Version}}"], {
      timeout: 10_000,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    // Detect which runtime is backing the Docker daemon
    const runtime = identifyRuntime();

    return {
      available: true,
      runtime,
      version: versionOutput,
      error: null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // Provide actionable guidance based on detected but stopped runtimes
    if (isCommandAvailable("colima")) {
      return {
        available: false,
        runtime: "colima",
        version: null,
        error: `Colima is installed but the Docker daemon is not running. Start it with: colima start`,
      };
    }

    if (existsSync("/Applications/OrbStack.app")) {
      return {
        available: false,
        runtime: "orbstack",
        version: null,
        error: `OrbStack is installed but the Docker daemon is not running. Open OrbStack to start it.`,
      };
    }

    if (existsSync("/Applications/Docker.app")) {
      return {
        available: false,
        runtime: "docker-desktop",
        version: null,
        error: `Docker Desktop is installed but not running. Open Docker Desktop to start the daemon.`,
      };
    }

    return {
      available: false,
      runtime: null,
      version: null,
      error: `Docker daemon is not responding: ${message}`,
    };
  }
}

/**
 * Identify which container runtime is backing the Docker socket.
 */
function identifyRuntime(): ContainerRuntime {
  try {
    const infoOutput = execFileSync("docker", ["info", "--format", "{{.Name}}"], {
      timeout: 10_000,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim().toLowerCase();

    if (infoOutput.includes("orbstack")) return "orbstack";
    if (infoOutput.includes("colima")) return "colima";
    if (infoOutput.includes("docker-desktop") || infoOutput.includes("desktop")) return "docker-desktop";
  } catch {
    // Fall through to heuristic checks
  }

  // Heuristic: check Docker context
  try {
    const context = execFileSync("docker", ["context", "inspect", "--format", "{{.Name}}"], {
      timeout: 5_000,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim().toLowerCase();

    if (context.includes("colima")) return "colima";
    if (context.includes("orbstack")) return "orbstack";
    if (context === "default" || context.includes("desktop")) return "docker-desktop";
  } catch {
    // ignore
  }

  return "generic-docker";
}

function isCommandAvailable(cmd: string): boolean {
  try {
    execFileSync("which", [cmd], {
      timeout: 5_000,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a Docker image is available locally.
 */
function isImageAvailable(image: string): boolean {
  try {
    const output = execFileSync("docker", ["images", "-q", image], {
      timeout: 10_000,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return output.length > 0;
  } catch {
    return false;
  }
}

/**
 * Pull the sandbox Docker image.
 * Runs synchronously so the user sees progress output.
 */
function pullSandboxImage(image: string): { ok: boolean; error?: string } {
  try {
    execFileSync("docker", ["pull", image], {
      timeout: 300_000,
      stdio: "inherit",
    });
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Detect if the user has a legacy Python venv at ~/.sportsclaw/venv/.
 */
function hasLegacyVenv(): boolean {
  return existsSync(join(LEGACY_VENV_DIR, "bin", "python3"));
}

/**
 * Remove the legacy venv directory after user confirms migration.
 */
function removeLegacyVenv(): { ok: boolean; error?: string } {
  try {
    rmSync(LEGACY_VENV_DIR, { recursive: true, force: true });
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

interface SandboxSetupResult {
  dockerAvailable: boolean;
  runtime: ContainerRuntime | null;
  imageReady: boolean;
  environment: HostEnvironment;
  bindAddress: string;
  containerHost: string;
  legacyVenvHandled: boolean;
}

/**
 * Phase 2: Verify Docker sandbox prerequisites.
 *
 * 1. Detect and handle legacy venv users
 * 2. Verify a container runtime is available and running
 * 3. Configure OS-specific networking
 * 4. Pull the sandbox image if missing
 */
async function verifySandboxPrereqs(): Promise<SandboxSetupResult> {
  const result: SandboxSetupResult = {
    dockerAvailable: false,
    runtime: null,
    imageReady: false,
    environment: detectHostEnvironment(),
    bindAddress: "",
    containerHost: "",
    legacyVenvHandled: false,
  };

  console.log(pc.bold("\nDocker Sandbox Verification"));
  console.log(pc.dim("Checking container runtime and networking\n"));

  // --- Step 1: Legacy venv migration ---
  if (hasLegacyVenv()) {
    console.log(
      pc.yellow("Legacy Python venv detected at ~/.sportsclaw/venv/")
    );
    console.log(
      pc.dim(
        "sportsclaw now runs Python skills inside a Docker sandbox for better\n" +
        "isolation and reproducibility. The local venv is no longer needed."
      )
    );

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = await rl.question(
        pc.bold("Remove legacy venv? (y/N): ")
      );
      if (answer.trim().toLowerCase() === "y") {
        const removeResult = removeLegacyVenv();
        if (removeResult.ok) {
          console.log(pc.green("Legacy venv removed."));
          result.legacyVenvHandled = true;
        } else {
          console.log(
            pc.yellow(
              `Could not remove venv: ${removeResult.error}\n` +
              `You can remove it manually: rm -rf ~/.sportsclaw/venv/`
            )
          );
        }
      } else {
        console.log(
          pc.dim(
            "Keeping legacy venv. It will not be used for sandbox execution.\n" +
            "You can remove it later: rm -rf ~/.sportsclaw/venv/"
          )
        );
        result.legacyVenvHandled = true;
      }
    } finally {
      rl.close();
    }
    console.log("");
  } else {
    result.legacyVenvHandled = true;
  }

  // --- Step 2: Container runtime detection ---
  console.log(pc.dim("Checking container runtime..."));
  const detection = detectContainerRuntime();

  if (!detection.available) {
    console.log(pc.red(`Container runtime not available.`));
    console.log(pc.yellow(detection.error ?? "Unknown error."));

    if (detection.runtime) {
      // Runtime is installed but not running — give specific start instructions
      const startHints: Record<ContainerRuntime, string> = {
        "colima": "  Run: colima start",
        "orbstack": "  Open OrbStack from your Applications folder",
        "docker-desktop": "  Open Docker Desktop from your Applications folder",
        "generic-docker": "  Start the Docker daemon: sudo systemctl start docker",
      };
      console.log(pc.cyan(startHints[detection.runtime]));
    } else {
      console.log(
        pc.cyan(
          "\nInstall a container runtime:\n" +
          "  macOS:  brew install --cask orbstack   (recommended)\n" +
          "          brew install colima && colima start\n" +
          "          or install Docker Desktop\n" +
          "  Linux:  sudo apt install docker.io && sudo systemctl enable --now docker"
        )
      );
    }
    console.log("");
    return result;
  }

  result.dockerAvailable = true;
  result.runtime = detection.runtime;

  const runtimeLabel = detection.runtime === "docker-desktop"
    ? "Docker Desktop"
    : detection.runtime === "orbstack"
      ? "OrbStack"
      : detection.runtime === "colima"
        ? "Colima"
        : "Docker";

  console.log(
    pc.green(
      `${runtimeLabel} ${detection.version ?? ""} — running`
    )
  );

  // --- Step 3: OS-specific networking configuration ---
  result.bindAddress = resolveBindAddress(result.environment);
  result.containerHost = resolveContainerHost(result.environment, result.bindAddress);

  const envLabel =
    result.environment === "macos" ? "macOS" :
    result.environment === "wsl" ? "WSL" :
    "Linux";

  console.log(
    pc.dim(
      `Environment: ${envLabel}\n` +
      `Proxy bind:  ${result.bindAddress}\n` +
      `Container→host: ${result.containerHost}`
    )
  );

  // --- Step 4: Pull sandbox image ---
  console.log(pc.dim(`\nChecking for ${SANDBOX_IMAGE} image...`));

  if (isImageAvailable(SANDBOX_IMAGE)) {
    console.log(pc.green(`${SANDBOX_IMAGE} — available`));
    result.imageReady = true;
  } else {
    console.log(pc.yellow(`${SANDBOX_IMAGE} not found locally. Pulling...`));
    const pullResult = pullSandboxImage(SANDBOX_IMAGE);
    if (pullResult.ok) {
      console.log(pc.green(`${SANDBOX_IMAGE} — pulled successfully`));
      result.imageReady = true;
    } else {
      console.log(
        pc.red(
          `Failed to pull ${SANDBOX_IMAGE}: ${pullResult.error}\n` +
          `You can pull it manually: docker pull ${SANDBOX_IMAGE}`
        )
      );
    }
  }

  // Persist sandbox config
  const config = loadConfig();
  (config as Record<string, unknown>).sandbox = {
    runtime: result.runtime,
    environment: result.environment,
    bindAddress: result.bindAddress,
    containerHost: result.containerHost,
    image: SANDBOX_IMAGE,
    imageReady: result.imageReady,
  };
  saveConfig(config);

  console.log("");
  return result;
}

// ---------------------------------------------------------------------------
// Setup tools (Phase 3 — agentic loop)
// ---------------------------------------------------------------------------

function buildSetupTools(): ToolSet {
  const toolMap: ToolSet = {};

  toolMap["write_env_var"] = defineTool({
    description:
      "Write a key=value pair to ~/.sportsclaw/.env. Use for API keys, tokens, and config values.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        key: { type: "string", description: "Environment variable name" },
        value: { type: "string", description: "Value to set" },
      },
      required: ["key", "value"],
    }),
    execute: async (args: Record<string, unknown>) => {
      const key = String(args.key);
      const value = String(args.value);
      writeEnvVar(ENV_PATH, key, value);
      process.env[key] = value;
      return { ok: true, message: `Set ${key} in ~/.sportsclaw/.env` };
    },
  });

  toolMap["validate_telegram_token"] = defineTool({
    description:
      "Validate a Telegram bot token by calling the getMe API. Returns bot username on success.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        token: { type: "string", description: "Telegram bot token from BotFather" },
      },
      required: ["token"],
    }),
    execute: async (args: Record<string, unknown>) => {
      const token = String(args.token);
      try {
        const res = await fetch(
          `https://api.telegram.org/bot${token}/getMe`,
          { signal: AbortSignal.timeout(10_000) }
        );
        const data = (await res.json()) as {
          ok: boolean;
          result?: { username?: string };
        };
        if (data.ok && data.result?.username) {
          return { valid: true, username: data.result.username };
        }
        return { valid: false, error: "Invalid token — Telegram rejected it." };
      } catch (err) {
        return {
          valid: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });

  toolMap["validate_discord_token"] = defineTool({
    description:
      "Validate a Discord bot token by calling the /users/@me API. Returns bot username on success.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        token: { type: "string", description: "Discord bot token" },
      },
      required: ["token"],
    }),
    execute: async (args: Record<string, unknown>) => {
      const token = String(args.token);
      try {
        const res = await fetch("https://discord.com/api/v10/users/@me", {
          headers: { Authorization: `Bot ${token}` },
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) {
          return { valid: false, error: `Discord API returned ${res.status}` };
        }
        const data = (await res.json()) as { username?: string };
        return { valid: true, username: data.username ?? "unknown" };
      } catch (err) {
        return {
          valid: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });

  toolMap["get_current_config"] = defineTool({
    description:
      "Get current sportsclaw configuration: which API keys are set, platforms configured, sports installed, and sandbox status.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {},
    }),
    execute: async () => {
      const config = loadConfig();
      const envState = parseEnvFile(ENV_PATH);
      const schemas = listSchemas();
      const sandbox = (config as Record<string, unknown>).sandbox as Record<string, unknown> | undefined;

      return {
        provider: config.provider ?? process.env.SPORTSCLAW_PROVIDER ?? "not set",
        apiKeys: {
          anthropic: !!(process.env.ANTHROPIC_API_KEY || envState.ANTHROPIC_API_KEY),
          openai: !!(process.env.OPENAI_API_KEY || envState.OPENAI_API_KEY),
          google: !!(
            process.env.GOOGLE_GENERATIVE_AI_API_KEY ||
            envState.GOOGLE_GENERATIVE_AI_API_KEY
          ),
        },
        platforms: {
          discord: !!(
            config.chatIntegrations?.discord?.botToken ||
            process.env.DISCORD_BOT_TOKEN ||
            envState.DISCORD_BOT_TOKEN
          ),
          telegram: !!(
            config.chatIntegrations?.telegram?.botToken ||
            process.env.TELEGRAM_BOT_TOKEN ||
            envState.TELEGRAM_BOT_TOKEN
          ),
        },
        installedSports: schemas,
        selectedSports: config.selectedSports ?? [],
        sandbox: sandbox ?? null,
      };
    },
  });

  toolMap["install_sports"] = defineTool({
    description:
      "Install sport schemas (skill packages). Pass an array of sport names to install.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        sports: {
          type: "array",
          items: { type: "string" },
          description:
            "Sport names to install, e.g. ['nfl', 'nba', 'football']",
        },
      },
      required: ["sports"],
    }),
    execute: async (args: Record<string, unknown>) => {
      const sports = args.sports as string[];
      const results: Array<{ sport: string; ok: boolean; error?: string }> = [];
      for (const sport of sports) {
        try {
          const schema = await fetchSportSchema(sport);
          saveSchema(schema);
          results.push({ sport, ok: true });
        } catch (err) {
          results.push({
            sport,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Persist selections
      const config = loadConfig();
      const current = new Set(config.selectedSports ?? []);
      for (const r of results) {
        if (r.ok) current.add(r.sport);
      }
      config.selectedSports = [...current];
      saveConfig(config);

      const ok = results.filter((r) => r.ok).length;
      return { installed: ok, total: sports.length, results };
    },
  });

  toolMap["start_platform"] = defineTool({
    description:
      "Start a platform listener as a background daemon (requires PM2). Platform: 'discord' or 'telegram'.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        platform: {
          type: "string",
          enum: ["discord", "telegram"],
          description: "Platform to start",
        },
      },
      required: ["platform"],
    }),
    execute: async (args: Record<string, unknown>) => {
      const platform = String(args.platform);
      if (!isValidPlatform(platform)) {
        return { ok: false, error: `Invalid platform: ${platform}` };
      }
      try {
        applyConfigToEnv();
        daemonStart(platform);
        return { ok: true, message: `${platform} daemon started.` };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });

  toolMap["check_sandbox_status"] = defineTool({
    description:
      "Check the current Docker sandbox status: runtime availability, image presence, and networking config.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {},
    }),
    execute: async () => {
      const detection = detectContainerRuntime();
      const imagePresent = detection.available ? isImageAvailable(SANDBOX_IMAGE) : false;
      const env = detectHostEnvironment();
      const bind = resolveBindAddress(env);
      const containerHost = resolveContainerHost(env, bind);

      return {
        dockerAvailable: detection.available,
        runtime: detection.runtime,
        dockerVersion: detection.version,
        imagePresent,
        image: SANDBOX_IMAGE,
        environment: env,
        bindAddress: bind,
        containerHost,
        error: detection.error,
      };
    },
  });

  toolMap["pull_sandbox_image"] = defineTool({
    description:
      `Pull the ${SANDBOX_IMAGE} Docker image. Use when the sandbox image is missing.`,
    inputSchema: jsonSchema({
      type: "object",
      properties: {},
    }),
    execute: async () => {
      const pullResult = pullSandboxImage(SANDBOX_IMAGE);
      if (pullResult.ok) {
        // Update config
        const config = loadConfig();
        const sandbox = ((config as Record<string, unknown>).sandbox ?? {}) as Record<string, unknown>;
        sandbox.imageReady = true;
        (config as Record<string, unknown>).sandbox = sandbox;
        saveConfig(config);
      }
      return pullResult;
    },
  });

  return toolMap;
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

function buildSystemPrompt(sandboxResult: SandboxSetupResult): string {
  const sportList = Object.entries(SKILL_DESCRIPTIONS)
    .map(([key, desc]) => `  - ${key}: ${desc}`)
    .join("\n");

  const sandboxStatus = sandboxResult.dockerAvailable
    ? `Docker sandbox is ready (${sandboxResult.runtime ?? "docker"}, image: ${sandboxResult.imageReady ? "available" : "missing"}).`
    : "Docker sandbox is NOT available. The user needs to install a container runtime.";

  return `You are the sportsclaw setup assistant. Your job is to configure sportsclaw quickly and correctly.

RULES:
- Ask ONE question at a time. Never dump a wall of options.
- When you receive a token, validate it IMMEDIATELY using the validation tool. Don't ask permission.
- After validating, save the token to .env using write_env_var.
- Call get_current_config FIRST to see what's already configured. Skip steps that are done.
- Be direct and efficient. No fluff, no AI cheerfulness.
- When everything is configured, say "Setup complete!" to end the wizard.

SANDBOX STATUS:
${sandboxStatus}
Environment: ${sandboxResult.environment}
Credential proxy bind: ${sandboxResult.bindAddress || "not configured"}
Container host: ${sandboxResult.containerHost || "not configured"}

PLATFORM GUIDES:

Discord:
1. Go to https://discord.com/developers/applications
2. Create a New Application → Bot → Reset Token → copy it
3. Enable MESSAGE CONTENT INTENT under Privileged Gateway Intents
4. Invite URL: Settings → OAuth2 → URL Generator → bot scope → Send Messages + Read Message History

Telegram:
1. Open Telegram, message @BotFather
2. Send /newbot, follow the prompts
3. Copy the token BotFather gives you

AVAILABLE SPORTS:
${sportList}

Default recommendations for new users: nfl, nba, mlb, football, news

FLOW:
1. Check current config
2. If Docker sandbox is not ready, advise the user on how to fix it
3. If no platform tokens → ask which platform(s) the user wants
4. Collect and validate tokens
5. Ask which sports to install (suggest defaults based on user intent)
6. Install sports
7. Optionally start the daemon
8. Say "Setup complete!"

If the user provided an initial prompt with their intent, use it to skip unnecessary questions.`;
}

// ---------------------------------------------------------------------------
// Agentic loop
// ---------------------------------------------------------------------------

export async function runSetup(initialPrompt?: string, opts?: { fromChat?: boolean }): Promise<void> {
  if (!opts?.fromChat) {
    console.log(pc.bold(pc.blue(ASCII_LOGO)));
  }
  console.log(pc.bold("sportsclaw Setup"));
  console.log(pc.dim("AI-guided configuration wizard\n"));

  // Phase 1: deterministic API key bootstrap
  const { provider } = await bootstrapApiKey();

  // Phase 2: Docker sandbox verification
  const sandboxResult = await verifySandboxPrereqs();

  // Phase 3: Agentic loop
  const modelId = DEFAULT_MODELS[provider];
  const model = resolveModel(provider, modelId);

  const tools = buildSetupTools();
  const system = buildSystemPrompt(sandboxResult);

  // Conversation state
  const messages: ModelMessage[] = [];
  const firstMessage = initialPrompt || "Help me set up sportsclaw.";
  messages.push({ role: "user", content: firstMessage });

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  const MAX_TURNS = 30;

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const result = await generateText({
        model,
        system,
        messages,
        tools,
        stopWhen: stepCountIs(10),
      });

      const text = result.text ?? "";

      if (text) {
        const rendered = formatResponse(text, "cli").text;
        console.log(rendered);
        console.log("");
      }

      // Append full response (assistant + tool messages) to preserve tool call context
      messages.push(...result.response.messages);

      // Check for completion signal
      if (text.toLowerCase().includes("setup complete")) {
        break;
      }

      // If the model only called tools with no text, continue without prompting
      if (!text && result.steps && result.steps.length > 0) {
        continue;
      }

      // Prompt user for next input
      const userInput = await rl.question(pc.bold("> "));
      const trimmed = userInput.trim();

      if (!trimmed || trimmed === "exit" || trimmed === "quit") {
        console.log(pc.dim("Exiting setup."));
        break;
      }

      messages.push({ role: "user", content: trimmed });
    }
  } finally {
    rl.close();
  }
}
