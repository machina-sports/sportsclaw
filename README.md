<p align="center">
  <img src="assets/logo.jpg" alt="SportsClaw" width="500">
</p>

# SportsClaw 🦞

A lean, high-performance sports AI agent framework.
~500 lines of TypeScript. Bring your own LLM.

### Purpose
SportsClaw is a lightweight execution loop designed specifically for building reliable sports AI agents. It connects frontier models directly to live sports data (scores, odds, play-by-play, stats) without the bloat of traditional, heavy agent frameworks.

Instead of relying on complex abstraction layers, SportsClaw focuses on executing deterministic primitives (`sports-skills`) and strict instructional guardrails to ensure agents report exact, hallucination-free sports information.

### Inspiration
SportsClaw's execution engine draws direct inspiration from [NanoClaw](https://github.com/anthropics/nanoclaw), [pi.dev](https://pi.dev), and [OpenClaw](https://github.com/anthropics/openclaw) — proving that a tight, sub-1000-line agentic loop can outperform bloated orchestration frameworks when paired with well-designed tool primitives.

### Core Focus
* **Sports-First:** Built from the ground up to handle the unique challenges of real-time sports data and betting markets.
* **Deterministic Execution:** Prioritizes exact data retrieval over generative guessing.
* **Zero Bloat:** No massive registries or config sprawl. Just a tight, high-performance execution loop.

---
*Built by the [Machina Sports](https://machina.gg) team.*
