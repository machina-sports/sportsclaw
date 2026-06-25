// ---------------------------------------------------------------------------
// CLI: `sportsclaw machina connect [project]` — wire a Machina premium pod
// into this agent via the machina-cli `connect` resolver (no pasted URL).
// ---------------------------------------------------------------------------

import { execFileSync } from "node:child_process";
import pc from "picocolors";

import { ENV_PATH, writeEnvVar } from "./config.js";
import {
  loadMcpConfigs,
  saveMcpConfigs,
  getMcpConfigPath,
  mcpEnvKey,
  validateConnectBundle,
} from "./mcp.js";

export async function cmdMachina(args: string[]): Promise<void> {
  const sub = args[0];
  if (sub !== "connect") {
    console.error("Usage: sportsclaw machina connect [project] [--org <org>] [--probe]");
    console.error("  Connects a Machina premium pod via machina-cli (mints a durable key).");
    process.exit(1);
  }

  let project: string | undefined;
  let org: string | undefined;
  let probe = false;
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === "--org" && args[i + 1]) org = args[++i];
    else if (a === "--probe") probe = true;
    else if (!a.startsWith("-") && !project) project = a;
  }

  const parse = (s: string): Record<string, unknown> | null => {
    try {
      return JSON.parse(s) as Record<string, unknown>;
    } catch {
      return null;
    }
  };

  // Resolve the connection bundle via machina-cli (it owns auth + MCP
  // resolution). --mint yields a durable X-Api-Token (no expiry); --reveal
  // returns the real token so we can register it.
  const connectArgs = [
    "connect",
    ...(project ? [project] : []),
    "--json",
    "--reveal",
    "--mint",
    ...(org ? ["--org", org] : []),
    ...(probe ? ["--probe"] : []),
  ];

  let raw: string;
  try {
    raw = execFileSync("machina", connectArgs, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    });
  } catch (err) {
    const e = err as { code?: string; stdout?: Buffer | string; stderr?: Buffer | string };
    if (e.code === "ENOENT") {
      console.error(pc.red("machina-cli not found."));
      console.error(`  Install it: ${pc.cyan("pip install machina-cli")}, then ${pc.cyan("machina login")}.`);
      process.exit(1);
    }
    if (e.code === "ETIMEDOUT") {
      console.error(pc.red("machina connect timed out (30s) — the pod may be unreachable."));
      console.error(`  Check ${pc.cyan("machina status")} and retry.`);
      process.exit(1);
    }
    const out = (e.stdout ?? "").toString().trim();
    const errText = (e.stderr ?? "").toString().trim();
    const combined = `${out}\n${errText}`;
    if (/no such command|usage: machina/i.test(combined) && !parse(out)?.error) {
      console.error(pc.red("This machina-cli is too old — it has no `connect` command."));
      console.error(`  Upgrade it: ${pc.cyan("pip install --upgrade machina-cli")}`);
      process.exit(1);
    }
    const msg = parse(out)?.error || errText || "machina connect failed";
    console.error(pc.red(`Could not connect: ${String(msg)}`));
    if (/auth|session|login|not authenticated/i.test(combined)) {
      console.error(`  Run ${pc.cyan("machina login")} first, then retry.`);
    } else if (/organization|org/i.test(combined)) {
      console.error(`  Pass ${pc.cyan("--org <org-id>")} or set a default org in machina-cli.`);
    }
    process.exit(1);
  }

  const configs = loadMcpConfigs();
  const result = validateConnectBundle(parse(raw.trim()), configs);
  if (!result.ok) {
    console.error(pc.red(result.error));
    if (result.hint) console.error(pc.dim(`  ${result.hint}`));
    process.exit(1);
  }
  const { name, url, token, durable } = result;
  const isUpdate = name in configs;

  // Register like `mcp add`: write the secret to ~/.sportsclaw/.env FIRST (so a
  // failure never leaves a tokenless config), then the config in mcp.json. The
  // MCP manager injects SPORTSCLAW_MCP_TOKEN_<NAME> as X-Api-Token at connect time.
  try {
    writeEnvVar(ENV_PATH, mcpEnvKey(name), token);
    configs[name] = { url, provider: "machina" };
    saveMcpConfigs(configs);
  } catch (e) {
    console.error(pc.red(`Failed to save the connection: ${(e as Error).message}`));
    console.error(`  The token may be in ${ENV_PATH} but the pod was not registered — re-run to retry.`);
    process.exit(1);
  }

  console.log(pc.green(isUpdate ? `Reconnected Machina pod "${name}"` : `Connected Machina pod "${name}"`));
  console.log(`  URL: ${url}`);
  console.log(pc.dim(`  Auth: X-Api-Token${durable ? " (durable key)" : " (session token — may expire)"}`));
  console.log(pc.dim(`  Config: ${getMcpConfigPath()}`));
  if (!durable) {
    console.log(pc.yellow("  Note: not a durable key — re-run this if the connection later returns 401."));
  }
  console.log("");
  console.log(`Verify with ${pc.cyan("sportsclaw mcp list")}. Restart any running listeners to pick it up.`);
}
