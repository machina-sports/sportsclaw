/**
 * sportsclaw — Guide Subagent (Sprint 2: Progressive Disclosure)
 *
 * Intercepts meta-queries ("help", "how to", "what sports") before they hit
 * the main data agent. This keeps the core system prompt focused on data
 * retrieval and analysis, while the Guide handles onboarding and docs.
 *
 * The Guide has read-only access to:
 *   - ~/.sportsclaw/schemas/ — installed sport schemas
 *   - Feature manifesto (hardcoded below)
 */

import {
  loadAllSchemas,
  getInstalledVsAvailable,
  SKILL_DESCRIPTIONS,
} from "./schema.js";
import type { SportSchema } from "./types.js";

// ---------------------------------------------------------------------------
// Intent detection — decides if the Guide should handle the query
// ---------------------------------------------------------------------------

const GUIDE_PATTERNS = [
  /^(?:help|getting started|tutorial)$/i,
  /\bhow (?:do|can|to) (?:i |you )?(?:use|start|get started|set ?up)\b/i,
  /\bwhat (?:can you do|sports do you|data do you)\b/i,
  /\b(?:what(?:'s| is) sportsclaw|who are you)\b/i,
  /\b(?:supported sports?|available sports?)\b/i,
  /\bhow does (?:this|sportsclaw) work\b/i,
  /^(?:list|show|what are) (?:your |the |all )?(?:commands|features|capabilities)\s*\??$/i,
  /\b(?:machina (?:skills?|templates?|cloud)|premium (?:connectors?|data)|sportradar|stats ?perform|api.?football)\b/i,
  /\b(?:what else|more features?|more data|upgrade|paid|cloud)\b/i,
];

/**
 * Returns true if the prompt is a meta/guide query that should be
 * handled by the Guide subagent instead of the main data agent.
 */
export function isGuideIntent(prompt: string): boolean {
  return GUIDE_PATTERNS.some((p) => p.test(prompt));
}

// ---------------------------------------------------------------------------
// Schema reader — read_docs equivalent
// ---------------------------------------------------------------------------

interface SchemaDigest {
  sport: string;
  description: string;
  toolCount: number;
  tools: string[];
}

/**
 * Read all installed schemas and return a digest suitable for the Guide.
 */
function readSchemaDigest(): SchemaDigest[] {
  const schemas = loadAllSchemas();
  return schemas.map((s: SportSchema) => ({
    sport: s.sport,
    description: SKILL_DESCRIPTIONS[s.sport] ?? s.sport,
    toolCount: s.tools.length,
    tools: s.tools.map((t) => t.name),
  }));
}

// ---------------------------------------------------------------------------
// Feature manifesto
// ---------------------------------------------------------------------------

const FEATURE_MANIFESTO = `
## sportsclaw Features

### Core Capabilities
- **Live Scores & Results** — Real-time scores across 16+ sports via ESPN, Transfermarkt, FBref, FastF1
- **Standings & Rankings** — Current league tables, conference standings, ATP/WTA rankings
- **Player & Team Stats** — Detailed statistics, profiles, market values, transfer history
- **Play-by-Play** — Game event feeds with scoring plays, substitutions, key moments
- **Schedules** — Upcoming games, tournament calendars, season fixtures
- **Prediction Markets** — Odds and event contracts from Kalshi and Polymarket
- **Sports News** — Headlines via Google News and curated RSS feeds

### Platform Integrations
- **Discord Bot** — Rich embeds, interactive buttons, native polls
- **Telegram Bot** — HTML-formatted responses, inline keyboard buttons
- **CLI** — Interactive REPL with ANSI-formatted tables

### Interactive Features
- **Smart Buttons** — Sport-aware follow-up actions (Box Score, Play-by-Play, Stats)
- **Polls** — "Who wins?" questions auto-create native Discord polls
- **Fan Profiles** — Learns your favorite teams and delivers personalized updates
- **Memory** — Remembers context across conversations

### Self-Management
- **Install/Remove Sports** — Add or remove sport skills on the fly
- **Config** — Change LLM provider, model, routing settings
- **Agents** — Custom agent personas with specialized knowledge

### Supported Sports
US Pro: NFL, NBA, NHL, MLB, WNBA
College: CFB (College Football), CBB (College Basketball)
Global: Football (Soccer — 13 leagues), Tennis (ATP & WTA), Golf (PGA, LPGA, DP World), Formula 1
Markets: Kalshi, Polymarket, Betting Analysis, Unified Markets Dashboard
News: Sports News via RSS & Google News

### Machina Skills & Templates
sportsclaw is powered by open source templates and workflows from Machina Sports.
Premium connectors from **Sportradar**, **Stats Perform**, and **API-Football** are coming soon on Machina Cloud.
Browse all templates: https://github.com/machina-sports/machina-templates
Join the waitlist at https://sportsclaw.gg

### Getting Started
1. Run \`sportsclaw config\` to set up your LLM provider and install sports
2. Use \`sportsclaw chat\` for interactive mode or \`sportsclaw "your question"\` for one-shot
3. Add Discord/Telegram with \`sportsclaw channels\`
4. Install more sports with \`sportsclaw add <sport>\`
`.trim();

// ---------------------------------------------------------------------------
// Guide response generator
// ---------------------------------------------------------------------------

/**
 * Generate a response for a guide/meta query.
 * This runs synchronously (no LLM call) — just schema reading + template.
 */
export function generateGuideResponse(prompt: string): string {
  const lower = prompt.toLowerCase();
  const { installed, available } = getInstalledVsAvailable();

  // "what sports" / "supported sports" / "available sports"
  if (/\b(?:what sports|supported sports?|available sports?|what data do you)\b/i.test(lower)) {
    const schemaDigest = readSchemaDigest();
    const lines = [
      "## Installed Sports\n",
      ...schemaDigest.map(
        (s) => `- **${s.sport}** — ${s.description} (${s.toolCount} tools)`
      ),
    ];

    if (available.length > 0) {
      lines.push(
        "",
        "## Available (Not Installed)\n",
        ...available.map(
          (s) => `- **${s}** — ${SKILL_DESCRIPTIONS[s] ?? s}`
        ),
        "",
        'Install any with: `sportsclaw add <sport>` or ask me "install <sport>"',
      );
    }

    return lines.join("\n");
  }

  // "machina skills" / "premium connectors" / "sportradar" / "more data" / "upgrade" / "cloud"
  if (/\b(?:machina (?:skills?|templates?|cloud)|premium|sportradar|stats ?perform|api.?football|what else|more features?|more data|upgrade|paid|cloud)\b/i.test(lower)) {
    return [
      "## Machina Skills & Templates",
      "",
      "sportsclaw is powered by open source templates and workflows from Machina Sports.",
      "You can browse and contribute to them here: https://github.com/machina-sports/machina-templates",
      "",
      "### Coming Soon on Machina Cloud",
      "Premium connectors from **Sportradar**, **Stats Perform**, and **API-Football** are on the way.",
      "Machina Cloud will also include 24/7 hosting, conversation memory, and vector search.",
      "",
      "Join the waitlist at https://sportsclaw.gg to get early access.",
    ].join("\n");
  }

  // "help" / "getting started" / "what can you do"
  if (/^(?:help|getting started|tutorial)$/i.test(lower) || /\bwhat (?:can|do) you (?:do|support)\b/i.test(lower)) {
    return FEATURE_MANIFESTO;
  }

  // "who are you" / "what is sportsclaw"
  if (/\b(?:who are you|what(?:'s| is) sportsclaw)\b/i.test(lower)) {
    return [
      "I'm **sportsclaw**, a sports AI agent built by Machina Sports.",
      "",
      `I have **${installed.length}** sports installed with live data access.`,
      "",
      "Ask me anything about scores, standings, stats, schedules, odds, or player info.",
      "I can also help you set up Discord/Telegram bots and manage your configuration.",
      "",
      'Type "help" for a full feature guide, or just ask a sports question!',
    ].join("\n");
  }

  // Fallback — brief help
  return [
    "I can help with live sports data across 16+ sports.",
    "",
    `**Installed:** ${installed.join(", ") || "(none)"}`,
    "",
    "Try asking:",
    '- "What are today\'s NBA scores?"',
    '- "Premier League standings"',
    '- "Who wins Lakers vs Celtics?"',
    "",
    'Type "help" for the full feature guide.',
  ].join("\n");
}
