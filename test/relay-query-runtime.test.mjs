import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("relay query admission, auth, capability and subprocess lifecycle contracts", () => {
  const result = spawnSync(process.env.PYTHON_PATH || "python3", [
    fileURLToPath(new URL("./relay-query-runtime.py", import.meta.url)),
  ], { encoding: "utf8", timeout: 20000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
