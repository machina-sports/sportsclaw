# Artifact output (`artifact-turn-v1`)

A caller can let one run produce **one self-contained HTML document** (a visual report) beside
the answer text. The engine only validates and hands the document back. It never stores,
publishes, sanitizes for display, assigns an owner or makes a link: the caller owns all of that.

Without the opt-in, nothing changes: no `submit_artifact` tool, no prompt section, no new field
on the result line.

## Wire

```text
ArtifactTurnInput   { contract: "artifact-turn-v1", nonce }
ArtifactTurnResult  { contract: "artifact-turn-v1", nonce, artifact: artifact-v1 | null, reasonCode | null }
artifact-v1         { contract: "artifact-v1", title, mimeType: "text/html", html }
```

- `nonce`: 16–64 characters of `[A-Za-z0-9_-]`, chosen by the caller. The one result for the run
  echoes it, so a caller can tell that this exact request was honored.
- `title`: 1–120 UTF-16 units, no control characters.
- `html`: non-empty, at most 262,144 UTF-8 bytes, no lone surrogates and no control characters
  other than tab, line feed and carriage return. A caller may enforce a smaller limit.
- Exact keys everywhere: an extra field (an owner, a URL) makes the value invalid.
- `artifact` and `reasonCode` never coexist. `reasonCode` is one of:

| Code | Meaning |
|---|---|
| `null` with `artifact: null` | The model answered in text only. |
| `denied` | An explicit `toolAllowlist` omits `submit_artifact`. |
| `invalid_artifact` | A malformed, oversized, truncated or undispatchable submission. |
| `conflicting_artifact` | Two different documents in one run. |
| `evidence_unverified` | The answer's evidence check corrected, flagged or withheld it, so the document built from the same research is dropped. |

`src/artifact-output.ts` is the TypeScript side; `docker/relay/artifact_contract.py` mirrors it
for the relay with the standard library only.

## Engine

```ts
await engine.run(prompt, {
  historyMode: "caller",
  history,
  artifact: { contract: "artifact-turn-v1", nonce },
  onArtifactResult: (result) => { /* exactly one call per successful run */ },
});
```

- Validation happens before any model work: a missing observer, an invalid input or
  `historyMode` other than `caller` throws. Artifact mode needs caller-owned history so the engine
  never keeps the HTML in its own sessions or memory.
- The run offers `submit_artifact` plus a short, generic prompt section. Design guidance belongs
  to the caller's skills, not to the engine.
- The tool always answers `{ accepted, published: false }` and never a URL. One identical
  resubmission is fine; a different second document invalidates the run.
- `submit_artifact` is not a data source: it is excluded from the evidence bookkeeping, so the
  model's own document is never used as evidence for its answer.
- Parallel agent lanes never get the tool (they are partial drafts that get synthesized).
- A retried model call starts with an empty collector.

## CLI and relay

- CLI: `--history-mode caller --history-stdin` accepts `"artifact"` in the stdin object. The typed
  result rides on the NDJSON `result` line as `artifact`, never inside `text`.
- Relay: `SPORTSCLAW_ARTIFACTS_ENABLED=true` is the server gate; a request body can never enable
  it. When on, `/api/capabilities` advertises `artifact_contract: "artifact-turn-v1"`.
  `/api/query/sync` accepts `artifact` only with `history_mode: "caller"` and `history`, passes it
  on the child's stdin, and returns `artifact` only when exactly one result echoes the request's
  nonce (otherwise 502 with no prose). `/api/query` (stream) refuses `artifact`. Titles and HTML
  are never logged.

## What the caller must still do

The HTML is model output and must be treated as untrusted: sanitize it with an HTML parser, serve
it with a restrictive Content-Security-Policy (no scripts, no external loads) in a sandbox, check
size again, decide who owns it, store it, and only then tell the user where it is. Never show a
link before the store confirms the write.
