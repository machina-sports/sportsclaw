import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const root = fileURLToPath(new URL("..", import.meta.url));

function loadPolicy(name) {
  return parse(readFileSync(`${root}/openshell/${name}`, "utf8"));
}

function normalizedRules(endpoint) {
  return (endpoint.rules || [])
    .map((rule) => `${rule.allow?.method || ""} ${rule.allow?.path || ""}`)
    .sort();
}

test("connected TV policy remains the existing external profile", () => {
  const policy = loadPolicy("policy.yaml");
  assert.deepEqual(Object.keys(policy.network_policies).sort(), [
    "espn",
    "kalshi",
    "mcp_server",
    "overlay_feed",
    "polymarket",
    "tail_server",
  ]);

  const serialized = JSON.stringify(policy.network_policies);
  assert.match(serialized, /machina-drops-machina-sports-tv\.org\.machina\.gg/);
  assert.match(serialized, /machina-drops-world-cup-2\.org\.machina\.gg/);
  assert.match(serialized, /api\.elections\.kalshi\.com/);
  assert.match(serialized, /clob\.polymarket\.com/);
  assert.match(serialized, /site\.api\.espn\.com/);
  assert.doesNotMatch(serialized, /"port":(?:5103|8103|8193)/);
});

test("Vault REST and tail permissions are local and path-scoped", () => {
  const policy = loadPolicy("policy.vault.yaml");
  // Exhaustive on purpose: a new egress policy must be a deliberate edit here.
  // `espn` is the read-only site.api.espn.com egress the live cfb skills need;
  // the local-and-path-scoped assertions below cover only the vault_* entries.
  assert.deepEqual(Object.keys(policy.network_policies).sort(), [
    "espn",
    "vault_pod_mcp",
    "vault_runtime_rest",
    "vault_tail_bus",
  ]);

  const expectedHosts = ["172.17.0.1", "host.docker.internal"];
  const cases = [
    ["vault_tail_bus", 8193, ["GET /events", "POST /ingest"]],
    [
      "vault_runtime_rest",
      5103,
      // Listed exhaustively so widening the runtime's write surface stays a
      // deliberate edit. search + wildcard update were added alongside the
      // document-search/update policy change.
      ["POST /document", "POST /document/retrieve", "POST /document/search", "PUT /document/*"],
    ],
  ];

  for (const [name, port, rules] of cases) {
    const endpoints = policy.network_policies[name].endpoints;
    assert.deepEqual(endpoints.map((endpoint) => endpoint.host).sort(), expectedHosts);
    for (const endpoint of endpoints) {
      assert.equal(endpoint.port, port);
      assert.equal(endpoint.protocol, "rest");
      assert.equal(endpoint.enforcement, "enforce");
      assert.equal(endpoint.access, undefined);
      assert.deepEqual(normalizedRules(endpoint), rules);
    }
  }

  // The vault_* surfaces stay loopback-only. `espn` is the one deliberate
  // exception — read-only egress to site.api.espn.com for the live cfb skills,
  // asserted by the sibling sandbox-egress test — so scope this to vault_*
  // rather than dropping the invariant.
  const vaultHosts = Object.entries(policy.network_policies)
    .filter(([name]) => name.startsWith("vault_"))
    .flatMap(([, entry]) => entry.endpoints)
    .map((endpoint) => endpoint.host);
  assert.ok(vaultHosts.length > 0, "expected vault_* network policies to exist");
  assert.ok(vaultHosts.every((host) => expectedHosts.includes(host)));

  // And the only non-vault egress is the read-only ESPN host set — listed
  // exhaustively so adding a host, or making one writable, is a deliberate edit.
  const nonVault = Object.entries(policy.network_policies)
    .filter(([name]) => !name.startsWith("vault_"))
    .flatMap(([, entry]) => entry.endpoints);
  assert.deepEqual(
    [...new Set(nonVault.map((endpoint) => endpoint.host))].sort(),
    ["site.api.espn.com", "site.web.api.espn.com", "sports.core.api.espn.com", "www.espn.com"],
  );
  for (const endpoint of nonVault) {
    assert.equal(endpoint.access, "read-only");
    assert.equal(endpoint.enforcement, "enforce");
    assert.equal(endpoint.port, 443);
  }
});

test("Vault MCP permits only the FastMCP SSE transport routes", () => {
  const policy = loadPolicy("policy.vault.yaml");
  const endpoints = policy.network_policies.vault_pod_mcp.endpoints;
  assert.equal(endpoints.length, 4);

  for (const host of ["172.17.0.1", "host.docker.internal"]) {
    const hostEndpoints = endpoints.filter((endpoint) => endpoint.host === host);
    assert.equal(hostEndpoints.length, 2);

    const sse = hostEndpoints.find((endpoint) => endpoint.path === "/sse");
    const messages = hostEndpoints.find((endpoint) => endpoint.path === "/messages/");
    assert.ok(sse);
    assert.ok(messages);
    assert.equal(sse.port, 8103);
    assert.equal(messages.port, 8103);
    assert.deepEqual(normalizedRules(sse), ["GET /sse"]);
    assert.deepEqual(normalizedRules(messages), ["POST /messages/"]);
    assert.equal(sse.access, undefined);
    assert.equal(messages.access, undefined);
  }
});
