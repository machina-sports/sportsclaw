import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  buildFactoryArgv,
  parseFactoryJobId,
  parseWhoamiProjectId,
  prepareGamesBuild,
  submitGamesBuild,
} from "../dist/games.js";

const validBriefText = readFileSync(
  new URL("../fixtures/build-brief.valid.json", import.meta.url),
  "utf-8",
);

describe("games Factory handoff", () => {
  it("documents and routes games prepare without credentials or external commands", () => {
    const help = execFileSync("node", ["dist/index.js", "--help"], {
      encoding: "utf-8",
    });
    assert.match(help, /sportsclaw games prepare/);
    assert.match(help, /sportsclaw games submit/);
    assert.doesNotMatch(help, /sportsclaw plays/);

    const targetDirectory = mkdtempSync(join(tmpdir(), "sportsclaw-games-"));
    try {
      mkdirSync(join(targetDirectory, ".machina"));
      writeFileSync(
        join(targetDirectory, ".machina", "build-brief.json"),
        validBriefText,
      );
      const output = execFileSync(
        "node",
        [
          "dist/index.js",
          "games",
          "prepare",
          "--target",
          targetDirectory,
          "--repo",
          "machina-sports/games-demo",
          "--project",
          "games-demo",
          "--ref",
          "feature/games",
        ],
        { encoding: "utf-8" },
      );
      const prepared = JSON.parse(output);
      assert.equal(prepared.command, "machina");
      assert.match(prepared.argv[2], /Base branch: feature\/games/);
      assert.doesNotMatch(prepared.argv[2], /BUILD_SOURCE_BINDING=/);
    } finally {
      rmSync(targetDirectory, { recursive: true, force: true });
    }
  });

  it("prepares validated argv with no subprocess or shell interpolation", async () => {
    let calls = 0;
    const prepared = await prepareGamesBuild(
      {
        targetDirectory: "/target",
        repository: "machina-sports/games-demo",
        projectId: "games-demo",
        sourceRef: "feature/games",
      },
      {
        readBrief: async () => validBriefText,
        inspectPath: async () => ({ isSymbolicLink: false, isFile: true }),
        run: async () => {
          calls += 1;
          throw new Error("must not run");
        },
      },
    );

    assert.equal(calls, 0);
    assert.deepEqual(prepared.argv, buildFactoryArgv(prepared.brief, "feature/games"));
    assert.ok(
      prepared.argv.some((argument) => argument.includes(".machina/build-brief.json")),
    );
    assert.equal(prepared.argv.includes("--branch"), false);
    assert.ok(prepared.argv.some((argument) => argument.includes("Base branch: feature/games")));
  });

  it("requires consent, verifies origin and fetched source, then binds submission", async () => {
    const calls = [];
    const dependencies = {
      readBrief: async () => validBriefText,
      inspectPath: async () => ({ isSymbolicLink: false, isFile: true }),
      run: async (file, args) => {
        calls.push({ file, args });
        if (file === "git" && args.includes("get-url")) {
          return {
            exitCode: 0,
            stdout: "git@github.com:machina-sports/games-demo.git\n",
            stderr: "",
          };
        }
        if (file === "git" && args.includes("fetch")) {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (file === "git" && args.includes("show")) {
          return { exitCode: 0, stdout: validBriefText, stderr: "" };
        }
        if (file === "git" && args.includes("rev-parse")) {
          return {
            exitCode: 0,
            stdout: "0123456789abcdef0123456789abcdef01234567\n",
            stderr: "",
          };
        }
        if (file === "machina" && args.includes("whoami")) {
          return {
            exitCode: 0,
            stdout: '{\n  "projectId": "games-demo",\n  "uid": "user-1"\n}\n',
            stderr: "",
          };
        }
        return {
          exitCode: 0,
          stdout: '{\n  "id": "job_123",\n  "status": "queued"\n}\n',
          stderr: "",
        };
      },
    };
    const input = {
      targetDirectory: "/target",
      repository: "machina-sports/games-demo",
      projectId: "games-demo",
      sourceRef: "feature/games",
    };

    await assert.rejects(() => submitGamesBuild(input, dependencies), /consent/i);
    assert.equal(calls.length, 0);

    const result = await submitGamesBuild(
      { ...input, consent: true },
      dependencies,
    );
    assert.equal(result.jobId, "job_123");
    assert.equal(calls.at(-1).file, "machina");
    assert.equal(result.argv.includes("--branch"), false);
    assert.ok(result.argv[2].includes("Base branch: feature/games"));
    assert.ok(result.argv[2].includes("BUILD_SOURCE_BINDING="));
    assert.deepEqual(calls[0], {
      file: "git",
      args: ["-C", "/target", "remote", "get-url", "origin"],
    });
    assert.deepEqual(calls[1], {
      file: "git",
      args: [
        "-C",
        "/target",
        "fetch",
        "--no-tags",
        "git@github.com:machina-sports/games-demo.git",
        "+refs/heads/feature/games:refs/remotes/origin/feature/games",
      ],
    });
    assert.deepEqual(calls.at(-2), {
      file: "machina",
      args: ["factory", "whoami", "--project", "games-demo", "--json"],
    });
  });

  it("fails closed when output has no job id without echoing command output", async () => {
    const dependencies = {
      readBrief: async () => validBriefText,
      inspectPath: async () => ({ isSymbolicLink: false, isFile: true }),
      run: async (file, args) =>
        syntheticTransport(file, args, {
          submit: {
            exitCode: 0,
            stdout: "submitted Authorization: Bearer super-secret-token",
            stderr: "",
          },
        }),
    };

    await assert.rejects(
      () =>
        submitGamesBuild(
          {
            targetDirectory: "/target",
            repository: "machina-sports/games-demo",
            projectId: "games-demo",
            sourceRef: "feature/games",
            consent: true,
          },
          dependencies,
        ),
      (error) => {
        assert.doesNotMatch(error.message, /super-secret-token/);
        assert.match(error.message, /job id/i);
        return true;
      },
    );
  });

  it("parses only explicit supported job id envelopes", () => {
    assert.equal(parseFactoryJobId('{"jobId":"job_1"}'), "job_1");
    assert.equal(
      parseFactoryJobId('{\n  "id": "job_2",\n  "status": "queued"\n}'),
      "job_2",
    );
    assert.equal(parseFactoryJobId("\u001b[32m{\"projectId\":\"job_3\"}\u001b[0m"), "job_3");
    assert.throws(() => parseFactoryJobId('{"data":{"id":"job_2"}}'), /job id/i);
    assert.throws(
      () => parseFactoryJobId('{"id":"job_1","jobId":"job_2"}'),
      /job id/i,
    );
    assert.throws(
      () => parseFactoryJobId('{"id":"job_1","status":"error"}'),
      /error status/i,
    );
    assert.throws(
      () => parseFactoryJobId('{"id":"job_1","success":false}'),
      /error status/i,
    );
    assert.throws(() => parseFactoryJobId("queued job maybe-3"), /valid JSON/i);
  });

  it("accepts only the requested projectId from whoami", () => {
    assert.equal(
      parseWhoamiProjectId('{\n  "projectId": "games-demo"\n}'),
      "games-demo",
    );
    assert.throws(() => parseWhoamiProjectId('{"uid":"games-demo"}'), /project/i);
    assert.throws(
      () => parseWhoamiProjectId('{"projectId":"other"}', "games-demo"),
      /project/i,
    );
  });

  it("rejects an origin that is not the requested GitHub repository", async () => {
    const dependencies = syntheticDependencies({
      origin: "https://github.com/other/repository.git",
    });
    await assert.rejects(
      () => submitGamesBuild(validInput(), dependencies),
      /origin/i,
    );
    assert.equal(dependencies.calls.some((call) => call.file === "machina"), false);
  });

  it("fails closed without exposing command output", async () => {
    const secret = "raw-secret-from-command";
    const dependencies = syntheticDependencies({
      fetch: { exitCode: 9, stdout: secret, stderr: secret },
    });
    await assert.rejects(
      () => submitGamesBuild(validInput(), dependencies),
      (error) => {
        assert.match(error.message, /fetch/i);
        assert.match(error.message, /exit code 9/i);
        assert.doesNotMatch(error.message, new RegExp(secret));
        return true;
      },
    );
  });
});

function validInput() {
  return {
    targetDirectory: "/target",
    repository: "machina-sports/games-demo",
    projectId: "games-demo",
    sourceRef: "feature/games",
    consent: true,
  };
}

function syntheticTransport(file, args, overrides = {}) {
  if (file === "git" && args.includes("get-url")) {
    return {
      exitCode: 0,
      stdout: `${overrides.origin ?? "https://github.com/machina-sports/games-demo.git"}\n`,
      stderr: "",
    };
  }
  if (file === "git" && args.includes("fetch")) {
    return overrides.fetch ?? { exitCode: 0, stdout: "", stderr: "" };
  }
  if (file === "git" && args.includes("show")) {
    return { exitCode: 0, stdout: validBriefText, stderr: "" };
  }
  if (file === "git" && args.includes("rev-parse")) {
    return {
      exitCode: 0,
      stdout: "0123456789abcdef0123456789abcdef01234567\n",
      stderr: "",
    };
  }
  if (file === "machina" && args.includes("whoami")) {
    return {
      exitCode: 0,
      stdout: '{"projectId":"games-demo"}',
      stderr: "",
    };
  }
  return (
    overrides.submit ?? {
      exitCode: 0,
      stdout: '{"id":"job_123","status":"queued"}',
      stderr: "",
    }
  );
}

function syntheticDependencies(overrides = {}) {
  const calls = [];
  return {
    calls,
    readBrief: async () => validBriefText,
    inspectPath: async () => ({ isSymbolicLink: false, isFile: true }),
    run: async (file, args) => {
      calls.push({ file, args });
      return syntheticTransport(file, args, overrides);
    },
  };
}
