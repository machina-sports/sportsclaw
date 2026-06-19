# CLI Interactive Approval — Design

**Date:** 2026-06-19
**Issue:** #91
**Scope:** CLI only (Discord/Telegram async UI explicitly deferred)

## Problem

The approval gate added in #85 throws `ApprovalPendingHalt` to "pause the engine
loop," but no surface ever catches it or resumes — so denials dead-ended until
PR #90 reverted them to actionable, model-visible errors. That restored correct
behavior but left the gate non-interactive: an operator running an agentic tool
(`write_file`, `execute_command`, or a dynamic tool with `needsApproval`) on the
CLI cannot grant consent in the moment — their only options are `--yolo`
(bypass everything) or pre-seeding a rule out of band.

This adds an interactive approval prompt for the **CLI**, the surface where a
human operator actually triggers these tools.

## Approach

A CLI can prompt **synchronously and inline** during tool execution — the way
`sudo`, `git`, and `npm` do — rather than the async halt → render-UI → re-run
dance the Discord/Telegram `AskUserQuestionHalt` flow uses. This is simpler and
strictly more secure: the exact arguments shown in the prompt are the exact
arguments that execute (no re-running the LLM, which could call the tool with
different args than were approved).

`ApprovalPendingHalt` and the persisted-request machinery from #85 remain in the
codebase (the class is still referenced by `isHalt`) so a future PR can build
the async Discord/Telegram UI on top. This change does not use them on the CLI
path.

## Architecture — one helper, three call sites

A single `gateApproval()` in `src/approval.ts` centralizes the decision. The
three gate sites in `src/engine.ts` (the dynamic `needsApproval` gate, the
built-in `write_file`, and the built-in `execute_command`) each `await` it and
then proceed to execute. Today those sites duplicate the pre-approval check and
the denial throw; this folds them into one place.

```
gateApproval(action, description, platform, userId, { interactive, prompt? }):
  if await isActionPreApproved(platform, userId, action)   -> return            // proceed
  if interactive:
     decision = await (prompt ?? promptApprovalDecision)(action, description)
     allow-once   -> return                                                     // proceed
     allow-always -> await addAllowAlwaysRule(platform, userId, action); return // proceed
     deny         -> throw Error("<action> denied: user approval required ...")
  else:                                                                         // non-TTY / non-cli
     throw Error("<action> denied: user approval required. Pass --yolo ...")
```

`gateApproval` returns `void` on "proceed" and throws on denial. The thrown
`Error` is a plain (non-halt) error, so the AI SDK surfaces it to the model as a
tool-error result (same mechanism PR #90 restored).

### `src/engine.ts` integration

- Compute once in `buildTools`:
  `const interactive = (runPlatform ?? "cli") === "cli" && !!process.stdin.isTTY;`
- The existing `--yolo` branches (with their `YOLO_BLOCKED_PATHS` /
  `YOLO_BLOCKED_COMMANDS` safety checks) are **untouched** — `gateApproval` is
  only reached on the non-yolo path.
- Each gate site becomes:
  ```ts
  // dynamic gate
  if (!config.yoloMode && spec.needsApproval && spec.needsApproval(args)) {
    await gateApproval(spec.name, `Execution of ${spec.name} with arguments: ${JSON.stringify(args)}`, platform, userId, { interactive });
  }
  // write_file (non-yolo branch)
  await gateApproval("write_file", `Write file to ${filePath} (${fileContent.length} bytes)`, platform, userId, { interactive });
  return executeWriteFile(filePath, fileContent);
  // execute_command (non-yolo branch)
  await gateApproval("execute_command", `Execute command: ${truncated}`, platform, userId, { interactive });
  return runCommand();
  ```
- The direct `isActionPreApproved` calls at the gate sites are removed (folded
  into `gateApproval`); the now-unused `isActionPreApproved` import in
  `engine.ts` is dropped. `ApprovalPendingHalt` import stays (used by `isHalt`).

## Components in `src/approval.ts`

- `parseApprovalInput(line: string): ApprovalDecision` — **pure**. `o`/`once`
  → `allow-once`; `a`/`always` → `allow-always`; everything else, including
  empty, EOF, and unrecognized input → `deny` (fail-closed). Case-insensitive,
  trims whitespace.
- `promptApprovalDecision(action: string, description: string): Promise<ApprovalDecision>`
  — thin `node:readline` shell. Writes the prompt to **stderr** (keeps stdout
  clean for any structured output), reads one line, returns
  `parseApprovalInput(line)`. Resolves to `deny` on stream error/close.
- `gateApproval(action, description, platform, userId, opts?)` — the logic
  above. `opts.interactive` (boolean) and `opts.prompt` (injectable decision
  function, default `promptApprovalDecision`) exist so the engine supplies the
  TTY determination and tests can inject a stub.
- Widen `AgenticAction` from `"write_file" | "execute_command"` to `string`,
  removing #85's `as any` casts and letting rulesets/prompts cover dynamic tool
  names uniformly. `buildApprovalPrompt` keeps working (its `write_file` ternary
  becomes a label fallback for arbitrary actions); it remains for the future
  async path.

### Prompt UX (stderr)

```
⚠  Approval required — execute_command
   Execute command: pip install pandas
   [o]nce  [a]lways  [d]eny  (default: deny) >
```

## Data flow

```
node dist/index.js "<query>"
  -> cmdQuery -> engine.run -> generateText multi-step loop
  -> tool.execute (gated tool)
  -> gateApproval -> (interactive) readline prompt -> user types "a"
  -> addAllowAlwaysRule -> execute -> result returns into the LLM loop -> response
Subsequent runs: isActionPreApproved -> true -> no prompt.
```

## Error handling & safety

- **Non-interactive (non-TTY)**: operator daemon, piped stdin, CI. `gateApproval`
  never blocks; it throws the actionable denial. This is also why Discord and
  Telegram are unaffected — they run non-TTY with `platform !== "cli"`, so they
  keep the exact #90 behavior with no code change on their paths.
- **EOF / empty / invalid input** → `deny` (fail-closed).
- **`--yolo`** → bypasses approval entirely (unchanged).
- **Stream errors in readline** → resolve to `deny`.

## Testing

- `parseApprovalInput` — pure unit tests for every accepted token (`o`, `once`,
  `a`, `always`, mixed case, surrounding whitespace) and fail-closed defaults
  (empty string, `x`, `yes`).
- `gateApproval` with an injected `prompt` stub:
  - `allow-once` → resolves (proceeds), no rule persisted.
  - `allow-always` → resolves and `isActionPreApproved` is true afterward.
  - `deny` → throws with `/<action> denied/`.
  - `interactive: false` → throws (fail-closed) without invoking the prompt.
  - pre-approved action → resolves without invoking the prompt.
- Regression: existing `declarative-approval.test.mjs` runs under a non-TTY test
  process, so its denial-throws assertions continue to hold — confirming the
  fail-closed path is intact.

## Files touched

- `src/approval.ts` — add `parseApprovalInput`, `promptApprovalDecision`,
  `gateApproval`; widen `AgenticAction`.
- `src/engine.ts` — call `gateApproval` at the three gate sites; compute
  `interactive`; drop the now-unused `isActionPreApproved` import.
- `test/approval-interactive.test.mjs` — new suite (pure parser + injected-prompt
  gate behavior).

## Out of scope

- Discord/Telegram interactive approval UI and the async halt/resume path.
- Migrating chat memory (`memory.ts`) to the durability substrate.
- The `platform='cli'` hardcode in the built-in agentic tools is resolved
  incidentally (the gate now uses the real `runPlatform`), but no broader
  per-platform approval-state work is in scope.
