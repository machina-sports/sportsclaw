# CLAUDE.md - sportsclaw Guidelines

## Tech Stack
- Runtime: Node.js / TypeScript / ESM
- Package Manager: npm (do not use pnpm or bun here)
- Formatting & Linting: Biome/Prettier for TS, Ruff for Python helpers
- Data Access: sports-skills (Python backend bindings)

## Build, Test & Lint Commands
- Install Dependencies: `npm install`
- Compile TS: `npm run build`
- Run Linter: `npm run lint`
- Run Tests: `npm test`
- Execute CLI locally: `node dist/index.js <command>` or `npm run cli -- <command>`

## Code Conventions
- Files: kebab-case.ts
- Variables/Functions: camelCase
- Types/Classes: PascalCase
- Imports: Always use explicit `.js` extensions for local module imports (ESM requirement)
- Async/Await: Avoid raw promises or nested .then() blocks; use try/catch surgically.
- No Invented Feeds: Never assume a sport or API feed exists unless verified in sports-skills.

## Compound Engineering Plugin (`compound-engineering-plugin`)
We use the EveryInc Compound Engineering plugin across our Claude Code and Codex environments to compound development velocity.
- **Philosophical Pivot:** Shift focus from raw coding speed to heavy upfront planning and structured review (80% planning, 20% coding).
- **Core Commands to Leverage:**
  - `/ce-strategy` — Create/maintain `STRATEGY.md` for product and business grounding.
  - `/ce-brainstorm` — Interactive Q&A to write requirements.
  - `/ce-plan` — Generate detailed step-by-step implementation plans.
  - `/ce-work` — Execute plans with automated git worktrees and task tracking.
  - `/ce-debug` — Reproduce failures, trace root causes, and write the fix.
  - `/ce-code-review` — Run multi-agent reviews before merging.
  - `/ce-compound` — Write modular learning files to `.compound-engineering/` so future agent runs in this repo instantly inherit local knowledge and avoid past mistakes.

