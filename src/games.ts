import { execFile } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import {
  createBuildSourceBinding,
  parseBuildBrief,
  renderFactoryBuildTask,
  type BuildBrief,
  type BuildSourceBinding,
} from "./build-brief.js";

export const GAME_BUILD_BRIEF_PATH = ".machina/build-brief.json";
const SOURCE_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const execFileAsync = promisify(execFile);

export interface GamesBuildInput {
  targetDirectory: string;
  repository: string;
  projectId: string;
  sourceRef: string;
  consent?: boolean;
}

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface GamesDependencies {
  readBrief(path: string): Promise<string>;
  inspectPath(path: string): Promise<{
    isFile: boolean;
    isSymbolicLink: boolean;
  }>;
  run(file: string, args: string[]): Promise<ProcessResult>;
}

export interface PreparedGamesBuild {
  brief: BuildBrief;
  briefPath: string;
  argv: string[];
}

const defaultDependencies: GamesDependencies = {
  readBrief: (path) => readFile(path, "utf-8"),
  inspectPath: async (path) => {
    const stats = await lstat(path);
    return {
      isFile: stats.isFile(),
      isSymbolicLink: stats.isSymbolicLink(),
    };
  },
  run: async (file, args) => {
    try {
      const result = await execFileAsync(file, args, {
        encoding: "utf-8",
        timeout: 60_000,
        maxBuffer: 1024 * 1024,
      });
      return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      const detail = error as {
        code?: number | string;
        stdout?: string;
        stderr?: string;
      };
      return {
        exitCode: typeof detail.code === "number" ? detail.code : 1,
        stdout: detail.stdout ?? "",
        stderr: detail.stderr ?? (error instanceof Error ? error.message : String(error)),
      };
    }
  },
};

function assertSourceRef(sourceRef: string): void {
  if (
    !SOURCE_REF_PATTERN.test(sourceRef) ||
    sourceRef.includes("..") ||
    sourceRef.endsWith("/") ||
    sourceRef.includes("//")
  ) {
    throw new Error("Invalid source ref");
  }
}

export function buildFactoryArgv(
  brief: BuildBrief,
  sourceRef: string,
  binding?: BuildSourceBinding,
): string[] {
  assertSourceRef(sourceRef);
  return [
    "factory",
    "run",
    renderFactoryBuildTask(sourceRef, binding),
    "--repo",
    brief.project.repository,
    "--project",
    brief.project.id,
    "--json",
  ];
}

export async function prepareGamesBuild(
  input: GamesBuildInput,
  dependencies: GamesDependencies = defaultDependencies,
): Promise<PreparedGamesBuild> {
  assertSourceRef(input.sourceRef);
  const targetDirectory = resolve(input.targetDirectory);
  const machinaDirectory = resolve(targetDirectory, ".machina");
  const briefPath = resolve(targetDirectory, GAME_BUILD_BRIEF_PATH);
  if (!briefPath.startsWith(`${targetDirectory}/`)) {
    throw new Error("Build brief path is outside the target repository");
  }

  const [targetInfo, directoryInfo, fileInfo] = await Promise.all([
    dependencies.inspectPath(targetDirectory),
    dependencies.inspectPath(machinaDirectory),
    dependencies.inspectPath(briefPath),
  ]);
  if (
    targetInfo.isSymbolicLink ||
    directoryInfo.isSymbolicLink ||
    fileInfo.isSymbolicLink
  ) {
    throw new Error("Build brief path must not contain symbolic links");
  }
  if (!fileInfo.isFile) throw new Error(`Build brief not found: ${briefPath}`);

  const brief = parseBuildBrief(await dependencies.readBrief(briefPath), {
    allowedSkills: ["game-builder"],
    expectedProjectId: input.projectId,
    expectedRepository: input.repository,
  });
  return {
    brief,
    briefPath,
    argv: buildFactoryArgv(brief, input.sourceRef),
  };
}

export function parseFactoryJobId(output: string): string {
  const record = parseJsonObjectOutput(output, "Factory submission");
  if (
    record.error !== undefined ||
    record.ok === false ||
    record.success === false ||
    (typeof record.status === "string" &&
      ["error", "failed", "failure"].includes(record.status.toLowerCase()))
  ) {
    throw new Error("Factory submission returned an error status");
  }
  const ids = new Set<string>();
  for (const candidate of [record.projectId, record.jobId, record.id]) {
    if (typeof candidate === "string" && JOB_ID_PATTERN.test(candidate)) ids.add(candidate);
  }
  if (ids.size !== 1) {
    throw new Error("Factory submission did not return exactly one valid job id");
  }
  return [...ids][0];
}

function parseJsonObjectOutput(
  output: string,
  operation: string,
): Record<string, unknown> {
  const normalized = output.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").trim();
  let value: unknown;
  try {
    value = JSON.parse(normalized) as unknown;
  } catch {
    throw new Error(`${operation} did not return valid JSON`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${operation} did not return a JSON object`);
  }
  return value as Record<string, unknown>;
}

export function parseWhoamiProjectId(output: string, expectedProjectId?: string): string {
  const record = parseJsonObjectOutput(output, "Factory identity check");
  if (record.error !== undefined) {
    throw new Error("Factory identity check returned an error status");
  }
  const projectId = record.projectId;
  if (typeof projectId !== "string" || !JOB_ID_PATTERN.test(projectId)) {
    throw new Error("Factory identity check did not return a valid projectId");
  }
  if (expectedProjectId && projectId !== expectedProjectId) {
    throw new Error("Factory identity check returned a different project");
  }
  return projectId;
}

function normalizeGitHubRepositoryUrl(value: string): string | null {
  const trimmed = value.trim();
  const scpMatch = /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/.exec(trimmed);
  if (scpMatch) return `${scpMatch[1]}/${scpMatch[2]}`.toLowerCase();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (
    !["https:", "ssh:"].includes(url.protocol) ||
    url.hostname.toLowerCase() !== "github.com" ||
    url.password ||
    url.search ||
    url.hash
  ) {
    return null;
  }
  if (url.protocol === "https:" && url.username) return null;
  if (url.protocol === "ssh:" && url.username !== "git") return null;
  const parts = url.pathname.replace(/^\//, "").replace(/\/$/, "").split("/");
  if (parts.length !== 2) return null;
  const repository = `${parts[0]}/${parts[1]!.replace(/\.git$/, "")}`;
  return /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repository)
    ? repository.toLowerCase()
    : null;
}

function commandFailure(operation: string, result: ProcessResult): Error {
  return new Error(`${operation} failed (exit code ${result.exitCode})`);
}

async function verifyRemoteTrackingBrief(
  prepared: PreparedGamesBuild,
  input: GamesBuildInput,
  dependencies: GamesDependencies,
): Promise<BuildSourceBinding> {
  const targetDirectory = resolve(input.targetDirectory);
  const origin = await dependencies.run("git", [
    "-C",
    targetDirectory,
    "remote",
    "get-url",
    "origin",
  ]);
  if (origin.exitCode !== 0) throw commandFailure("Git origin verification", origin);
  const originUrl = origin.stdout.trim();
  if (normalizeGitHubRepositoryUrl(originUrl) !== input.repository.toLowerCase()) {
    throw new Error("Git origin does not match the requested GitHub repository");
  }

  const remoteRef = `refs/remotes/origin/${input.sourceRef}`;
  const fetchResult = await dependencies.run("git", [
    "-C",
    targetDirectory,
    "fetch",
    "--no-tags",
    originUrl,
    `+refs/heads/${input.sourceRef}:${remoteRef}`,
  ]);
  if (fetchResult.exitCode !== 0) throw commandFailure("Git branch fetch", fetchResult);

  const objectName = `refs/remotes/origin/${input.sourceRef}:${GAME_BUILD_BRIEF_PATH}`;
  const result = await dependencies.run("git", [
    "-C",
    targetDirectory,
    "show",
    objectName,
  ]);
  if (result.exitCode !== 0) {
    throw commandFailure("Remote build brief verification", result);
  }
  const remoteBrief = parseBuildBrief(result.stdout, {
    allowedSkills: ["game-builder"],
    expectedProjectId: input.projectId,
    expectedRepository: input.repository,
  });
  if (JSON.stringify(remoteBrief) !== JSON.stringify(prepared.brief)) {
    throw new Error(
      `Local ${GAME_BUILD_BRIEF_PATH} differs from refs/remotes/origin/${input.sourceRef}`,
    );
  }
  const commitResult = await dependencies.run("git", [
    "-C",
    targetDirectory,
    "rev-parse",
    "--verify",
    `${remoteRef}^{commit}`,
  ]);
  if (commitResult.exitCode !== 0) {
    throw commandFailure("Remote commit verification", commitResult);
  }
  return createBuildSourceBinding({
    brief: remoteBrief,
    repository: input.repository,
    ref: input.sourceRef,
    commit: commitResult.stdout.trim(),
  });
}

export async function submitGamesBuild(
  input: GamesBuildInput,
  dependencies: GamesDependencies = defaultDependencies,
): Promise<{ jobId: string; argv: string[] }> {
  if (input.consent !== true) {
    throw new Error("Explicit caller consent is required to submit a Factory job");
  }
  const prepared = await prepareGamesBuild(input, dependencies);
  const binding = await verifyRemoteTrackingBrief(prepared, input, dependencies);
  const identity = await dependencies.run("machina", [
    "factory",
    "whoami",
    "--project",
    input.projectId,
    "--json",
  ]);
  if (identity.exitCode !== 0) {
    throw commandFailure("Factory identity check", identity);
  }
  parseWhoamiProjectId(identity.stdout, input.projectId);

  const argv = buildFactoryArgv(prepared.brief, input.sourceRef, binding);
  const result = await dependencies.run("machina", argv);
  if (result.exitCode !== 0) {
    throw commandFailure("Factory submission", result);
  }
  try {
    return { jobId: parseFactoryJobId(result.stdout), argv };
  } catch {
    throw new Error("Factory submission returned success without a valid job id");
  }
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

export async function cmdGames(args: string[]): Promise<void> {
  const command = args[0];
  if (!(command === "prepare" || command === "submit")) {
    throw new Error(
      "Usage: sportsclaw games <prepare|submit> --target <dir> --repo <owner/name> --project <id> --ref <branch> [--yes]",
    );
  }
  const targetDirectory = option(args, "--target");
  const repository = option(args, "--repo");
  const projectId = option(args, "--project");
  const sourceRef = option(args, "--ref");
  if (!(targetDirectory && repository && projectId && sourceRef)) {
    throw new Error("games requires --target, --repo, --project, and --ref");
  }
  const input: GamesBuildInput = {
    targetDirectory,
    repository,
    projectId,
    sourceRef,
    consent: args.includes("--yes"),
  };
  if (command === "prepare") {
    const prepared = await prepareGamesBuild(input);
    console.log(JSON.stringify({ brief: prepared.brief, command: "machina", argv: prepared.argv }, null, 2));
    return;
  }
  const result = await submitGamesBuild(input);
  console.log(JSON.stringify({
    jobId: result.jobId,
    status: ["machina", "factory", "status", result.jobId],
    watch: ["machina", "factory", "watch", result.jobId],
    logs: ["machina", "factory", "logs", result.jobId],
  }));
}
