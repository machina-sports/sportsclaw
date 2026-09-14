import { createHash } from "node:crypto";

export const BUILD_BRIEF_SCHEMA_VERSION = 1 as const;
export const BUILD_BRIEF_MAX_BYTES = 128 * 1024;
export const BUILD_BRIEF_READ_ONLY_CAPABILITIES = Object.freeze([
  "search_agents",
  "search_documents",
  "search_workflow",
] as const);

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const REPOSITORY_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const CAPABILITY_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/;
const FORBIDDEN_NORMALIZED_KEYS = new Set([
  "accesstoken",
  "apikey",
  "authorization",
  "clientsecret",
  "credential",
  "credentials",
  "password",
  "privatekey",
  "refreshtoken",
  "secret",
  "secrets",
  "token",
]);
const SOURCE_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const SOURCE_BINDING_PREFIX = "BUILD_SOURCE_BINDING=";

type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };
export type JsonObject = Record<string, JsonValue>;

export interface BuildBrief {
  schemaVersion: 1;
  kind: "sports-game";
  project: {
    id: string;
    repository: string;
    podUrl: string;
  };
  selection: {
    capabilities: string[];
    skills: string[];
  };
  game: {
    name: string;
    request: string;
  };
  data: {
    mode: "frozen" | "live" | "hybrid";
    provenance: Array<{
      source: string;
      observedAt: string;
      verification: "sample" | "verified";
    }>;
    freshness: {
      asOf: string;
      maxAgeSeconds: number;
    };
    interfaces: Array<{
      name: string;
      kind: "endpoint" | "tool";
      inputSchema: JsonObject;
      outputSchema: JsonObject;
      representativeRecords: JsonObject[];
    }>;
  };
  resources: {
    existing: string[];
    missing: string[];
  };
  acceptanceChecks: Array<{
    id: string;
    description: string;
    command?: string;
  }>;
  mutations: {
    credentials: false;
    deployment: false;
    podWrites: false;
  };
}

export interface BuildBriefValidationContext {
  allowedSkills?: readonly string[];
  expectedProjectId?: string;
  expectedRepository?: string;
  expectedPodUrl?: string;
}

function fail(path: string, message: string): never {
  throw new Error(`Invalid build brief at ${path}: ${message}`);
}

function objectAt(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(path, "expected an object");
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) fail(`${path}.${key}`, "unknown field");
  }
}

function stringAt(
  value: unknown,
  path: string,
  options: { max?: number; pattern?: RegExp } = {},
): string {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length === 0
  ) {
    fail(path, "expected a non-empty trimmed string");
  }
  if (value.length > (options.max ?? 10_000)) fail(path, "string is too long");
  if (options.pattern && !options.pattern.test(value)) {
    fail(path, "has an invalid format");
  }
  return value;
}

function stringArrayAt(
  value: unknown,
  path: string,
  options: { min?: number; max?: number; pattern?: RegExp } = {},
): string[] {
  if (!Array.isArray(value)) fail(path, "expected an array");
  if (value.length < (options.min ?? 0)) fail(path, "has too few items");
  if (value.length > (options.max ?? 32)) fail(path, "has too many items");
  const result = value.map((item, index) =>
    stringAt(item, `${path}[${index}]`, {
      max: 256,
      pattern: options.pattern,
    }),
  );
  if (new Set(result).size !== result.length) fail(path, "contains duplicates");
  return result;
}

function isoDateAt(value: unknown, path: string): string {
  const date = stringAt(value, path, { max: 64 });
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(date)) {
    fail(path, "expected an ISO-8601 UTC timestamp");
  }
  if (Number.isNaN(Date.parse(date))) fail(path, "expected a valid timestamp");
  return date;
}

function jsonObjectAt(value: unknown, path: string): JsonObject {
  const object = objectAt(value, path);
  assertJsonValue(object, path);
  return object as JsonObject;
}

function assertJsonValue(value: unknown, path: string, depth = 0): void {
  if (depth > 20) fail(path, "JSON nesting exceeds 20 levels");
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(path, "number must be finite");
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 100) fail(path, "array has too many items");
    value.forEach((item, index) =>
      assertJsonValue(item, `${path}[${index}]`, depth + 1),
    );
    return;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > 100) fail(path, "object has too many fields");
    for (const [key, item] of entries) {
      assertJsonValue(item, `${path}.${key}`, depth + 1);
    }
    return;
  }
  fail(path, "must contain JSON-compatible values only");
}

function isCredentialKey(key: string): boolean {
  const normalizedKey = key.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  return (
    FORBIDDEN_NORMALIZED_KEYS.has(normalizedKey) ||
    /(?:apikey|authorization|credentials?|password|privatekey|secret|token)$/.test(
      normalizedKey,
    )
  );
}

function rejectCredentialFields(value: unknown, path = "$", depth = 0): void {
  if (depth > 20) fail(path, "nesting exceeds 20 levels");
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      rejectCredentialFields(item, `${path}[${index}]`, depth + 1),
    );
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const childPath = `${path}.${key}`;
    if (isCredentialKey(key)) {
      fail(childPath, "credential and secret fields are forbidden");
    }
    rejectCredentialFields(item, childPath, depth + 1);
  }
}

function rejectCredentialValuesInSchema(
  value: unknown,
  path: string,
  depth = 0,
): void {
  if (depth > 20) fail(path, "nesting exceeds 20 levels");
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      rejectCredentialValuesInSchema(item, `${path}[${index}]`, depth + 1),
    );
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (
      key === "properties" &&
      typeof item === "object" &&
      item !== null &&
      !Array.isArray(item)
    ) {
      for (const [propertyName, definition] of Object.entries(item)) {
        rejectCredentialValuesInSchema(
          definition,
          `${path}.properties.${propertyName}`,
          depth + 1,
        );
      }
      continue;
    }
    const childPath = `${path}.${key}`;
    if (isCredentialKey(key)) {
      fail(childPath, "credential and secret fields are forbidden");
    }
    rejectCredentialValuesInSchema(item, childPath, depth + 1);
  }
}

function parsePodUrl(value: unknown): string {
  const raw = stringAt(value, "$.project.podUrl", { max: 512 });
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    fail("$.project.podUrl", "expected a valid URL");
  }
  if (
    url.protocol !== "https:" ||
    !url.hostname ||
    url.username ||
    url.password ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.hash
  ) {
    fail(
      "$.project.podUrl",
      "must be an HTTPS origin without credentials, path, query, or fragment",
    );
  }
  return url.origin;
}

export function parseBuildBrief(
  input: string | unknown,
  context: BuildBriefValidationContext = {},
): BuildBrief {
  let value: unknown = input;
  if (typeof input === "string") {
    const bytes = new TextEncoder().encode(input).byteLength;
    if (bytes > BUILD_BRIEF_MAX_BYTES) {
      fail("$", `size exceeds ${BUILD_BRIEF_MAX_BYTES} bytes`);
    }
    try {
      value = JSON.parse(input) as unknown;
    } catch {
      fail("$", "expected valid JSON");
    }
  } else {
    const serialized = JSON.stringify(input);
    if (serialized === undefined) fail("$", "expected JSON-compatible input");
    if (
      new TextEncoder().encode(serialized).byteLength > BUILD_BRIEF_MAX_BYTES
    ) {
      fail("$", `size exceeds ${BUILD_BRIEF_MAX_BYTES} bytes`);
    }
  }

  const root = objectAt(value, "$");
  exactKeys(
    root,
    [
      "schemaVersion",
      "kind",
      "project",
      "selection",
      "game",
      "data",
      "resources",
      "acceptanceChecks",
      "mutations",
    ],
    "$",
  );
  if (root.schemaVersion !== BUILD_BRIEF_SCHEMA_VERSION) {
    fail("$.schemaVersion", `must equal ${BUILD_BRIEF_SCHEMA_VERSION}`);
  }
  if (root.kind !== "sports-game") fail("$.kind", 'must equal "sports-game"');

  const project = objectAt(root.project, "$.project");
  exactKeys(project, ["id", "repository", "podUrl"], "$.project");
  const projectId = stringAt(project.id, "$.project.id", {
    max: 128,
    pattern: IDENTIFIER_PATTERN,
  });
  const repository = stringAt(project.repository, "$.project.repository", {
    max: 201,
    pattern: REPOSITORY_PATTERN,
  });
  const podUrl = parsePodUrl(project.podUrl);
  if (context.expectedProjectId && projectId !== context.expectedProjectId) {
    fail("$.project.id", "does not match the trusted project context");
  }
  if (
    context.expectedRepository &&
    repository.toLowerCase() !== context.expectedRepository.toLowerCase()
  ) {
    fail("$.project.repository", "does not match the trusted repository");
  }
  if (context.expectedPodUrl) {
    const expectedPodUrl = parsePodUrl(context.expectedPodUrl);
    if (podUrl !== expectedPodUrl) {
      fail("$.project.podUrl", "does not match the trusted project context");
    }
  }

  const selection = objectAt(root.selection, "$.selection");
  exactKeys(selection, ["capabilities", "skills"], "$.selection");
  const capabilities = stringArrayAt(
    selection.capabilities,
    "$.selection.capabilities",
    { min: 1, pattern: CAPABILITY_PATTERN },
  );
  const readOnlyCapabilities = new Set<string>(
    BUILD_BRIEF_READ_ONLY_CAPABILITIES,
  );
  for (const capability of capabilities) {
    if (!readOnlyCapabilities.has(capability)) {
      fail(
        "$.selection.capabilities",
        `unsupported requested capability "${capability}"`,
      );
    }
  }
  const skills = stringArrayAt(selection.skills, "$.selection.skills", {
    min: 1,
    pattern: IDENTIFIER_PATTERN,
  });
  if (context.allowedSkills) {
    const allowedSkills = new Set(context.allowedSkills);
    for (const skill of skills) {
      if (!allowedSkills.has(skill)) {
        fail("$.selection.skills", `unsupported requested skill "${skill}"`);
      }
    }
  }

  const game = objectAt(root.game, "$.game");
  exactKeys(game, ["name", "request"], "$.game");
  const gameName = stringAt(game.name, "$.game.name", { max: 200 });
  const gameRequest = stringAt(game.request, "$.game.request", { max: 10_000 });

  const data = objectAt(root.data, "$.data");
  exactKeys(data, ["mode", "provenance", "freshness", "interfaces"], "$.data");
  if (
    !(data.mode === "frozen" || data.mode === "live" || data.mode === "hybrid")
  ) {
    fail("$.data.mode", "must be frozen, live, or hybrid");
  }
  if (!Array.isArray(data.provenance) || data.provenance.length === 0) {
    fail("$.data.provenance", "must contain observed data provenance");
  }
  if (data.provenance.length > 16)
    fail("$.data.provenance", "has too many items");
  const provenance = data.provenance.map((item, index) => {
    const path = `$.data.provenance[${index}]`;
    const record = objectAt(item, path);
    exactKeys(record, ["source", "observedAt", "verification"], path);
    if (
      !(record.verification === "sample" || record.verification === "verified")
    ) {
      fail(`${path}.verification`, "must be sample or verified");
    }
    return {
      source: stringAt(record.source, `${path}.source`, { max: 256 }),
      observedAt: isoDateAt(record.observedAt, `${path}.observedAt`),
      verification: record.verification as "sample" | "verified",
    };
  });
  const freshness = objectAt(data.freshness, "$.data.freshness");
  exactKeys(freshness, ["asOf", "maxAgeSeconds"], "$.data.freshness");
  const maxAgeSeconds = freshness.maxAgeSeconds;
  if (!Number.isInteger(maxAgeSeconds) || (maxAgeSeconds as number) < 1) {
    fail("$.data.freshness.maxAgeSeconds", "must be a positive integer");
  }
  if (!Array.isArray(data.interfaces) || data.interfaces.length === 0) {
    fail(
      "$.data.interfaces",
      "must contain exact interfaces and observed records",
    );
  }
  if (data.interfaces.length > 32)
    fail("$.data.interfaces", "has too many items");
  const interfaces = data.interfaces.map((item, index) => {
    const path = `$.data.interfaces[${index}]`;
    const record = objectAt(item, path);
    exactKeys(
      record,
      ["name", "kind", "inputSchema", "outputSchema", "representativeRecords"],
      path,
    );
    if (!(record.kind === "endpoint" || record.kind === "tool")) {
      fail(`${path}.kind`, "must be endpoint or tool");
    }
    if (
      !Array.isArray(record.representativeRecords) ||
      record.representativeRecords.length === 0
    ) {
      fail(
        `${path}.representativeRecords`,
        "must contain observed sample data",
      );
    }
    if (record.representativeRecords.length > 5) {
      fail(`${path}.representativeRecords`, "has too many items");
    }
    const inputSchemaPath = `${path}.inputSchema`;
    const outputSchemaPath = `${path}.outputSchema`;
    rejectCredentialValuesInSchema(record.inputSchema, inputSchemaPath);
    rejectCredentialValuesInSchema(record.outputSchema, outputSchemaPath);
    return {
      name: stringAt(record.name, `${path}.name`, {
        max: 128,
        pattern: CAPABILITY_PATTERN,
      }),
      kind: record.kind as "endpoint" | "tool",
      inputSchema: jsonObjectAt(record.inputSchema, inputSchemaPath),
      outputSchema: jsonObjectAt(record.outputSchema, outputSchemaPath),
      representativeRecords: record.representativeRecords.map(
        (sample, sampleIndex) => {
          const samplePath = `${path}.representativeRecords[${sampleIndex}]`;
          rejectCredentialFields(sample, samplePath);
          return jsonObjectAt(sample, samplePath);
        },
      ),
    };
  });
  for (const capability of capabilities) {
    if (!interfaces.some((item) => item.name === capability)) {
      fail(
        "$.selection.capabilities",
        `capability "${capability}" has no exact interface schema`,
      );
    }
  }

  const resources = objectAt(root.resources, "$.resources");
  exactKeys(resources, ["existing", "missing"], "$.resources");
  const existing = stringArrayAt(resources.existing, "$.resources.existing");
  const missing = stringArrayAt(resources.missing, "$.resources.missing");

  if (
    !Array.isArray(root.acceptanceChecks) ||
    root.acceptanceChecks.length === 0
  ) {
    fail("$.acceptanceChecks", "must contain at least one acceptance check");
  }
  if (root.acceptanceChecks.length > 32)
    fail("$.acceptanceChecks", "has too many items");
  const acceptanceChecks = root.acceptanceChecks.map((item, index) => {
    const path = `$.acceptanceChecks[${index}]`;
    const record = objectAt(item, path);
    exactKeys(record, ["id", "description", "command"], path);
    return {
      id: stringAt(record.id, `${path}.id`, {
        max: 128,
        pattern: IDENTIFIER_PATTERN,
      }),
      description: stringAt(record.description, `${path}.description`, {
        max: 2_000,
      }),
      ...(record.command === undefined
        ? {}
        : {
            command: stringAt(record.command, `${path}.command`, {
              max: 1_000,
            }),
          }),
    };
  });

  const mutations = objectAt(root.mutations, "$.mutations");
  exactKeys(
    mutations,
    ["credentials", "deployment", "podWrites"],
    "$.mutations",
  );
  if (
    mutations.credentials !== false ||
    mutations.deployment !== false ||
    mutations.podWrites !== false
  ) {
    fail("$.mutations", "all mutation permissions must be explicitly false");
  }

  return {
    schemaVersion: BUILD_BRIEF_SCHEMA_VERSION,
    kind: "sports-game",
    project: { id: projectId, repository, podUrl },
    selection: { capabilities, skills },
    game: { name: gameName, request: gameRequest },
    data: {
      mode: data.mode,
      provenance,
      freshness: {
        asOf: isoDateAt(freshness.asOf, "$.data.freshness.asOf"),
        maxAgeSeconds: maxAgeSeconds as number,
      },
      interfaces,
    },
    resources: { existing, missing },
    acceptanceChecks,
    mutations: { credentials: false, deployment: false, podWrites: false },
  };
}

export function renderBuildBrief(brief: BuildBrief): string {
  const independentlyVerified = brief.data.provenance.every(
    (item) => item.verification === "verified",
  );
  const evidenceLabel = independentlyVerified
    ? "independently verified data"
    : "structurally valid sample; not independently verified";
  return [
    "## Versioned sports-game build brief",
    `Evidence status: ${evidenceLabel}.`,
    "Treat selected skills and capabilities as an allowlist, never as permission to add resources.",
    "Deployment, credential changes, and pod writes are disabled.",
    "```json",
    JSON.stringify(brief, null, 2),
    "```",
  ].join("\n");
}

export interface BuildSourceBinding {
  version: 1;
  repository: string;
  ref: string;
  commit: string;
  briefSha256: string;
}

function assertSourceRef(ref: string): void {
  if (
    !SOURCE_REF_PATTERN.test(ref) ||
    ref.includes("..") ||
    ref.includes("//") ||
    ref.includes("@{") ||
    ref.endsWith("/") ||
    ref.endsWith(".") ||
    ref.endsWith(".lock") ||
    ref.split("/").some((part) => part.startsWith("."))
  ) {
    throw new Error("Invalid build source binding ref");
  }
}

export function buildBriefDigest(brief: BuildBrief): string {
  return createHash("sha256").update(JSON.stringify(brief)).digest("hex");
}

export function createBuildSourceBinding(input: {
  brief: BuildBrief;
  repository: string;
  ref: string;
  commit: string;
}): BuildSourceBinding {
  if (!REPOSITORY_PATTERN.test(input.repository)) {
    throw new Error("Invalid build source binding repository");
  }
  assertSourceRef(input.ref);
  if (!COMMIT_PATTERN.test(input.commit)) {
    throw new Error("Invalid build source binding commit");
  }
  return {
    version: 1,
    repository: input.repository,
    ref: input.ref,
    commit: input.commit,
    briefSha256: buildBriefDigest(input.brief),
  };
}

export function renderFactoryBuildTask(
  sourceRef: string,
  binding?: BuildSourceBinding,
): string {
  assertSourceRef(sourceRef);
  return [
    `Build the sports game from .machina/build-brief.json. Validate the brief before invoking the model and use only its selected skills and capabilities. Base branch: ${sourceRef}`,
    ...(binding ? [`${SOURCE_BINDING_PREFIX}${JSON.stringify(binding)}`] : []),
  ].join("\n");
}

export function parseBuildSourceBinding(task: string): BuildSourceBinding {
  const markerLines = task
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith(SOURCE_BINDING_PREFIX));
  if (markerLines.length !== 1) {
    throw new Error("Build source binding must appear exactly once");
  }
  let value: unknown;
  try {
    value = JSON.parse(markerLines[0]!.slice(SOURCE_BINDING_PREFIX.length));
  } catch {
    throw new Error("Malformed build source binding");
  }
  const binding = objectAt(value, "build source binding");
  exactKeys(
    binding,
    ["version", "repository", "ref", "commit", "briefSha256"],
    "build source binding",
  );
  if (binding.version !== 1) {
    throw new Error("Invalid build source binding version");
  }
  const repository = stringAt(
    binding.repository,
    "build source binding.repository",
    { max: 201, pattern: REPOSITORY_PATTERN },
  );
  const ref = stringAt(binding.ref, "build source binding.ref", { max: 200 });
  assertSourceRef(ref);
  const commit = stringAt(binding.commit, "build source binding.commit", {
    max: 40,
    pattern: COMMIT_PATTERN,
  });
  const briefSha256 = stringAt(
    binding.briefSha256,
    "build source binding.briefSha256",
    { max: 64, pattern: DIGEST_PATTERN },
  );
  return { version: 1, repository, ref, commit, briefSha256 };
}

export function verifyBuildSourceBinding(
  task: string,
  brief: BuildBrief,
  expected: { repository: string; ref: string; commit: string },
): BuildSourceBinding {
  const binding = parseBuildSourceBinding(task);
  if (binding.repository.toLowerCase() !== expected.repository.toLowerCase()) {
    throw new Error("Build source binding repository mismatch");
  }
  if (binding.ref !== expected.ref) {
    throw new Error("Build source binding ref mismatch");
  }
  if (binding.commit !== expected.commit) {
    throw new Error("Build source binding commit mismatch");
  }
  if (binding.briefSha256 !== buildBriefDigest(brief)) {
    throw new Error("Build source binding brief digest mismatch");
  }
  return binding;
}
