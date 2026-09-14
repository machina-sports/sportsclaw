import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  BUILD_BRIEF_MAX_BYTES,
  parseBuildBrief,
  renderBuildBrief,
} from "../dist/build-brief.js";

const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/build-brief.valid.json", import.meta.url), "utf-8"),
);
const invalidFixture = readFileSync(
  new URL("../fixtures/build-brief.invalid.json", import.meta.url),
  "utf-8",
);
const validBrief = () => structuredClone(fixture);

describe("portable build brief contract", () => {
  it("parses and renders the shared valid fixture", () => {
    const brief = parseBuildBrief(JSON.stringify(validBrief()), {
      allowedSkills: ["plays-game-builder"],
      expectedProjectId: "plays-demo",
      expectedRepository: "machina-sports/plays-demo",
    });
    assert.equal(brief.data.provenance[0].verification, "sample");
    assert.match(renderBuildBrief(brief), /not independently verified/i);
  });

  it("accepts the observed singular workflow search capability", () => {
    const brief = validBrief();
    brief.selection.capabilities = ["search_workflow"];
    brief.data.interfaces.find((item) => item.name === "search_workflow").name =
      "search_workflow";

    assert.doesNotThrow(() => parseBuildBrief(JSON.stringify(brief)));
  });

  it("rejects the nonexistent plural workflow search capability", () => {
    const brief = validBrief();
    brief.selection.capabilities = ["search_workflows"];
    brief.data.interfaces.find((item) => item.name === "search_workflow").name =
      "search_workflows";
    assert.throws(
      () => parseBuildBrief(JSON.stringify(brief)),
      /unsupported requested capability/i,
    );
  });

  for (const [label, mutate] of [
    ["version", (brief) => (brief.schemaVersion = 2)],
    ["project", (brief) => (brief.project.id = "../bad")],
    ["pod URL", (brief) => (brief.project.podUrl = "http://example.com/path")],
    ["credentials", (brief) => (brief.password = "secret")],
    ["skill", (brief) => (brief.selection.skills = ["unknown-builder"])],
    ["observed data", (brief) => (brief.data.interfaces = [])],
    ["acceptance checks", (brief) => (brief.acceptanceChecks = [])],
  ]) {
    it(`rejects invalid ${label}`, () => {
      const brief = validBrief();
      mutate(brief);
      assert.throws(() =>
        parseBuildBrief(JSON.stringify(brief), {
          allowedSkills: ["plays-game-builder"],
        }),
      );
    });
  }

  it("rejects project mismatch and oversized input", () => {
    assert.throws(() =>
      parseBuildBrief(JSON.stringify(validBrief()), {
        expectedProjectId: "other",
      }),
    );
    assert.throws(() => parseBuildBrief("x".repeat(BUILD_BRIEF_MAX_BYTES + 1)));
  });

  for (const capability of [
    "create_secrets",
    "delete_document",
    "execute_workflow",
    "totally_unknown",
  ]) {
    it(`rejects non-read-only capability ${capability}`, () => {
      const brief = validBrief();
      brief.selection.capabilities = [capability];
      brief.data.interfaces = [
        {
          name: capability,
          kind: "tool",
          inputSchema: { type: "object" },
          outputSchema: { type: "object" },
          representativeRecords: [{ ok: true }],
        },
      ];
      assert.throws(
        () => parseBuildBrief(JSON.stringify(brief)),
        /unsupported requested capability/i,
      );
    });
  }

  for (const credentialKey of [
    "access_token",
    "accessToken",
    "refresh_token",
    "refreshToken",
    "client_secret",
    "clientSecret",
    "private_key",
    "privateKey",
  ]) {
    it(`rejects credential-bearing sample field ${credentialKey}`, () => {
      const brief = validBrief();
      brief.data.interfaces[0].representativeRecords = [
        { [credentialKey]: "sensitive" },
      ];
      assert.throws(
        () => parseBuildBrief(JSON.stringify(brief)),
        /credential and secret fields are forbidden/i,
      );
    });
  }

  it("preserves credential-shaped property names in structural schemas", () => {
    const brief = validBrief();
    brief.data.interfaces[0].inputSchema = {
      type: "object",
      properties: {
        access_token: { type: "string" },
        clientSecret: { type: "string" },
      },
    };
    assert.doesNotThrow(() => parseBuildBrief(JSON.stringify(brief)));
  });

  it("rejects a trusted dispatcher URL that is not the exact pod origin", () => {
    assert.throws(
      () =>
        parseBuildBrief(JSON.stringify(validBrief()), {
          expectedPodUrl: "https://demo.org.machina.gg/api",
        }),
      /podUrl/i,
    );
  });

  it("rejects the shared invalid fixture", () => {
    assert.throws(() =>
      parseBuildBrief(invalidFixture, {
        allowedSkills: ["plays-game-builder"],
      }),
    );
  });
});
