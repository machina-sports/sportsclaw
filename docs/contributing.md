---
title: Contributing
description: How to set up sportsclaw locally, the conventions the codebase follows, what CI checks, and where each kind of change belongs.
---

# Contributing

<p class="sc-lead-doc">
sportsclaw is developed in the open by the Machina Sports team and outside contributors. Bug fixes,
new bot surfaces, benchmark cases and docs all land through pull requests on GitHub — the same way the
core team ships.
</p>

<Contributors />

## Where your change belongs

| You want to… | Go to |
| --- | --- |
| Fix or extend the engine, bots, relay or CLI | [machina-sports/sportsclaw](https://github.com/machina-sports/sportsclaw) |
| Add a sport, league or data endpoint | [machina-sports/sports-skills](https://github.com/machina-sports/sports-skills) — sportsclaw discovers installed skills on its own |
| Improve these docs | this repository, under `docs/` |
| Report a bug or propose a feature | [GitHub issues](https://github.com/machina-sports/sportsclaw/issues) |
| Talk it through first | the [Machina Sports Discord](https://discord.gg/CU5KmQWHD9) |

## Set up

```bash
git clone https://github.com/machina-sports/sportsclaw
cd sportsclaw
npm install            # npm only: no pnpm or bun in this repo
npm run build          # tsc, strict
npm test               # build, then the node:test suite
```

To run real queries locally you also need the data layer and a model key:

```bash
pip install sports-skills
export ANTHROPIC_API_KEY=sk-...    # or OPENAI_API_KEY / GEMINI_API_KEY / AZURE_FOUNDRY_API_KEY
node dist/index.js "What are today's NBA scores?"
```

`node dist/index.js doctor` tells you what's missing.

## Conventions

- **Stack:** Node.js, TypeScript, ESM. Use npm.
- **Names:** files in kebab-case (`game-alerts.ts`), functions and variables in camelCase, types and
  classes in PascalCase.
- **Imports:** local imports use explicit `.js` extensions — ESM requires it.
- **Async:** `async`/`await` over promise chains; wrap the specific call that can fail in
  `try`/`catch`.
- **No invented feeds:** never assume a sport, league or endpoint exists until it's in sports-skills.
  If the data layer can't fetch it, the agent can't claim it.
- **Tests:** `node:test` files in `test/*.test.mjs`. Most areas have a focused script, e.g.
  `npm run test:guardrails` or `npm run test:game-alerts`.

## What CI checks

Every pull request — whatever its base branch, so stacked PRs work — runs:

1. **Build:** `npm ci` and `npm run build` with strict TypeScript.
2. **Tests:** every `test/*.test.mjs` under `node:test`, with FFmpeg installed for the media contracts.
3. **Smoke:** `test/ci-smoke.mjs` boots the engine with no API key at all.

Live-provider tests are not part of required CI because they need secrets. Run
`npm run test:ci-integration` yourself when you change how a model provider is called.

## Working on the docs

```bash
npm run docs:dev       # local preview with hot reload
npm run docs:build     # the same build the site deploy runs
```

- Pages are Markdown in `docs/`; the navigation and sidebar live in `docs/.vitepress/config.mts`.
- The landing page and footer are Vue components in `docs/.vitepress/theme/components/`.
- **Dead links fail the build.** Link to repository files outside `docs/` with a full GitHub URL, not a
  relative path.
- Every page ends with a *Suggest an edit on GitHub* link — the fastest way to fix a typo.

## Pull requests

- Branch from `main` and keep each PR focused on one change.
- Say what changed and how you verified it: commands you ran, output you checked.
- Add or update tests next to the behavior you changed.
- If you change user-facing behavior, update the page that documents it in the same PR.

Maintainers at Machina Sports review and merge.

## Releases

- `v*` tags mark engine releases on GitHub and deploy this site.
- `relay-v*` tags build the relay image that Machina projects run.
- The npm package is [`sportsclaw-engine-core`](https://www.npmjs.com/package/sportsclaw-engine-core).

## Acknowledgements

sportsclaw's execution engine draws on [NanoClaw](https://github.com/nanocoai/nanoclaw),
[OpenClaw](https://github.com/openclaw/openclaw), [NemoClaw](https://github.com/NVIDIA/NemoClaw) and
[pi.dev](https://pi.dev). It's built on the [Vercel AI SDK](https://ai-sdk.dev) for multi-provider
models, and the interactive setup uses [Clack](https://github.com/bombshell-dev/clack).
