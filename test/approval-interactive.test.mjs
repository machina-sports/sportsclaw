/**
 * CLI Interactive Approval — test suite (#91)
 *
 * Covers the pure input parser and the centralized gateApproval() decision
 * helper. The real readline shell (promptApprovalDecision) is a thin I/O layer
 * exercised via an injected prompt stub here.
 *
 * HOME is redirected to a temp dir BEFORE importing the module so the durable
 * approval ruleset writes stay hermetic (DurableStateStore roots at ~/.sportsclaw).
 */

import assert from "node:assert/strict";
import { describe, it, after } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "approval-home-"));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

const { parseApprovalInput, gateApproval, isActionPreApproved } = await import(
  "../dist/approval.js"
);

after(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("parseApprovalInput", () => {
  it("parses allow-once tokens", () => {
    for (const t of ["o", "once", "O", " once ", "Once"]) {
      assert.strictEqual(parseApprovalInput(t), "allow-once", `"${t}"`);
    }
  });

  it("parses allow-always tokens", () => {
    for (const t of ["a", "always", "A", " always ", "Always"]) {
      assert.strictEqual(parseApprovalInput(t), "allow-always", `"${t}"`);
    }
  });

  it("treats explicit deny tokens as deny", () => {
    for (const t of ["d", "deny", "D"]) {
      assert.strictEqual(parseApprovalInput(t), "deny", `"${t}"`);
    }
  });

  it("fails closed on empty / unrecognized input", () => {
    for (const t of ["", "   ", "x", "yes", "y", "nope", "1"]) {
      assert.strictEqual(parseApprovalInput(t), "deny", `"${t}"`);
    }
  });
});

describe("gateApproval", () => {
  const platform = "cli";
  let n = 0;
  const freshUser = () => `gate_user_${Date.now()}_${n++}`;
  const throwingPrompt = () => {
    throw new Error("prompt must not be called");
  };

  it("proceeds without prompting when the action is pre-approved", async () => {
    const userId = freshUser();
    const { addAllowAlwaysRule } = await import("../dist/approval.js");
    await addAllowAlwaysRule(platform, userId, "write_file");

    // throwingPrompt asserts the prompt is never reached
    await gateApproval("write_file", "desc", platform, userId, {
      interactive: true,
      prompt: throwingPrompt,
    });
  });

  it("proceeds on allow-once without persisting a rule", async () => {
    const userId = freshUser();
    await gateApproval("execute_command", "run something", platform, userId, {
      interactive: true,
      prompt: async () => "allow-once",
    });
    assert.strictEqual(
      await isActionPreApproved(platform, userId, "execute_command"),
      false,
      "allow-once must not persist a standing rule"
    );
  });

  it("proceeds and persists a rule on allow-always", async () => {
    const userId = freshUser();
    await gateApproval("execute_command", "run something", platform, userId, {
      interactive: true,
      prompt: async () => "allow-always",
    });
    assert.strictEqual(
      await isActionPreApproved(platform, userId, "execute_command"),
      true,
      "allow-always must persist a standing rule"
    );
  });

  it("throws an actionable denial on deny", async () => {
    const userId = freshUser();
    await assert.rejects(
      () =>
        gateApproval("write_file", "desc", platform, userId, {
          interactive: true,
          prompt: async () => "deny",
        }),
      /write_file denied/
    );
  });

  it("fails closed (throws, never prompts) when non-interactive", async () => {
    const userId = freshUser();
    await assert.rejects(
      () =>
        gateApproval("execute_command", "desc", platform, userId, {
          interactive: false,
          prompt: throwingPrompt,
        }),
      /execute_command denied/
    );
  });

  it("supports dynamic (non-builtin) action names", async () => {
    const userId = freshUser();
    await gateApproval("high_risk_bet", "amount 15", platform, userId, {
      interactive: true,
      prompt: async () => "allow-always",
    });
    assert.strictEqual(
      await isActionPreApproved(platform, userId, "high_risk_bet"),
      true
    );
  });
});
