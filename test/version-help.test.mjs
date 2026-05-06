import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = require("../package.json");

describe("CLI --help version", () => {
  it("should print the version from package.json", () => {
    const output = execFileSync("node", ["dist/index.js", "--help"], {
      encoding: "utf-8",
    });
    assert.ok(
      output.includes(`v${pkg.version}`),
      `Expected help output to contain "v${pkg.version}" but got:\n${output.split("\n")[0]}`
    );
  });
});
