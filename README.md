<p align="center">
  <img src="assets/logo.jpg" alt="SportsClaw" width="500">
</p>

# SportsClaw 🦞

A lean, high-performance sports AI agent framework.
~500 lines of TypeScript. Bring your own LLM.

### Purpose
SportsClaw is a lightweight execution loop designed specifically for building reliable sports AI agents. It connects frontier models directly to live sports data (scores, odds, play-by-play, stats) through [sports-skills](https://sports-skills.sh) — without the bloat of traditional, heavy agent frameworks.

Instead of relying on complex abstraction layers, SportsClaw focuses on executing deterministic primitives (`sports-skills`) and strict instructional guardrails to ensure agents report exact, hallucination-free sports information.

### Built-in Sports Data Skills

SportsClaw ships with **14 sports data skills** out of the box, powered by the [`sports-skills`](https://sports-skills.sh) Python package:

`football-data` `nfl-data` `nba-data` `nhl-data` `mlb-data` `wnba-data` `tennis-data` `cfb-data` `cbb-data` `golf-data` `fastf1` `kalshi` `polymarket` `sports-news`

> **[sports-skills.sh](https://sports-skills.sh)** — Full dictionary and documentation for all built-in sports data skills.

### Inspiration
SportsClaw's execution engine draws direct inspiration from [NanoClaw](https://github.com/anthropics/nanoclaw), [pi.dev](https://pi.dev), and [OpenClaw](https://github.com/anthropics/openclaw) — proving that a tight, sub-1000-line agentic loop can outperform bloated orchestration frameworks when paired with well-designed tool primitives.

### Core Focus
* **Sports-First:** Built from the ground up to handle the unique challenges of real-time sports data and betting markets.
* **Deterministic Execution:** Prioritizes exact data retrieval over generative guessing.
* **Zero Bloat:** No massive registries or config sprawl. Just a tight, high-performance execution loop.

---
*Built by the [Machina Sports](https://machina.gg) team.*
