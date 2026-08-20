import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const forbidden = [
  /app\.clickup\.com/i,
  /github\.com\/machina-sports\/(?:machina-client-api|adidas-templates)(?:\/|\b)/i,
  /(?:^|[\s"'`])\/Users\/bender(?:\/|\b)/im,
  /chief-of-staff/i,
  /Company Brain/i,
];

test("tracked public files do not expose restricted links or local paths", () => {
  const files = execFileSync("git", ["ls-files", "-z"], { encoding: "buffer" })
    .toString("utf8").split("\0").filter(Boolean);
  const violations = [];
  for (const file of files) {
    if (file === "test/public-surface-sanitization.test.mjs") continue;
    let text;
    try { text = readFileSync(file, "utf8"); } catch { continue; }
    for (const pattern of forbidden) {
      if (pattern.test(text)) violations.push(`${file}: ${pattern}`);
    }
  }
  assert.deepEqual(violations, []);
});
