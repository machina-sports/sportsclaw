// Skill guide discovery: legacy skill.yml + SKILL.md pairs keep working, and a
// portable SKILL.md with YAML frontmatter (name + description) loads on its
// own. Discovery is bounded, deterministic, and never leaves the configured
// root through symlinks.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { loadSkillGuides } from "../dist/skill-guides.js";

let work;
let root;
let savedDir;

function write(path, content) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

function portable(dir, frontmatter, body = "# Body\n\nDo the thing.\n") {
  write(join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n${body}`);
}

function ids() {
  return loadSkillGuides().map((g) => g.id);
}

beforeEach(() => {
  savedDir = process.env.SPORTSCLAW_SKILL_GUIDES_DIR;
  work = mkdtempSync(join(tmpdir(), "skill-guides-"));
  root = join(work, "root");
  mkdirSync(root);
  process.env.SPORTSCLAW_SKILL_GUIDES_DIR = root;
});

afterEach(() => {
  if (savedDir === undefined) delete process.env.SPORTSCLAW_SKILL_GUIDES_DIR;
  else process.env.SPORTSCLAW_SKILL_GUIDES_DIR = savedDir;
  rmSync(work, { recursive: true, force: true });
});

describe("loadSkillGuides — defaults", () => {
  it("returns [] when the env var is unset", () => {
    delete process.env.SPORTSCLAW_SKILL_GUIDES_DIR;
    assert.deepEqual(loadSkillGuides(), []);
  });

  it("returns [] when the configured directory does not exist", () => {
    process.env.SPORTSCLAW_SKILL_GUIDES_DIR = join(work, "missing");
    assert.deepEqual(loadSkillGuides(), []);
  });
});

describe("loadSkillGuides — portable SKILL.md", () => {
  it("loads a SKILL.md with YAML frontmatter and no skill.yml", () => {
    portable(
      join(root, "alpha"),
      [
        "name: alpha-skill",
        "description: |",
        "  Line one.",
        "  Line two.",
        "license: MIT",
        "compatibility: python3",
        "metadata:",
        "  author: test",
        "  tags: [a, b]",
      ].join("\n"),
      "# Alpha\n\nStep 1.\n",
    );
    const guides = loadSkillGuides();
    assert.equal(guides.length, 1);
    const [g] = guides;
    assert.equal(g.id, "alpha", "directory name is the invocation id");
    assert.equal(g.name, "alpha-skill");
    assert.equal(g.description.trim(), "Line one.\nLine two.", "multiline YAML is parsed correctly");
    assert.equal(g.body, "# Alpha\n\nStep 1.", "body excludes the YAML frontmatter");
    assert.equal(g.dir, realpathSync(join(root, "alpha")), "source directory is recorded");
  });

  it("parses folded and quoted multiline descriptions", () => {
    portable(join(root, "folded"), 'name: "folded: skill"\ndescription: >\n  Use when\n  scores matter.');
    const [g] = loadSkillGuides();
    assert.equal(g.name, "folded: skill");
    assert.equal(g.description.trim(), "Use when scores matter.");
  });

  it("finds nested portable skills", () => {
    portable(join(root, "group", "beta"), "name: beta\ndescription: Beta skill.");
    assert.deepEqual(ids(), ["beta"]);
  });

  it("skips SKILL.md without frontmatter when there is no skill.yml", () => {
    write(join(root, "plain", "SKILL.md"), "# Just markdown\n");
    portable(join(root, "ok"), "name: ok\ndescription: fine");
    assert.deepEqual(ids(), ["ok"]);
  });

  it("fails closed on malformed YAML frontmatter without hiding other guides", () => {
    portable(join(root, "broken"), "name: [unclosed\ndescription: x");
    portable(join(root, "ok"), "name: ok\ndescription: fine");
    assert.deepEqual(ids(), ["ok"]);
  });

  it("skips unresolved YAML aliases without crashing discovery", () => {
    portable(join(root, "broken"), "name: *undefined\ndescription: alias probe");
    portable(join(root, "ok"), "name: ok\ndescription: fine");
    assert.deepEqual(ids(), ["ok"]);
  });

  it("skips excessive YAML aliases without crashing discovery", () => {
    const aliases = Array(101).fill("*anchor").join(", ");
    portable(join(root, "broken"), `name: broken\ndescription: fine\nanchor: &anchor [1, 2]\nmetadata: [${aliases}]`);
    portable(join(root, "ok"), "name: ok\ndescription: fine");
    assert.deepEqual(ids(), ["ok"]);
  });

  it("fails closed on unterminated frontmatter", () => {
    write(join(root, "open", "SKILL.md"), "---\nname: open\ndescription: never closed\n# Body\n");
    assert.deepEqual(ids(), []);
  });

  it("requires string name and description", () => {
    portable(join(root, "no-desc"), "name: no-desc");
    portable(join(root, "no-name"), "description: nameless");
    portable(join(root, "numeric"), "name: 42\ndescription: numeric name");
    portable(join(root, "list"), "- name\n- description");
    portable(join(root, "ok"), "name: ok\ndescription: fine");
    assert.deepEqual(ids(), ["ok"]);
  });

  it("loads guides in deterministic id order", () => {
    for (const id of ["zeta", "alpha", "mid"]) portable(join(root, id), `name: ${id}\ndescription: ${id}`);
    assert.deepEqual(ids(), ["alpha", "mid", "zeta"]);
  });

  it("keeps guides that share a display name but have distinct ids", () => {
    portable(join(root, "one"), "name: same\ndescription: first");
    portable(join(root, "two"), "name: same\ndescription: second");
    assert.deepEqual(ids(), ["one", "two"]);
  });

  it("drops every guide whose directory id is duplicated (ambiguous invocation)", () => {
    portable(join(root, "a", "dup"), "name: dup-a\ndescription: a");
    portable(join(root, "b", "dup"), "name: dup-b\ndescription: b");
    portable(join(root, "unique"), "name: unique\ndescription: u");
    assert.deepEqual(ids(), ["unique"]);
  });

  it("skips an oversized SKILL.md", () => {
    portable(join(root, "huge"), "name: huge\ndescription: big", "x".repeat(2 * 1024 * 1024));
    portable(join(root, "ok"), "name: ok\ndescription: fine");
    assert.deepEqual(ids(), ["ok"]);
  });

  it("ignores guides nested beyond the recursion bound", () => {
    const deep = join(root, ...Array.from({ length: 30 }, (_, i) => `d${i}`), "deep");
    portable(deep, "name: deep\ndescription: too deep");
    portable(join(root, "shallow"), "name: shallow\ndescription: ok");
    assert.deepEqual(ids(), ["shallow"]);
  });
});

describe("loadSkillGuides — symlinks", () => {
  it("does not follow a symlinked directory out of the root", () => {
    const outside = join(work, "outside", "escaped");
    portable(outside, "name: escaped\ndescription: outside root");
    symlinkSync(outside, join(root, "escaped"), "dir");
    portable(join(root, "real"), "name: real\ndescription: inside");
    assert.deepEqual(ids(), ["real"]);
  });

  it("does not load a SKILL.md that is a symlink to a file outside the root", () => {
    const outsideFile = join(work, "outside.md");
    writeFileSync(outsideFile, "---\nname: linked\ndescription: outside\n---\n# Secret\n");
    mkdirSync(join(root, "linked"));
    symlinkSync(outsideFile, join(root, "linked", "SKILL.md"), "file");
    assert.deepEqual(ids(), []);
  });

  it("terminates on a symlink loop and loads each guide once", () => {
    portable(join(root, "real"), "name: real\ndescription: inside");
    symlinkSync(root, join(root, "loop"), "dir");
    symlinkSync(join(root, "real"), join(root, "real", "self"), "dir");
    assert.deepEqual(ids(), ["real"]);
  });
});

describe("loadSkillGuides — legacy skill.yml", () => {
  it("keeps skill.yml metadata and the full SKILL.md body", () => {
    write(join(root, "legacy", "skill.yml"), "name: Legacy Guide\ndescription: Old style\ncategory: ops\n");
    write(join(root, "legacy", "SKILL.md"), "\n# Legacy\n\nSteps.\n");
    const [g] = loadSkillGuides();
    assert.equal(g.id, "legacy");
    assert.equal(g.name, "Legacy Guide");
    assert.equal(g.description, "Old style");
    assert.equal(g.body, "# Legacy\n\nSteps.");
    assert.equal(g.dir, realpathSync(join(root, "legacy")));
  });

  it("gives skill.yml precedence over SKILL.md frontmatter and keeps the raw body", () => {
    const md = "---\nname: from-frontmatter\ndescription: fm\n---\n# Body\n";
    write(join(root, "both", "skill.yml"), "name: From Yml\ndescription: yml wins\n");
    write(join(root, "both", "SKILL.md"), md);
    const [g] = loadSkillGuides();
    assert.equal(g.name, "From Yml");
    assert.equal(g.description, "yml wins");
    assert.equal(g.body, md.trim(), "legacy body semantics are unchanged");
  });

  it("falls back to the directory id when skill.yml has no name", () => {
    write(join(root, "nameless", "skill.yml"), "description: just a description\n");
    write(join(root, "nameless", "SKILL.md"), "# Body\n");
    const [g] = loadSkillGuides();
    assert.equal(g.name, "nameless");
  });

  it("parses multiline YAML in skill.yml", () => {
    write(join(root, "multi", "skill.yml"), "name: multi\ndescription: >\n  folded\n  legacy text\n");
    write(join(root, "multi", "SKILL.md"), "# Body\n");
    const [g] = loadSkillGuides();
    assert.equal(g.description.trim(), "folded legacy text");
  });

  it("still loads legacy flat skill.yml values that are not strict YAML", () => {
    write(join(root, "colon", "skill.yml"), "name: colon\ndescription: Use when: things happen\n");
    write(join(root, "colon", "SKILL.md"), "# Body\n");
    const [g] = loadSkillGuides();
    assert.equal(g.description, "Use when: things happen");
  });
});
