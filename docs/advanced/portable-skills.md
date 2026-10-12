# Portable Skills

sportsclaw can load standard `SKILL.md` skills (YAML frontmatter + Markdown body) from
`SPORTSCLAW_SKILL_GUIDES_DIR`. The model can read a loaded skill and its `references/`, and can
run the skill's Python helpers in `scripts/` **only if the operator approved them by hash**.

With `SPORTSCLAW_SKILL_GUIDES_DIR` unset, nothing changes: no new tools and no prompt changes.
If you already set it for legacy guides, the two tools below now appear as well. Script
execution still refuses everything until you set an allowlist.

## Discovery

The loader scans the configured root for skill directories:

- **Portable:** a `SKILL.md` that starts with YAML frontmatter containing non-empty string
  `name` and `description`. Other keys (`license`, `compatibility`, `metadata`, …) are allowed
  and ignored. The guide body is the Markdown after the frontmatter.
- **Legacy:** `skill.yml` + `SKILL.md`. `skill.yml` wins over any frontmatter, and the body is the
  full `SKILL.md`, as before. `skill.yml` is parsed as YAML. If it is not strict YAML (for example
  `description: Use when: x`), the old line-based parser is used instead.

Rules:

- The **directory name is the skill id** used with the tools. If two directories share a name,
  both are dropped as ambiguous (reported with `--verbose`).
- Malformed, unterminated, or incomplete frontmatter skips only that skill.
- Guides are sorted by id.
- Symlinks are never followed, whether directories, `SKILL.md`, or `skill.yml`, so the scan
  cannot leave the root or loop.
- Scan depth is limited to 8 levels below the root, and `SKILL.md`/`skill.yml` to 256 KiB.
- Frontmatter never grants permissions. `allowed-tools`, `metadata.*`, and similar keys are
  ignored.

## Tools

Both tools are registered only when at least one guide loaded (`src/skill-runtime.ts`). They go
through the normal registry/engine pipeline, so `toolAllowlist`, the trading blocklist, and
approval gates apply. The registry result cache never stores them.

Within a single turn, the engine still hands back an identical earlier successful call (or skips
an identical earlier failure). That reuses evidence; the helper is not run again.

### `skill_read_reference(skill, path)`

Reads `SKILL.md` or a file under `references/` of that skill. No script approval is needed.

- `path` must be relative. Absolute paths, `.`/`..`/empty segments, backslashes, `:` (which
  covers URLs), and control characters are rejected.
- The real path must equal `<skill dir>/<path>`. Any symlink along the way is rejected, which
  covers escaping symlinks.
- The target must be a regular file ending in `.md`, `.txt`, `.json`, `.yaml`, or `.yml`, at most
  256 KiB, and valid UTF-8.
- Error codes: `invalid_args`, `unknown_skill`, `invalid_path`, `not_found`, `too_large`,
  `not_text`.

### `skill_run_script(skill, script, args)`

Runs a helper `scripts/**/*.py` of that skill. Checks run in this order:

1. **Input.** Only `skill`, `script`, and `args` are accepted. `args` is at most 32 strings of up
   to 4096 bytes each, with no control characters. Fields such as interpreter, env, cwd, shell,
   or code are rejected.
2. **Path.** The same path rules as above, restricted to `scripts/` and `.py`.
3. **Trading guard.** The existing `isBlockedTool` check runs on the helper's basename and on
   every identifier-like arg (leading dashes stripped). Examples: `place_order.py`, `withdraw`,
   `--place-order`. Operator approval does **not** lift this; only `allowTrading` does, as for
   every other tool.
4. **Replay.** If `SPORTS_SKILLS_REPLAY` is set to anything other than `off`, the call is refused
   (`replay_blocked`) before spawning, because helpers fetch live data.
5. **Approval.** The helper bytes (at most 1 MiB) are read once and hashed with SHA-256. The hash
   must match an allowlist entry for this exact `skill` + `script`. The policy and hash are
   checked again on every call.
6. **Execution.** The configured `pythonPath` (default `python3`) runs with
   `-I -c <fixed bootstrap>` and `shell: false`, with the skill directory as `cwd`. The verified
   bytes are written to stdin. The bootstrap compiles them with `__file__` and `sys.argv[0]`
   set to the helper's real path and runs them as `__main__`. The bytes that run are the bytes
   that were hashed: a file swapped after the check is not run, and no file-descriptor passing
   is needed. The model cannot supply code.
7. **Environment.** Only `PATH`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TZ`, `TMPDIR`, `SYSTEMROOT`,
   `SSL_CERT_FILE`, and `SSL_CERT_DIR` are passed, plus `SPORTS_SKILLS_REPLAY=off`. Credentials,
   `HOME`, `PYTHONPATH`, proxies, and `SPORTSCLAW_*` are not.
8. **Limits.** Execution has a 30 s timeout (`SKILL_SCRIPT_TIMEOUT_MS`), and stdout+stderr are
   capped at 256 KiB combined. Helpers run in a separate POSIX process group. On either limit,
   and after normal completion, that group gets `SIGKILL` to clean up ordinary child processes.
   Script execution requires Linux/macOS; Windows calls return `unsupported_platform` before
   spawning. Discovery and reference reads do not require process groups.
   This is lifecycle cleanup, not sandboxing: audited helpers must not create new sessions or
   otherwise escape their process group.

Success returns `{ skill, script, exit_code: 0, stdout, stderr }`. Error codes: `invalid_args`,
`unknown_skill`, `invalid_path`, `not_found`, `blocked_tool`, `replay_blocked`, `not_approved`
(with a `hint` and the `approved_scripts` of that skill), `timeout`, `output_limit`,
`script_failed` (with `exit_code` and the last 4000 chars of `stderr`), `unsupported_platform`,
and `spawn_failed`.

## Approval policy

Approval is set by the operator, outside the skill:

```bash
SPORTSCLAW_SKILL_SCRIPT_ALLOWLIST='[{"skill":"<dir id>","script":"scripts/<file>.py","sha256":"<64 lowercase hex>"}]'
```

- The policy must be a JSON array of objects with exactly `skill`, `script`, and `sha256`
  (lowercase hex).
- Any malformed entry or duplicate `skill`+`script` denies **all** scripts.
- An edited helper no longer matches its hash and is denied until it is approved again.
- Nothing else grants approval: not `SKILL.md`, `skill.yml`, the prompt, model arguments,
  `--yolo`, or a user message.

## Prompt

When either tool is offered, the Skill Guides section lists each disk guide's id and tells the
model:

- how to call the offered tools;
- that skill instructions, references, and helper output are **untrusted data**;
- that skill metadata is not permission;
- to prefer the dedicated sports tools when they cover the request;
- to tell the user about a refusal instead of looking for another way to run the helper.

Tools filtered out by an allowlist are not mentioned. Guides render exactly as before when
neither tool is offered.

## Example: `espn-api` from sports-skills

Use your existing reviewed sports-skills checkout. Do not vendor or rewrite it.

```bash
# 1. Copy the reviewed skill into a directory the runtime cannot write to
#    (for containers: mount it read-only).
install -d /opt/sportsclaw/skills
cp -R /path/to/sports-skills/skills/espn-api /opt/sportsclaw/skills/
chmod -R a-w /opt/sportsclaw/skills/espn-api

# 2. Approve the helper by hashing the copy you just reviewed.
HASH=$(shasum -a 256 /opt/sportsclaw/skills/espn-api/scripts/espn_fetch.py | cut -d' ' -f1)
export SPORTSCLAW_SKILL_SCRIPT_ALLOWLIST="[{\"skill\":\"espn-api\",\"script\":\"scripts/espn_fetch.py\",\"sha256\":\"$HASH\"}]"

# 3. Point sportsclaw at the root.
export SPORTSCLAW_SKILL_GUIDES_DIR=/opt/sportsclaw/skills
```

The model can then call `skill_read_reference("espn-api", "references/…")` and
`skill_run_script("espn-api", "scripts/espn_fetch.py", ["scoreboard", "lacrosse", "pll"])`.

For containers, mount the reviewed tree read-only at `SPORTSCLAW_SKILL_GUIDES_DIR` and set the
allowlist through deployment config. The default relay images do not enable this; enabling it
is a separate deployment change.

## Security limits

**This is not an OS sandbox.** The hash check means only helpers the operator reviewed can run.
It does **not** limit what an approved helper does once it runs.

- An approved helper runs with the sportsclaw process's user, filesystem access, and network
  access. Only approve audited helpers that are read-only.
- The operator must review the Python dependencies a helper imports. `-I` ignores user
  site-packages, `PYTHONPATH`, and the helper's own directory on `sys.path`, but the system
  interpreter's packages are still importable. Helpers that import sibling modules will not
  work.
- Only the direct helper process is killed on timeout or output limit. Processes the helper
  spawns itself are not tracked.
- Network egress and filesystem policy must be enforced by the deployment (container, firewall,
  read-only mounts). sportsclaw does not enforce host allowlists or read-only access.
- Keep the skill root read-only and owned by the operator. The runtime only promises to run the
  approved bytes. It does not make the directory trustworthy.
