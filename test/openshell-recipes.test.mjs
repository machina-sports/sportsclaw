/**
 * OpenShell 0.1.x deployment recipes: provider profiles, the private/connected
 * Vault policy split, policy invariants, and npm packaging. No build needed.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (rel) => readFileSync(`${root}/${rel}`, "utf8");
const load = (rel) => parse(read(rel));

const NODE_BIN = "/usr/local/bin/node";
const LOCAL_HOSTS = ["172.17.0.1", "host.docker.internal"];
const POLICY_FILES = ["policy.yaml", "policy.vault.yaml", "policy.vault-espn.yaml"];

function profileFiles() {
  const dir = `${root}/openshell/providers`;
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".yaml")) : [];
}

// ---------------------------------------------------------------------------
// Provider profiles
// ---------------------------------------------------------------------------

test("public authenticated profile: NVIDIA native endpoint, profile credential, Node caller", () => {
  const p = load("openshell/providers/nvidia-native.yaml");
  assert.strictEqual(p.id, "nvidia-native");
  assert.strictEqual(p.category, "inference");
  assert.strictEqual(p.inference_capable, true);
  const cred = p.credentials.find((c) => (c.env_vars ?? []).includes("NVIDIA_API_KEY"));
  assert.ok(cred, "declares NVIDIA_API_KEY");
  assert.ok(p.discovery?.credentials?.includes(cred.name), "--from-existing can discover it");
  assert.ok(p.endpoints.some((e) => e.host === "integrate.api.nvidia.com" && e.port === 443));
  assert.ok(p.binaries.includes(NODE_BIN));
});

test("custom local NIM profile: credentialless, endpoint-bearing, gateway-host reachable", () => {
  const p = load("openshell/providers/nim-local.yaml");
  assert.deepStrictEqual(p.credentials, []);
  assert.strictEqual(p.inference_capable, true);
  assert.ok(p.endpoints.length > 0);
  for (const e of p.endpoints) {
    assert.ok(e.host && Number.isInteger(e.port), JSON.stringify(e));
    assert.ok(!["localhost", "127.0.0.1", "inference.local"].includes(e.host.toLowerCase()), e.host);
  }
  assert.ok(p.binaries.includes(NODE_BIN));
});

test("every shipped profile uses its own id and carries no secret material", () => {
  const files = profileFiles();
  assert.ok(files.length >= 2, "expected nvidia-native.yaml and nim-local.yaml");
  for (const f of files) {
    const raw = read(`openshell/providers/${f}`);
    const p = parse(raw);
    assert.ok(!["nvidia", "openai", "anthropic"].includes(p.id), `${f}: reuse of vendor example id`);
    assert.doesNotMatch(raw, /inference\.local/i, f);
    assert.doesNotMatch(raw, /nvapi-|sk-[A-Za-z0-9]{8}|Bearer\s+\S/, f);
    for (const c of p.credentials ?? []) {
      assert.strictEqual(c.value, undefined, `${f}: credential value present`);
    }
    assert.ok(Array.isArray(p.binaries) && p.binaries.includes(NODE_BIN), `${f}: Node binary`);
  }
});

// ---------------------------------------------------------------------------
// Vault: genuinely private profile + explicitly connected ESPN variant
// ---------------------------------------------------------------------------

test("private Vault policy is local-only (no public egress)", () => {
  const policy = load("openshell/policy.vault.yaml");
  const names = Object.keys(policy.network_policies);
  assert.ok(names.length > 0);
  assert.ok(names.every((n) => n.startsWith("vault_")), names.join(","));
  const hosts = Object.values(policy.network_policies).flatMap((e) => e.endpoints.map((x) => x.host));
  assert.ok(hosts.every((h) => LOCAL_HOSTS.includes(h)), hosts.join(","));
});

test("connected Vault variant = private Vault entries + read-only ESPN, nothing else", () => {
  const priv = load("openshell/policy.vault.yaml");
  const conn = load("openshell/policy.vault-espn.yaml");
  assert.deepStrictEqual(
    Object.keys(conn.network_policies).sort(),
    [...Object.keys(priv.network_policies), "espn"].sort(),
  );
  for (const name of Object.keys(priv.network_policies)) {
    assert.deepStrictEqual(conn.network_policies[name], priv.network_policies[name], name);
  }
  const espn = conn.network_policies.espn.endpoints;
  assert.deepStrictEqual(
    [...new Set(espn.map((e) => e.host))].sort(),
    ["site.api.espn.com", "site.web.api.espn.com", "sports.core.api.espn.com", "www.espn.com"],
  );
  for (const e of espn) {
    assert.strictEqual(e.access, "read-only");
    assert.strictEqual(e.enforcement, "enforce");
    assert.strictEqual(e.port, 443);
  }
});

// ---------------------------------------------------------------------------
// Policy invariants that 0.1.x keeps
// ---------------------------------------------------------------------------

test("sandbox policies stay version 1 with a valid non-root process identity", () => {
  for (const f of POLICY_FILES) {
    const p = load(`openshell/${f}`);
    assert.strictEqual(p.version, 1, f);
    for (const key of ["run_as_user", "run_as_group"]) {
      const id = p.process?.[key];
      const ok = id === "sandbox" || (Number.isInteger(id) && id > 0);
      assert.ok(ok, `${f}: process.${key}=${JSON.stringify(id)}`);
    }
    assert.doesNotMatch(read(`openshell/${f}`), /inference\.local/i, `${f}: stale managed-route reference`);
  }
});

test("sandbox image runs as the non-root sandbox user with HOME=/sandbox", () => {
  const df = read("openshell/Dockerfile");
  assert.match(df, /^USER sandbox$/m);
  assert.match(df, /^ENV HOME=\/sandbox$/m, "operator configs are uploaded to /sandbox/.sportsclaw/operator");
  assert.doesNotMatch(df, /--from\s+\S*Dockerfile/);
});

// ---------------------------------------------------------------------------
// npm packaging
// ---------------------------------------------------------------------------

test("npm package ships the openshell recipes without depending on OpenShell", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.ok(pkg.files.includes("openshell") || pkg.files.some((f) => f.startsWith("openshell/")), pkg.files.join(","));
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    for (const name of Object.keys(pkg[field] ?? {})) {
      assert.doesNotMatch(name, /openshell/i, `${field}.${name}`);
    }
  }
});
