/**
 * Media role proxy — loopback, token-gated, role-allowlisted.
 */

import assert from "node:assert/strict";
import http from "node:http";
import { describe, it, after } from "node:test";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const { startRoleProxy } = await import(join(repoRoot, "dist/media/role-proxy.js"));

const inference = {
  roles: {
    brain: { route: "mock", model: "mock-brain" },
    writer: { route: "mock", model: "mock-writer" },
    eyes: { route: "api", model: "m", baseUrl: "http://127.0.0.1:9", credentialEnv: "ROLE_PROXY_TEST_KEY" },
  },
};

/** Raw request, so tests control Host and can stream a body of any size. */
function request(url, { path, method = "POST", headers = {}, body }) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, path, method, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (typeof body === "function") body(req);
    else req.end(body);
  });
}

const json = (token, extra = {}) => ({ "content-type": "application/json", authorization: `Bearer ${token}`, ...extra });

describe("role proxy", () => {
  it("serves an allowed role over the mock route and emits one receipt", async () => {
    const receipts = [];
    const proxy = await startRoleProxy({ inference, allowRoles: ["brain"], onReceipt: (r) => receipts.push(r) });
    try {
      assert.match(proxy.url, /^http:\/\/127\.0\.0\.1:\d+$/);
      assert.match(proxy.token, /^[0-9a-f]{64}$/);
      const res = await request(proxy.url, { path: "/role/brain", headers: json(proxy.token), body: JSON.stringify({ input: "hi" }) });
      assert.equal(res.status, 200);
      assert.deepEqual(JSON.parse(res.text), { output: { mock: true, role: "brain", model: "mock-brain", echo: "hi" } });
      assert.equal(receipts.length, 1);
      assert.equal(receipts[0].purpose, "model_role");
      assert.equal(receipts[0].route, "mock");
      assert.equal(receipts[0].status, "completed");
    } finally {
      await proxy.close();
    }
  });

  it("answers 401 for a missing, wrong or wrong-length token", async () => {
    const proxy = await startRoleProxy({ inference, allowRoles: ["brain"] });
    try {
      const body = JSON.stringify({ input: "hi" });
      const none = await request(proxy.url, { path: "/role/brain", headers: { "content-type": "application/json" }, body });
      const wrong = await request(proxy.url, { path: "/role/brain", headers: json("0".repeat(64)), body });
      const short = await request(proxy.url, { path: "/role/brain", headers: json("abc"), body });
      assert.deepEqual([none.status, wrong.status, short.status], [401, 401, 401]);
    } finally {
      await proxy.close();
    }
  });

  it("revokeToken makes that token 401; the base token, another added token and unknown tokens are unaffected", async () => {
    const proxy = await startRoleProxy({ inference, allowRoles: ["brain"] });
    try {
      const a = proxy.addToken();
      const b = proxy.addToken();
      const ask = (token) => request(proxy.url, { path: "/role/brain", headers: json(token), body: JSON.stringify({ input: "hi" }) });
      assert.equal((await ask(a)).status, 200);
      proxy.revokeToken(a);
      proxy.revokeToken("not-a-token");
      assert.deepEqual([(await ask(a)).status, (await ask(b)).status, (await ask(proxy.token)).status], [401, 200, 200]);
    } finally {
      await proxy.close();
    }
  });

  it("answers 403 for a role outside allowRoles, before touching the route", async () => {
    const proxy = await startRoleProxy({ inference, allowRoles: ["brain"] });
    try {
      const res = await request(proxy.url, { path: "/role/writer", headers: json(proxy.token), body: JSON.stringify({ input: "x" }) });
      assert.equal(res.status, 403);
      const unknown = await request(proxy.url, { path: "/role/ears", headers: json(proxy.token), body: JSON.stringify({ input: "x" }) });
      assert.equal(unknown.status, 403);
    } finally {
      await proxy.close();
    }
  });

  it("answers 403 for a non-loopback Host, ahead of the token check", async () => {
    const proxy = await startRoleProxy({ inference, allowRoles: ["brain"] });
    try {
      const body = JSON.stringify({ input: "x" });
      const evil = await request(proxy.url, { path: "/role/brain", headers: json(proxy.token, { host: "evil.example:80" }), body });
      assert.equal(evil.status, 403);
      const evilNoToken = await request(proxy.url, { path: "/role/brain", headers: { host: "evil.example" }, body });
      assert.equal(evilNoToken.status, 403);
      const port = new URL(proxy.url).port;
      const local = await request(proxy.url, { path: "/role/brain", headers: json(proxy.token, { host: `localhost:${port}` }), body });
      assert.equal(local.status, 200);
    } finally {
      await proxy.close();
    }
  });

  it("answers 413 once a body passes 64 MB, without buffering it all", async () => {
    const proxy = await startRoleProxy({ inference, allowRoles: ["brain"] });
    try {
      const chunk = Buffer.alloc(1024 * 1024, 0x61);
      const res = await request(proxy.url, {
        path: "/role/brain",
        headers: json(proxy.token),
        body: (req) => {
          let sent = 0;
          const pump = () => {
            while (sent < 80) {
              sent++;
              if (!req.write(chunk)) return void req.once("drain", pump);
            }
            req.end();
          };
          req.on("error", () => {});
          pump();
        },
      }).catch((e) => ({ status: e.code }));
      assert.equal(res.status, 413);
    } finally {
      await proxy.close();
    }
  });

  it("answers 400 for a malformed or non-object JSON body, and 404/405 for other routes", async () => {
    const proxy = await startRoleProxy({ inference, allowRoles: ["brain"] });
    try {
      const bad = await request(proxy.url, { path: "/role/brain", headers: json(proxy.token), body: "{nope" });
      const arr = await request(proxy.url, { path: "/role/brain", headers: json(proxy.token), body: "[]" });
      const noInput = await request(proxy.url, { path: "/role/brain", headers: json(proxy.token), body: "{}" });
      assert.deepEqual([bad.status, arr.status, noInput.status], [400, 400, 400]);
      const get = await request(proxy.url, { path: "/role/brain", method: "GET", headers: json(proxy.token) });
      assert.equal(get.status, 405);
      const other = await request(proxy.url, { path: "/other", headers: json(proxy.token), body: "{}" });
      assert.equal(other.status, 404);
    } finally {
      await proxy.close();
    }
  });

  it("answers 502 with only the message when the model fails, never the key", async () => {
    const SECRET = "sk-super-secret-value-123456";
    process.env.ROLE_PROXY_TEST_KEY = SECRET;
    const proxy = await startRoleProxy({ inference, allowRoles: ["eyes"] });
    try {
      const res = await request(proxy.url, { path: "/role/eyes", headers: json(proxy.token), body: JSON.stringify({ input: "x" }) });
      assert.equal(res.status, 502);
      const parsed = JSON.parse(res.text);
      assert.deepEqual(Object.keys(parsed), ["error"]);
      assert.equal(typeof parsed.error, "string");
      assert.ok(!res.text.includes(SECRET));
      assert.ok(!/\n\s+at /.test(res.text));
    } finally {
      delete process.env.ROLE_PROXY_TEST_KEY;
      await proxy.close();
    }
  });

  it("a failed model call answers 502 with a generic message and the router's error code, and logs nothing", async () => {
    process.env.ROLE_PROXY_TEST_KEY = "sk-another-secret-987654";
    const proxy = await startRoleProxy({ inference, allowRoles: ["eyes"] });
    const logged = [];
    const saved = {};
    for (const m of ["log", "info", "warn", "error", "debug"]) {
      saved[m] = console[m];
      console[m] = (...args) => logged.push(args);
    }
    try {
      const res = await request(proxy.url, { path: "/role/eyes", headers: json(proxy.token), body: JSON.stringify({ input: "x" }) });
      assert.equal(res.status, 502);
      assert.match(JSON.parse(res.text).error, /^model call failed: [a-z_]+$/);
    } finally {
      Object.assign(console, saved);
      delete process.env.ROLE_PROXY_TEST_KEY;
      await proxy.close();
    }
    assert.deepEqual(logged, []);
  });

  it("close() refuses new connections, is idempotent, and drops open ones", async () => {
    const proxy = await startRoleProxy({ inference, allowRoles: ["brain"] });
    const port = new URL(proxy.url).port;
    const open = await new Promise((resolve) => {
      const req = http.request({ host: "127.0.0.1", port, path: "/role/brain", method: "POST", headers: json(proxy.token) });
      req.on("error", () => resolve("dropped"));
      req.write("{");
      setTimeout(() => proxy.close().then(() => proxy.close()), 50);
    });
    assert.equal(open, "dropped");
    await assert.rejects(request(proxy.url, { path: "/role/brain", headers: json(proxy.token), body: "{}" }), (e) => e.code === "ECONNREFUSED");
  });
});
