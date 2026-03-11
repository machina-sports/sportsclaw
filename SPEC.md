# SPEC.md: Chartli Visualizations Integration

## Goal
Integrate terminal-based and SVG chart visualizations into the `sportsclaw` agent loop, inspired by `chartli`. This allows the LLM to convert raw sports data (like player points, team streaks, or standings) into highly readable visual formats (sparklines, bars, columns, braille, and SVG).

## Scope
1. **Core Integration:** Add `chartli` (and optionally `@resvg/resvg-js` if we need PNG outputs for Discord/Telegram later) to the project dependencies, OR extract the core chart rendering math into `src/utils/charts.ts`.
2. **Tool Definition (`render_chart`):**
   - Expose a new tool to the AI model in `src/tools/` or the core engine.
   - **Parameters:** `data` (array of objects or numbers), `xAxisLabel` (string), `yAxisLabel` (string), `chartType` (enum: 'ascii', 'spark', 'bars', 'columns', 'braille', 'svg').
3. **Context-Aware Output:**
   - When the agent returns a chart, it should format it cleanly inside the terminal output.
   - If `chartType` is `svg` (useful for chat apps down the line), output the raw SVG string or convert to a visual buffer if the environment supports it.

## Execution Steps for Forge
1. **Branching:** Create a new branch `feat/chart-visualizations`.
2. **Dependency Management:** Investigate adding `chartli` via npm (`npm install chartli`), or copy its core string-building logic into a utility file if it lacks a programmatic API.
3. **Tool Implementation:** Create the tool wrapper for the Vercel AI SDK inside `sportsclaw` so the LLM can invoke it.
4. **Agent Prompt Updates:** Update the system prompt (e.g., in `src/agent/` or `src/prompts/`) to inform the model that it can and should use `render_chart` to visualize tabular or time-series data instead of just listing numbers.
5. **Testing:** Write a quick test or demonstrate the usage via the CLI.
6. **Commit:** Commit the changes and push the branch. DO NOT open a PR immediately; prepare the branch for Andre's review.

## Guidelines
- Follow the `sportsclaw` TypeScript styling.
- Ensure the core execution loop remains fast.
- Never hardcode the Anthropic API key; rely on the existing environment variables.
