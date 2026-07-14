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
  assert.deepEqual(Object.keys(policy.network_policies).sort(), [
    "vault_pod_mcp",
    "vault_runtime_rest",
    "vault_tail_bus",
  ]);

  const expectedHosts = ["172.17.0.1", "host.docker.internal"];
  const cases = [
    ["vault_tail_bus", 8193, ["GET /events", "POST /ingest"]],
    ["vault_runtime_rest", 5103, ["POST /document", "POST /document/retrieve"]],
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

  const allHosts = Object.values(policy.network_policies)
    .flatMap((entry) => entry.endpoints)
    .map((endpoint) => endpoint.host);
  assert.ok(allHosts.every((host) => expectedHosts.includes(host)));
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
