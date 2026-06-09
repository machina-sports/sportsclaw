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
