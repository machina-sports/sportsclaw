import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  bootstrapDefaultAgents,
  createAgent,
  inactivateAgent,
  listAgents,
  loadAgent,
  loadAgents,
  updateAgent,
} from "../dist/agents.js";

let dir;
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("native agent CRUD", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sc-agents-"));
    process.env.SPORTSCLAW_AGENTS_DIR = dir;
  });

  afterEach(() => {
    delete process.env.SPORTSCLAW_AGENTS_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates, updates, lists, and inactivates without destructive deletion", () => {
    const created = createAgent({
      id: "match-reader",
      name: "Match Reader",
      title: "Football Briefing Specialist",
      skills: ["football", "news"],
      tags: ["briefing"],
      body: "## Directives\n\nRead the match.",
    });
    assert.equal(created.active, true);
    assert.equal(created.builtin, false);
    assert.equal(created.title, "Football Briefing Specialist");
    assert.match(readFileSync(join(dir, "match-reader.md"), "utf8"), /^title: Football Briefing Specialist$/m);
    assert.deepEqual(loadAgents().map((agent) => agent.id), ["match-reader"]);

    const updated = updateAgent("match-reader", {
      name: "Match Reader Pro",
      title: "Senior Match Analyst",
      skills: ["football"],
      body: "## Directives\n\nRead the match carefully.",
    });
    assert.equal(updated.name, "Match Reader Pro");
    assert.equal(updated.title, "Senior Match Analyst");
    assert.deepEqual(updated.skills, ["football"]);

    const inactive = inactivateAgent("match-reader");
    assert.equal(inactive.active, false);
    assert.deepEqual(loadAgents(), []);
    assert.equal(loadAgent("match-reader")?.active, false);
    assert.equal(listAgents({ includeInactive: true })[0].id, "match-reader");
    assert.deepEqual(readdirSync(dir), ["match-reader.md"]);
  });

  it("uses atomic writes and leaves no temporary files", () => {
    createAgent({ id: "atomic-agent", name: "Atomic Agent", body: "Initial body" });
    updateAgent("atomic-agent", { body: "Updated body" });
    assert.deepEqual(readdirSync(dir), ["atomic-agent.md"]);
  });

  it("defaults legacy agent titles to an empty string", () => {
    writeFileSync(join(dir, "legacy-agent.md"), [
      "---",
      "name: Legacy Agent",
      "skills: []",
      "---",
      "Legacy directives",
      "",
    ].join("\n"));

    assert.equal(loadAgent("legacy-agent")?.title, "");
  });

  it("rejects traversal and malformed fields", () => {
    const valid = { name: "Safe Agent", body: "Safe body" };
    for (const id of ["../escape", "a/b", "a\\b", ".", "UPPER", "two words", ""] ) {
      assert.throws(() => createAgent({ id, ...valid }), /agent id/i, id);
      assert.throws(() => loadAgent(id), /agent id/i, id);
    }
    assert.throws(
      () => createAgent({ id: "bad-name", name: " Bad ", body: "body" }),
      /name/i,
    );
    for (const title of [`${"a".repeat(121)}`, " Bad title ", "bad\u007ftitle", "bad\ntitle"]) {
      assert.throws(
        () => createAgent({ id: `bad-title-${title.length}`, name: "Bad Title", title, body: "body" }),
        /title/i,
      );
    }
    assert.throws(
      () => createAgent({ id: "bad-skills", name: "Bad Skills", body: "body", skills: ["NBA"] }),
      /skills/i,
    );
    assert.throws(
      () => createAgent({ id: "bad-tags", name: "Bad Tags", body: "body", tags: ["a", "a"] }),
      /tags/i,
    );
    assert.throws(
      () => createAgent({ id: "bad-body", name: "Bad Body", body: "" }),
      /body/i,
    );
  });

  it("rejects symlink-backed agent files", () => {
    const outside = join(dir, "..", `outside-${process.pid}.md`);
    writeFileSync(outside, "outside", "utf8");
    symlinkSync(outside, join(dir, "linked-agent.md"));
    try {
      assert.throws(() => loadAgent("linked-agent"), /regular file/i);
      assert.throws(() => updateAgent("linked-agent", { body: "changed" }), /regular file/i);
      assert.equal(readFileSync(outside, "utf8"), "outside");
    } finally {
      rmSync(outside, { force: true });
    }
  });

  it("preserves built-in agents", () => {
    assert.equal(bootstrapDefaultAgents(), 3);
    const builtins = listAgents({ includeInactive: true });
    assert.deepEqual(builtins.map((agent) => agent.id), ["analyst", "newsdesk", "scoreboard"]);
    assert.ok(builtins.every((agent) => agent.builtin && agent.active));
    assert.throws(() => createAgent({ id: "analyst", name: "Other", body: "body" }), /built-in|exists/i);
    assert.throws(() => updateAgent("analyst", { body: "replacement" }), /built-in/i);
    assert.throws(() => inactivateAgent("analyst"), /built-in/i);
  });

  it("exposes the same lifecycle through the JSON CLI", () => {
    const run = (args, input) => {
      const result = spawnSync(
        process.execPath,
        [join(repoRoot, "dist", "index.js"), "agents", ...args, "--json"],
        {
          cwd: repoRoot,
          encoding: "utf8",
          input: input ? JSON.stringify(input) : undefined,
          env: { ...process.env, SPORTSCLAW_AGENTS_DIR: dir },
        },
      );
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout).data;
    };

    const created = run(["create"], {
      id: "relay-agent",
      name: "Relay Agent",
      title: "NBA Relay Specialist",
      body: "Relay directives",
      skills: ["nba"],
    });
    assert.equal(created.id, "relay-agent");
    assert.equal(created.title, "NBA Relay Specialist");
    assert.equal(run(["get", "relay-agent"]).name, "Relay Agent");
    const updated = run(["update", "relay-agent"], {
      title: "",
      tags: ["briefing"],
    });
    assert.equal(updated.title, "");
    assert.equal(updated.tags[0], "briefing");
    assert.equal(run(["inactivate", "relay-agent"]).active, false);
    assert.ok(run(["list", "--all"]).some((agent) => agent.id === "relay-agent"));
  });
});
