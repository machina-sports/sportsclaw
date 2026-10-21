/**
 * OpenShell 0.1.x native-inference contract.
 *
 * OpenShell removed `inference.local` and the managed route. The workload now
 * calls the provider's native endpoint, reads the credential placeholder the
 * attached provider profile injects, and owns model id, API mode and timeout.
 * These tests pin that contract, plus "OpenShell absent = unchanged direct
 * behavior". Every endpoint is a local mock server; tokens are fixtures.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import http from "node:http";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { generateText } from "ai";

import * as providers from "../dist/llm-providers.js";
import * as cli from "../dist/openshell-cli.js";
import { validateOperatorJobConfig } from "../dist/operator-config.js";
import {
  InferenceRouteError,
  invokeModelRole,
  validateModelRoleRouterConfig,
} from "../dist/inference/model-role-router.js";

const root = fileURLToPath(new URL("..", import.meta.url));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const completion = () => ({
  id: "c1",
  object: "chat.completion",
  created: 1,
  model: "served-model",
  choices: [{ index: 0, message: { role: "assistant", content: "native ok" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
});

/** Local HTTP server capturing every request. `handler` may set status/delay. */
async function withServer(handler, fn) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      let parsed = {};
      try {
        parsed = JSON.parse(body || "{}");
      } catch {
        // leave empty
      }
      requests.push({ method: req.method, url: req.url, headers: req.headers, body: parsed });
      const out = (await handler(req)) ?? {};
      if (out.delayMs) await new Promise((r) => setTimeout(r, out.delayMs));
      if (res.destroyed) return;
      res.statusCode = out.status ?? 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(out.body ?? completion()));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}/v1`, requests);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });
}

const SANDBOX_ENV = { OPENSHELL_SANDBOX: "1" };
const NVIDIA_NATIVE = {
  baseUrl: "https://integrate.api.nvidia.com/v1",
  credentialEnv: "NVIDIA_API_KEY",
};

const baseJob = { jobId: "openshell-job", intervalMs: 60_000, personaText: "op" };

// ---------------------------------------------------------------------------
// resolveOpenShellEndpoint — config + runtime guard → per-job native endpoint
// ---------------------------------------------------------------------------

describe("resolveOpenShellEndpoint", () => {
  const resolve = (...args) => providers.resolveOpenShellEndpoint(...args);

  it("returns undefined when the block is absent or disabled, without any runtime env", () => {
    assert.strictEqual(resolve("openai", undefined, {}), undefined);
    assert.strictEqual(resolve("openai", { enabled: false }, {}), undefined);
    assert.strictEqual(resolve("google", { enabled: false }, {}), undefined);
  });

  it("reads the profile-declared credential env value (never a fixed dummy)", () => {
    const ep = resolve("openai", NVIDIA_NATIVE, {
      ...SANDBOX_ENV,
      NVIDIA_API_KEY: "openshell-placeholder-nv-1",
    });
    assert.strictEqual(ep.baseUrl, "https://integrate.api.nvidia.com/v1");
    assert.strictEqual(ep.apiKey, "openshell-placeholder-nv-1");
    assert.strictEqual(ep.apiMode, "chat", "OpenAI-style default stays chat completions");
  });

  it("accepts the documented workload marker, not a supervisor sandbox name", () => {
    const ep = resolve("openai", NVIDIA_NATIVE, { OPENSHELL_SANDBOX: "1", NVIDIA_API_KEY: "p" });
    assert.strictEqual(ep.apiKey, "p");
    for (const name of ["inference-demo", "sc-op-7", "0", "true"]) {
      assert.throws(() => resolve("openai", NVIDIA_NATIVE, { OPENSHELL_SANDBOX: name, NVIDIA_API_KEY: "p" }), /sandbox/i);
    }
  });

  it("fails closed outside the sandbox runtime without leaking the credential", () => {
    for (const sandbox of [undefined, "", "   "]) {
      const env = { NVIDIA_API_KEY: "placeholder-must-not-leak" };
      if (sandbox !== undefined) env.OPENSHELL_SANDBOX = sandbox;
      assert.throws(
        () => resolve("openai", NVIDIA_NATIVE, env),
        (err) => {
          assert.match(err.message, /sandbox/i);
          assert.ok(!err.message.includes("placeholder-must-not-leak"));
          return true;
        },
        `OPENSHELL_SANDBOX=${JSON.stringify(sandbox)}`,
      );
    }
  });

  it("rejects a missing credential instead of falling back to direct provider keys", () => {
    assert.throws(
      () =>
        resolve("openai", NVIDIA_NATIVE, {
          ...SANDBOX_ENV,
          OPENAI_API_KEY: "real-openai-key-must-not-leak",
          NVIDIA_API_KEY: "  ",
        }),
      (err) => {
        assert.match(err.message, /NVIDIA_API_KEY/);
        assert.ok(!err.message.includes("real-openai-key-must-not-leak"));
        return true;
      },
    );
  });

  it("supports explicit credentialless local NIM mode without reading any provider key", () => {
    const ep = resolve(
      "openai",
      { baseUrl: "http://host.openshell.internal:8000/v1", credentialless: true },
      { ...SANDBOX_ENV, OPENAI_API_KEY: "real-openai-key-must-not-leak" },
    );
    assert.strictEqual(ep.baseUrl, "http://host.openshell.internal:8000/v1");
    assert.ok(typeof ep.apiKey === "string" && ep.apiKey.length > 0);
    assert.notStrictEqual(ep.apiKey, "real-openai-key-must-not-leak");
  });

  it("requires an explicit native endpoint", () => {
    assert.throws(() => resolve("openai", { credentialEnv: "NVIDIA_API_KEY" }, { ...SANDBOX_ENV, NVIDIA_API_KEY: "p" }));
    assert.throws(() => resolve("openai", {}, { ...SANDBOX_ENV }));
  });

  it("rejects the removed inference.local host in every spelling", () => {
    for (const baseUrl of [
      "https://inference.local",
      "https://inference.local/v1",
      "https://INFERENCE.LOCAL/v1",
      "https://Inference.Local./v1",
      "http://inference.local:8080/v1",
    ]) {
      assert.throws(
        () => resolve("openai", { baseUrl, credentialEnv: "NVIDIA_API_KEY" }, { ...SANDBOX_ENV, NVIDIA_API_KEY: "p" }),
        /inference\.local/i,
        baseUrl,
      );
    }
  });

  it("rejects URL userinfo/query/fragment without echoing them", () => {
    assert.throws(
      () =>
        resolve(
          "openai",
          { baseUrl: "https://user:hunter2@integrate.api.nvidia.com/v1?token=qwerty#frag", credentialEnv: "NVIDIA_API_KEY" },
          { ...SANDBOX_ENV, NVIDIA_API_KEY: "p" },
        ),
      (err) => {
        assert.ok(!err.message.includes("hunter2"));
        assert.ok(!err.message.includes("qwerty"));
        return true;
      },
    );
  });

  it("rejects providers OpenShell native mode does not support", () => {
    for (const provider of ["google", "azure-foundry", "openai-compatible"]) {
      assert.throws(
        () => resolve(provider, NVIDIA_NATIVE, { ...SANDBOX_ENV, NVIDIA_API_KEY: "p" }),
        undefined,
        provider,
      );
    }
  });

  it("does not mutate process.env", () => {
    const keys = ["OPENAI_BASE_URL", "ANTHROPIC_BASE_URL", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "NVIDIA_API_KEY"];
    const before = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    resolve("openai", NVIDIA_NATIVE, { ...SANDBOX_ENV, NVIDIA_API_KEY: "p" });
    resolve("anthropic", { baseUrl: "https://api.anthropic.com/v1", credentialEnv: "ANTHROPIC_API_KEY" }, { ...SANDBOX_ENV, ANTHROPIC_API_KEY: "a" });
    assert.deepStrictEqual(Object.fromEntries(keys.map((k) => [k, process.env[k]])), before);
  });
});

// ---------------------------------------------------------------------------
// resolveModel with a native endpoint — wire behavior
// ---------------------------------------------------------------------------

describe("resolveModel (native endpoint wire behavior)", () => {
  it("OpenAI chat mode: exact endpoint, model id and profile credential", async () => {
    await withServer(() => ({}), async (baseUrl, requests) => {
      const model = providers.resolveModel("openai", "nvidia/nemotron-3-super-120b-a12b", {
        baseUrl,
        apiKey: "openshell-placeholder-nv-1",
        apiMode: "chat",
      });
      const res = await generateText({ model, prompt: "hi", maxRetries: 0 });
      assert.strictEqual(res.text, "native ok");
      assert.strictEqual(requests.length, 1);
      assert.strictEqual(requests[0].url, "/v1/chat/completions");
      assert.strictEqual(requests[0].headers.authorization, "Bearer openshell-placeholder-nv-1");
      assert.strictEqual(requests[0].body.model, "nvidia/nemotron-3-super-120b-a12b");
    });
  });

  it("OpenAI responses mode is selectable", async () => {
    await withServer(() => ({}), async (baseUrl, requests) => {
      const model = providers.resolveModel("openai", "nvidia/nemotron-3-super-120b-a12b", {
        baseUrl,
        apiKey: "openshell-placeholder-nv-2",
        apiMode: "responses",
      });
      await generateText({ model, prompt: "hi", maxRetries: 0 }).catch(() => {});
      assert.ok(requests.length >= 1);
      assert.strictEqual(requests[0].url, "/v1/responses");
      assert.strictEqual(requests[0].headers.authorization, "Bearer openshell-placeholder-nv-2");
      assert.strictEqual(requests[0].body.model, "nvidia/nemotron-3-super-120b-a12b");
    });
  });

  it("Anthropic native: uses the profile credential and ignores Claude Code OAuth", async () => {
    const oauth = {
      anthropic: {
        kind: "oauth_claude_code",
        tokens: { accessToken: "oauth-access-must-not-leak", refreshToken: "oauth-refresh", expiresAt: Date.now() + 3_600_000 },
        tokenSource: "file",
      },
    };
    await withServer(() => ({}), async (baseUrl, requests) => {
      const model = providers.resolveModel(
        "anthropic",
        "claude-sonnet-4-6",
        { baseUrl, apiKey: "openshell-placeholder-anthropic" },
        oauth,
      );
      await generateText({ model, prompt: "hi", maxRetries: 0 }).catch(() => {});
      assert.ok(requests.length >= 1);
      assert.strictEqual(requests[0].url, "/v1/messages");
      assert.strictEqual(requests[0].headers["x-api-key"], "openshell-placeholder-anthropic");
      assert.strictEqual(requests[0].body.model, "claude-sonnet-4-6");
      assert.ok(!JSON.stringify(requests).includes("oauth-access-must-not-leak"));
    });
  });

  it("enforces the configured native request timeout", async () => {
    await withServer(() => ({ delayMs: 3_000 }), async (baseUrl) => {
      const model = providers.resolveModel("openai", "served-model", {
        baseUrl,
        apiKey: "p",
        apiMode: "chat",
        timeoutMs: 200,
      });
      const started = Date.now();
      await assert.rejects(() => generateText({ model, prompt: "hi", maxRetries: 0 }));
      assert.ok(Date.now() - started < 2_000, `timed out after ${Date.now() - started}ms`);
    });
  });

  it("never falls back to the direct OPENAI_BASE_URL/OPENAI_API_KEY on native failure", async () => {
    await withServer(() => ({}), async (decoyUrl, decoyRequests) => {
      await withServer(() => ({ status: 500, body: { error: { message: "boom" } } }), async (baseUrl, requests) => {
        await withEnv({ OPENAI_BASE_URL: decoyUrl, OPENAI_API_KEY: "direct-key-must-not-be-used" }, async () => {
          const model = providers.resolveModel("openai", "served-model", { baseUrl, apiKey: "native-p", apiMode: "chat" });
          await assert.rejects(() => generateText({ model, prompt: "hi", maxRetries: 0 }));
        });
        assert.strictEqual(decoyRequests.length, 0, "no unsandboxed fallback");
        assert.ok(requests.length >= 1);
        for (const r of requests) assert.strictEqual(r.headers.authorization, "Bearer native-p");
      });
    });
  });

  it("isolates concurrent jobs: each client keeps its own endpoint and credential", async () => {
    await withServer(() => ({}), async (urlA, reqA) => {
      await withServer(() => ({}), async (urlB, reqB) => {
        const epA = providers.resolveOpenShellEndpoint(
          "openai",
          { baseUrl: urlA, credentialEnv: "JOB_A_KEY" },
          { ...SANDBOX_ENV, JOB_A_KEY: "placeholder-a" },
        );
        const epB = providers.resolveOpenShellEndpoint(
          "openai",
          { baseUrl: urlB, credentialEnv: "JOB_B_KEY" },
          { ...SANDBOX_ENV, JOB_B_KEY: "placeholder-b" },
        );
        await Promise.all([
          generateText({ model: providers.resolveModel("openai", "model-a", epA), prompt: "a", maxRetries: 0 }),
          generateText({ model: providers.resolveModel("openai", "model-b", epB), prompt: "b", maxRetries: 0 }),
        ]);
        assert.deepStrictEqual(reqA.map((r) => [r.headers.authorization, r.body.model]), [["Bearer placeholder-a", "model-a"]]);
        assert.deepStrictEqual(reqB.map((r) => [r.headers.authorization, r.body.model]), [["Bearer placeholder-b", "model-b"]]);
      });
    });
  });

  it("OpenShell absent: direct OpenAI custom-base path is unchanged", async () => {
    await withServer(() => ({}), async (baseUrl, requests) => {
      await withEnv({ OPENAI_BASE_URL: baseUrl, OPENAI_API_KEY: "direct-key", OPENSHELL_SANDBOX: undefined }, async () => {
        const res = await generateText({ model: providers.resolveModel("openai", "gpt-4.1"), prompt: "hi", maxRetries: 0 });
        assert.strictEqual(res.text, "native ok");
      });
      assert.strictEqual(requests[0].url, "/v1/chat/completions");
      assert.strictEqual(requests[0].headers.authorization, "Bearer direct-key");
    });
  });
});

// ---------------------------------------------------------------------------
// Operator job config — openshell block
// ---------------------------------------------------------------------------

describe("validateOperatorJobConfig — native openshell block", () => {
  const v = (openshell, extra = {}) => validateOperatorJobConfig({ ...baseJob, provider: "openai", ...extra, openshell });
  const issue = (r, field) => r.issues.find((i) => i.field === field);

  it("accepts an authenticated native endpoint and keeps every field", () => {
    const r = v({ ...NVIDIA_NATIVE, apiMode: "responses", timeoutMs: 300_000 });
    assert.strictEqual(r.valid, true, JSON.stringify(r.issues));
    assert.strictEqual(r.config.openshell.baseUrl, NVIDIA_NATIVE.baseUrl);
    assert.strictEqual(r.config.openshell.credentialEnv, "NVIDIA_API_KEY");
    assert.strictEqual(r.config.openshell.apiMode, "responses");
    assert.strictEqual(r.config.openshell.timeoutMs, 300_000);
  });

  it("accepts Anthropic with a native endpoint", () => {
    const r = v({ baseUrl: "https://api.anthropic.com/v1", credentialEnv: "ANTHROPIC_API_KEY" }, { provider: "anthropic" });
    assert.strictEqual(r.valid, true, JSON.stringify(r.issues));
  });

  it("accepts explicit credentialless local NIM mode", () => {
    const r = v({ baseUrl: "http://host.openshell.internal:8000/v1", credentialless: true });
    assert.strictEqual(r.valid, true, JSON.stringify(r.issues));
    assert.strictEqual(r.config.openshell.credentialless, true);
  });

  it("keeps a disabled block inert (no endpoint/credential required)", () => {
    assert.strictEqual(v({ enabled: false }).valid, true);
    assert.strictEqual(v({ enabled: false }, { provider: "google" }).valid, true);
  });

  it("requires baseUrl when enabled (no implicit inference.local default)", () => {
    const r = v({ credentialEnv: "NVIDIA_API_KEY" });
    assert.strictEqual(r.valid, false);
    assert.ok(issue(r, "openshell.baseUrl"), JSON.stringify(r.issues));
    assert.strictEqual(v({}).valid, false);
  });

  it("requires exactly one of credentialEnv or credentialless", () => {
    const none = v({ baseUrl: NVIDIA_NATIVE.baseUrl });
    assert.strictEqual(none.valid, false);
    assert.ok(issue(none, "openshell.credentialEnv"), JSON.stringify(none.issues));
    const both = v({ ...NVIDIA_NATIVE, credentialless: true });
    assert.strictEqual(both.valid, false);
  });

  it("rejects malformed credentialEnv / credentialless / apiMode / timeoutMs", () => {
    for (const credentialEnv of ["", "NVIDIA-API-KEY", "1KEY", "A B", 42]) {
      const r = v({ baseUrl: NVIDIA_NATIVE.baseUrl, credentialEnv });
      assert.strictEqual(r.valid, false, `credentialEnv=${JSON.stringify(credentialEnv)}`);
      assert.ok(issue(r, "openshell.credentialEnv"));
    }
    assert.strictEqual(v({ baseUrl: NVIDIA_NATIVE.baseUrl, credentialless: "yes" }).valid, false);
    for (const apiMode of ["auto", "completions", 1]) {
      const r = v({ ...NVIDIA_NATIVE, apiMode });
      assert.strictEqual(r.valid, false, `apiMode=${JSON.stringify(apiMode)}`);
      assert.ok(issue(r, "openshell.apiMode"));
    }
    for (const timeoutMs of [0, -1, 1.5, "300000"]) {
      const r = v({ ...NVIDIA_NATIVE, timeoutMs });
      assert.strictEqual(r.valid, false, `timeoutMs=${JSON.stringify(timeoutMs)}`);
      assert.ok(issue(r, "openshell.timeoutMs"));
    }
  });

  it("rejects an OpenAI apiMode on Anthropic", () => {
    const r = v({ baseUrl: "https://api.anthropic.com/v1", credentialEnv: "ANTHROPIC_API_KEY", apiMode: "chat" }, { provider: "anthropic" });
    assert.strictEqual(r.valid, false);
  });

  it("rejects the removed inference.local host in every spelling", () => {
    for (const baseUrl of ["https://inference.local", "https://INFERENCE.local/v1", "https://inference.local./v1"]) {
      const r = v({ baseUrl, credentialEnv: "NVIDIA_API_KEY" });
      assert.strictEqual(r.valid, false, baseUrl);
      assert.match(issue(r, "openshell.baseUrl")?.message ?? "", /inference\.local/i, baseUrl);
    }
  });

  it("rejects URL credentials/query/fragment without leaking them", () => {
    for (const baseUrl of [
      "https://user:hunter2@integrate.api.nvidia.com/v1",
      "https://integrate.api.nvidia.com/v1?api_key=qwerty",
      "https://integrate.api.nvidia.com/v1#qwerty",
      "http://us er:hunter2@bad host/v1",
    ]) {
      const r = v({ baseUrl, credentialEnv: "NVIDIA_API_KEY" });
      assert.strictEqual(r.valid, false, baseUrl);
      const text = JSON.stringify(r.issues);
      assert.ok(!text.includes("hunter2") && !text.includes("qwerty"), text);
    }
  });

  it("still rejects unsupported providers when enabled", () => {
    for (const provider of ["google", "azure-foundry", "openai-compatible"]) {
      const r = v(NVIDIA_NATIVE, { provider });
      assert.strictEqual(r.valid, false, provider);
    }
  });
});

// ---------------------------------------------------------------------------
// Model-role router — openshell vs nim route
// ---------------------------------------------------------------------------

describe("model-role router — native openshell route", () => {
  const roles = (brain) => ({ roles: { brain } });

  it("validates the new openshell route fields", () => {
    const ok = validateModelRoleRouterConfig(
      roles({ route: "openshell", model: "m", ...NVIDIA_NATIVE, apiMode: "responses", timeoutMs: 1000 }),
    );
    assert.strictEqual(ok.ok, true, ok.error);
    assert.strictEqual(
      validateModelRoleRouterConfig(roles({ route: "openshell", model: "m", baseUrl: "http://host.openshell.internal:8000/v1", credentialless: true })).ok,
      true,
    );
    for (const bad of [
      { route: "openshell", model: "m", credentialEnv: "NVIDIA_API_KEY" }, // no baseUrl
      { route: "openshell", model: "m", baseUrl: NVIDIA_NATIVE.baseUrl }, // no credential choice
      { route: "openshell", model: "m", ...NVIDIA_NATIVE, credentialless: true },
      { route: "openshell", model: "m", baseUrl: NVIDIA_NATIVE.baseUrl, credentialEnv: "BAD-NAME" },
      { route: "openshell", model: "m", ...NVIDIA_NATIVE, apiMode: "auto" },
      { route: "openshell", model: "m", ...NVIDIA_NATIVE, timeoutMs: 0 },
      { route: "openshell", model: "m", baseUrl: "https://Inference.Local./v1", credentialEnv: "NVIDIA_API_KEY" },
    ]) {
      assert.strictEqual(validateModelRoleRouterConfig(roles(bad)).ok, false, JSON.stringify(bad));
    }
  });

  it("does not leak URL credentials in role validation errors", () => {
    const r = validateModelRoleRouterConfig(
      roles({ route: "openshell", model: "m", baseUrl: "https://u:hunter2@h.example/v1?k=qwerty", credentialEnv: "K" }),
    );
    assert.strictEqual(r.ok, false);
    assert.ok(!r.error.includes("hunter2") && !r.error.includes("qwerty"), r.error);
  });

  it("NIM roles stay valid and never require OpenShell fields", () => {
    assert.strictEqual(validateModelRoleRouterConfig(roles({ route: "nim", model: "m" })).ok, true);
    assert.strictEqual(validateModelRoleRouterConfig(roles({ route: "nim", model: "m", baseUrl: "http://nim:8000/v1" })).ok, true);
  });

  it("openshell route fails closed outside the sandbox before any request", async () => {
    await withServer(() => ({}), async (baseUrl, requests) => {
      await withEnv({ OPENSHELL_SANDBOX: undefined, SC_ROLE_KEY: "placeholder-role" }, async () => {
        await assert.rejects(
          () =>
            invokeModelRole({
              role: "brain",
              input: "x",
              source: "benchmark",
              config: roles({ route: "openshell", model: "m", baseUrl, credentialEnv: "SC_ROLE_KEY" }),
            }),
          (err) => {
            assert.ok(err instanceof InferenceRouteError);
            assert.strictEqual(err.trace.route, "openshell");
            assert.ok(!err.message.includes("placeholder-role"));
            return true;
          },
        );
      });
      assert.strictEqual(requests.length, 0);
    });
  });

  it("openshell route rejects a missing credential before any request", async () => {
    await withServer(() => ({}), async (baseUrl, requests) => {
      await withEnv({ ...SANDBOX_ENV, SC_ROLE_KEY: undefined, OPENAI_API_KEY: "real-openai-key-must-not-leak" }, async () => {
        await assert.rejects(
          () =>
            invokeModelRole({
              role: "brain",
              input: "x",
              source: "benchmark",
              config: roles({ route: "openshell", model: "m", baseUrl, credentialEnv: "SC_ROLE_KEY" }),
            }),
          (err) => !err.message.includes("real-openai-key-must-not-leak") && /SC_ROLE_KEY/.test(err.message),
        );
      });
      assert.strictEqual(requests.length, 0);
    });
  });

  it("openshell route sends the profile credential, model and selected API mode", async () => {
    await withServer(() => ({}), async (baseUrl, requests) => {
      await withEnv({ ...SANDBOX_ENV, SC_ROLE_KEY: "placeholder-role" }, async () => {
        const res = await invokeModelRole({
          role: "brain",
          input: "x",
          source: "benchmark",
          config: roles({ route: "openshell", model: "nvidia/nemotron-3-nano-30b-a3b", baseUrl, credentialEnv: "SC_ROLE_KEY" }),
        });
        assert.strictEqual(res.output, "native ok");
      });
      assert.strictEqual(requests[0].url, "/v1/chat/completions");
      assert.strictEqual(requests[0].headers.authorization, "Bearer placeholder-role");
      assert.strictEqual(requests[0].body.model, "nvidia/nemotron-3-nano-30b-a3b");
    });
    await withServer(() => ({}), async (baseUrl, requests) => {
      await withEnv({ ...SANDBOX_ENV, SC_ROLE_KEY: "placeholder-role" }, async () => {
        await invokeModelRole({
          role: "brain",
          input: "x",
          source: "benchmark",
          config: roles({ route: "openshell", model: "m", baseUrl, credentialEnv: "SC_ROLE_KEY", apiMode: "responses" }),
        }).catch(() => {});
      });
      assert.strictEqual(requests[0]?.url, "/v1/responses");
    });
  });

  it("NIM route works outside any OpenShell sandbox", async () => {
    await withServer(() => ({}), async (baseUrl, requests) => {
      await withEnv({ OPENSHELL_SANDBOX: undefined }, async () => {
        const res = await invokeModelRole({
          role: "brain",
          input: "x",
          source: "benchmark",
          config: roles({ route: "nim", model: "m", baseUrl }),
        });
        assert.strictEqual(res.output, "native ok");
      });
      assert.strictEqual(requests[0].url, "/v1/chat/completions");
    });
  });
});

// ---------------------------------------------------------------------------
// Removed 0.0.x mechanics stay removed (source-level guard)
// ---------------------------------------------------------------------------

describe("no managed-route / global-state leftovers", () => {
  const src = (p) => readFileSync(`${root}/src/${p}`, "utf8");

  it("operate.ts routes through the shared resolver without env/DNS hacks", () => {
    const s = src("operate.ts");
    assert.doesNotMatch(s, /process\.env\.(ANTHROPIC|OPENAI)_BASE_URL\s*=(?!=)/);
    assert.doesNotMatch(s, /inference\.local/);
    assert.doesNotMatch(s, /OPENSHELL_SANDBOX\s*===\s*"1"/);
    assert.doesNotMatch(s, /defaultOpenShellBaseUrl/);
    assert.doesNotMatch(s, /node:dns/);
    assert.match(s, /resolveOpenShellEndpoint/);
  });

  it("llm-providers and the role router drop the dummy key and removed host", () => {
    for (const p of ["llm-providers.ts", "inference/model-role-router.ts"]) {
      const s = src(p);
      assert.doesNotMatch(s, /openshell-unused/, p);
      assert.doesNotMatch(s, /inference\.local/, p);
      assert.doesNotMatch(s, /defaultOpenShellBaseUrl/, p);
    }
  });

  it("openshell-cli no longer drives the removed inference commands", () => {
    const s = src("openshell-cli.ts");
    assert.doesNotMatch(s, /"inference",\s*"(get|set)"/);
    assert.doesNotMatch(s, /inference (get|set)/);
  });
});

// ---------------------------------------------------------------------------
// `sportsclaw openshell` doctor/setup helpers
// ---------------------------------------------------------------------------

describe("openshell-cli — 0.1.x doctor/setup", () => {
  const probeResult = (stdout, ok = true) => ({ ok, stdout, stderr: "", exitCode: ok ? 0 : 1, timedOut: false });

  it("parses the CLI version string", () => {
    assert.strictEqual(cli.parseOpenShellVersion("openshell 0.1.5\n"), "0.1.5");
    assert.strictEqual(cli.parseOpenShellVersion("garbage"), undefined);
  });

  it("supports the pinned tested 0.1.x range only", () => {
    assert.strictEqual(cli.isSupportedOpenShellVersion("0.1.5"), true);
    for (const v of ["0.0.47", "0.1.4", "0.2.0", "1.0.0", ""]) {
      assert.strictEqual(cli.isSupportedOpenShellVersion(v), false, v);
    }
  });

  it("explains an incompatible old runtime instead of reporting it ok", () => {
    const old = cli.interpretVersionProbe(probeResult("openshell 0.0.47\n"));
    assert.strictEqual(old.status, "missing");
    assert.match(old.detail, /0\.0\.47/);
    assert.match(old.hint, /0\.1\.5/);
    assert.match(old.hint, /recreate|migrat/i);
    assert.doesNotMatch(old.hint, /inference/);
    assert.strictEqual(cli.interpretVersionProbe(probeResult("openshell 0.1.5\n")).status, "ok");
    assert.strictEqual(cli.interpretVersionProbe(probeResult("", false)).status, "missing");
  });

  it("parses documented `provider list --names` output", () => {
    assert.deepStrictEqual(cli.parseProviderNames("nvidia-native-prod\n\n  ollama  \n"), ["nvidia-native-prod", "ollama"]);
    assert.deepStrictEqual(cli.parseProviderNames(""), []);
  });

  it("setup recipe: lint/import profile, create provider, launch with --provider from an OCI image", () => {
    const recipe = cli.buildSetupRecipe({
      profileFile: "openshell/providers/nvidia-native.yaml",
      profileId: "nvidia-native",
      providerName: "nvidia-native-prod",
      image: "registry.example.com/team/sportsclaw-openshell:0.29.4",
      sandboxName: "sc-op",
      policyFile: "openshell/policy.yaml",
    });
    for (const needle of [
      "openshell profile lint -f 'openshell/providers/nvidia-native.yaml'",
      "openshell profile import -f 'openshell/providers/nvidia-native.yaml'",
      "openshell provider create --name 'nvidia-native-prod' --type 'nvidia-native' --from-existing",
      "openshell sandbox create",
      "--from 'registry.example.com/team/sportsclaw-openshell:0.29.4'",
      "--provider 'nvidia-native-prod'",
      "--policy 'openshell/policy.yaml'",
    ]) {
      assert.ok(recipe.includes(needle), `missing: ${needle}\n${recipe}`);
    }
    assert.doesNotMatch(recipe, /\binference (set|get)\b/);
    assert.doesNotMatch(recipe, /--from\s+\S*Dockerfile/);
    assert.doesNotMatch(recipe, /inference\.local|openshell-unused/);
  });

  it("setup recipe for a credentialless profile skips --from-existing", () => {
    const recipe = cli.buildSetupRecipe({
      profileFile: "openshell/providers/nim-local.yaml",
      profileId: "sportsclaw-nim-local",
      providerName: "nim-local",
      image: "registry.example.com/team/sportsclaw-openshell:0.29.4",
      sandboxName: "sc-op",
      policyFile: "openshell/policy.yaml",
      credentialless: true,
    });
    assert.ok(recipe.includes("openshell provider create --name 'nim-local' --type 'sportsclaw-nim-local'"));
    assert.doesNotMatch(recipe, /--from-existing/);
    assert.ok(recipe.includes("--provider 'nim-local'"));
  });

  it("all-ok doctor banner launches with an explicit provider attachment", () => {
    const out = cli.formatReport({ results: [{ id: "a", label: "A", status: "ok" }], allOk: true });
    assert.match(out, /--provider/);
    assert.doesNotMatch(out, /inference (set|get)/);
  });

  it("scaffolded job carries an explicit native endpoint and passes validation", () => {
    const raw = cli.buildScaffoldConfig({
      jobId: "scaffold-native",
      personaText: "You are SportsClaw.",
      provider: "openai",
      model: "nvidia/nemotron-3-super-120b-a12b",
      intervalMs: 60_000,
      baseUrl: NVIDIA_NATIVE.baseUrl,
      credentialEnv: "NVIDIA_API_KEY",
    });
    const r = validateOperatorJobConfig(JSON.parse(raw));
    assert.strictEqual(r.valid, true, JSON.stringify(r.issues));
    assert.strictEqual(r.config.openshell.baseUrl, NVIDIA_NATIVE.baseUrl);
    assert.strictEqual(r.config.openshell.credentialEnv, "NVIDIA_API_KEY");
  });
});
