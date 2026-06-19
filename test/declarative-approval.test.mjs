/**
 * Declarative Tool Approvals — test suite
 *
 * Verifies that:
 *  1. built-in write_file throws ApprovalPendingHalt when not pre-approved.
 *  2. built-in execute_command throws ApprovalPendingHalt when not pre-approved.
 *  3. Dynamic tools with a declarative needsApproval function throw ApprovalPendingHalt when triggered.
 *  4. Pre-approved rules allow execution to proceed.
 */

import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { sportsclawEngine } from "../dist/index.js";
import { ApprovalPendingHalt, loadRuleset, resolveApproval } from "../dist/approval.js";

describe("Declarative & Built-in Tool Approvals", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "declarative-approval-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("write_file and execute_command throw ApprovalPendingHalt when yoloMode is off and not pre-approved", async () => {
    const engine = new sportsclawEngine({
      yoloMode: false,
      rootDir: tmpDir,
    });

    const tools = engine.buildTools(undefined, new Map(), "user_1", "cli");

    // Test write_file
    const writeFileTool = tools["write_file"];
    assert.ok(writeFileTool, "write_file tool must exist");

    try {
      await writeFileTool.execute({ path: path.join(tmpDir, "test.txt"), content: "hello" });
      assert.fail("write_file should have thrown ApprovalPendingHalt");
    } catch (err) {
      assert.ok(err instanceof ApprovalPendingHalt, `expected ApprovalPendingHalt, got: ${err.name}`);
      assert.strictEqual(err.request.action, "write_file");
      assert.strictEqual(err.request.userId, "user_1");
      assert.strictEqual(err.request.platform, "cli");
    }

    // Test execute_command
    const execCmdTool = tools["execute_command"];
    assert.ok(execCmdTool, "execute_command tool must exist");

    try {
      await execCmdTool.execute({ command: "echo 'hello'" });
      assert.fail("execute_command should have thrown ApprovalPendingHalt");
    } catch (err) {
      assert.ok(err instanceof ApprovalPendingHalt, `expected ApprovalPendingHalt, got: ${err.name}`);
      assert.strictEqual(err.request.action, "execute_command");
    }
  });

  it("declarative needsApproval predicate gates dynamic schema tools", async () => {
    const engine = new sportsclawEngine({
      yoloMode: false,
      rootDir: tmpDir,
    });

    // Inject a dummy dynamic sport schema with custom tools
    const dummySchema = {
      sport: "football",
      tools: [
        {
          name: "high_risk_bet",
          description: "Place a high risk bet",
          command: "bet",
          parameters: {
            type: "object",
            properties: {
              amount: { type: "number" },
            },
            required: ["amount"],
          },
          // Gated: amounts over 10 require approval
          needsApproval: (args) => (args?.amount ?? 0) > 10,
        },
      ],
    };

    engine.registry.injectSchema(dummySchema, true);

    const tools = engine.buildTools(undefined, new Map(), "user_2", "cli");
    const betTool = tools["high_risk_bet"];
    assert.ok(betTool, "high_risk_bet tool must be registered");

    // 1. amount <= 10 should execute normally without approval (it will delegate to python bridge, which fails on mock)
    try {
      await betTool.execute({ amount: 5 });
    } catch (err) {
      // It should NOT throw ApprovalPendingHalt (it throws Python execution error/mock failure instead)
      assert.ok(!(err instanceof ApprovalPendingHalt), "should not require approval for amount <= 10");
    }

    // 2. amount > 10 should trigger declarative approval check and throw ApprovalPendingHalt
    try {
      await betTool.execute({ amount: 15 });
      assert.fail("should have required approval for amount > 10");
    } catch (err) {
      assert.ok(err instanceof ApprovalPendingHalt, "expected ApprovalPendingHalt");
      assert.strictEqual(err.request.action, "high_risk_bet");
      assert.strictEqual(err.request.userId, "user_2");
      assert.strictEqual(err.request.platform, "cli");
      assert.deepEqual(err.request.toolArgs, { amount: 15 });
    }
  });

  it("pre-approved rule skips approval check", async () => {
    const platform = "telegram";
    const userId = "user_3";

    const engine = new sportsclawEngine({
      yoloMode: false,
      rootDir: tmpDir,
    });

    // Inject the dummy schema
    const dummySchema = {
      sport: "football",
      tools: [
        {
          name: "gated_post",
          description: "Post a message",
          command: "post",
          parameters: {
            type: "object",
            properties: { msg: { type: "string" } },
          },
          needsApproval: () => true, // Always requires approval
        },
      ],
    };

    engine.registry.injectSchema(dummySchema, true);

    // Pre-approve the gated_post action
    await resolveApproval(platform, userId, "apr_fake", "allow-always");
    // Wait, resolveApproval expects request to exist. Let's add allow-always rule directly:
    const { addAllowAlwaysRule } = await import("../dist/approval.js");
    await addAllowAlwaysRule(platform, userId, "gated_post");

    const tools = engine.buildTools(undefined, new Map(), userId, platform);
    const postTool = tools["gated_post"];

    try {
      await postTool.execute({ msg: "hello" });
    } catch (err) {
      // It should NOT require approval because it is pre-approved!
      assert.ok(!(err instanceof ApprovalPendingHalt), "pre-approved action should skip approval check");
    }
  });
});
