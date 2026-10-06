<script setup lang="ts">
import { ref } from 'vue'
import HeroTerminal from './HeroTerminal.vue'
import InstallCommand from './InstallCommand.vue'
import MachinaArchitecture from './MachinaArchitecture.vue'
import MachinaStar from './MachinaStar.vue'
import Contributors from './Contributors.vue'
import { data } from '../project.data'

const icons: Record<string, string> = {
  chat: 'M21 12a8.5 8.5 0 0 1-12.3 7.6L3.5 20.5l1-4.8A8.5 8.5 0 1 1 21 12z',
  bot: 'M5 8h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2zM12 4v4M9 13h.01M15 13h.01M9.5 16.5h5',
  bell: 'M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15zM10 21h4',
  markets: 'M3 17l6-6 4 4 8-8M15 7h6v6',
  broadcast: 'M4.9 19.1a10 10 0 0 1 0-14.2M19.1 4.9a10 10 0 0 1 0 14.2M7.8 16.2a6 6 0 0 1 0-8.4M16.2 7.8a6 6 0 0 1 0 8.4M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z',
  box: 'M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12v9M12 12L4 7.5',
  route: 'M6 3v6a3 3 0 0 0 3 3h6a3 3 0 0 1 3 3v6M6 3l-2.5 2.5M6 3l2.5 2.5M18 21l-2.5-2.5M18 21l2.5-2.5',
  fetch: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6',
  check: 'M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6zM9 12l2 2 4-4',
  answer: 'M4 5h16v11H8l-4 4zM8 9.5h8M8 12.5h5',
  key: 'M8 15a4 4 0 1 1 3.5-6M11 12l8.5-8.5M16 7l2 2M3 3l18 18',
  layers: 'M12 3l9 5-9 5-9-5zM3 13l9 5 9-5',
  memory: 'M6 4h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM8 9h8M8 13h8M8 17h5',
  loop: 'M3.5 12a8.5 8.5 0 0 1 14.7-5.8L21 9M21 3v6h-6M20.5 12a8.5 8.5 0 0 1-14.7 5.8L3 15M3 21v-6h6',
  decide: 'M12 3v4M12 17v4M5 12H3M21 12h-2M7 7l9 10M17 7l-3 3.4',
  film: 'M3 5h18v14H3zM7 5v14M17 5v14M3 9.5h4M3 14.5h4M17 9.5h4M17 14.5h4',
  github:
    'M12 .7a11.5 11.5 0 0 0-3.6 22.4c.6.1.8-.3.8-.6v-2c-3.2.7-3.9-1.4-3.9-1.4-.5-1.3-1.3-1.7-1.3-1.7-1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.7 1.3 3.4 1 .1-.8.4-1.3.7-1.6-2.6-.3-5.2-1.3-5.2-5.7 0-1.3.5-2.3 1.2-3.1-.1-.3-.5-1.5.1-3.1 0 0 1-.3 3.2 1.2a11 11 0 0 1 5.8 0c2.2-1.5 3.2-1.2 3.2-1.2.6 1.6.2 2.8.1 3.1.7.8 1.2 1.8 1.2 3.1 0 4.4-2.7 5.4-5.3 5.7.4.4.8 1.1.8 2.2v3.2c0 .3.2.7.8.6A11.5 11.5 0 0 0 12 .7z',
}

const stats = [
  { value: '14', label: 'sports out of the box' },
  { value: '6', label: 'market & utility modules' },
  { value: '0', label: 'API keys for data' },
  { value: '5', label: 'model providers' },
  { value: data.mergedPrs ? String(data.mergedPrs) : '170+', label: 'merged pull requests' },
  { value: '1', label: 'relay in every Machina project', machina: true },
]

const builds = [
  {
    icon: 'chat',
    title: 'Answers grounded in real data',
    text: 'Ask in plain language. Scores, standings, stats, odds and news come from live lookups across 14 sports — the model decides what to fetch, never what the numbers are.',
    href: '/core-concepts/how-it-works',
  },
  {
    icon: 'bot',
    title: 'Discord & Telegram bots',
    text: 'One command runs a community bot with rich embeds, buttons, polls, generated graphics and image understanding. Every deployed bot is read-only for markets.',
    href: '/building-bots/discord',
  },
  {
    icon: 'bell',
    title: 'Live-game alerts',
    text: '“Alert me about the Lakers” is the whole setup. Followers get a message at tip-off, on lead changes and at the final — no polling code to write.',
    href: '/building-bots/live-game-alerts',
  },
  {
    icon: 'markets',
    title: 'Odds & prediction markets',
    text: 'ESPN, Kalshi and Polymarket in one query, with de-vig, edge, Kelly and arbitrage math built in. Built to track markets, not to trade them.',
    href: '/sports-data/odds-and-markets',
  },
  {
    icon: 'broadcast',
    title: 'Always-on operators',
    text: 'Operator mode wakes on a schedule, decides whether anything is worth saying, and publishes on its own — the base for broadcast and studio agents.',
    href: '/advanced/operator',
  },
  {
    icon: 'box',
    title: 'Embed it, ship it, bring any model',
    text: 'Import the engine into your TypeScript app, run it in Docker or behind the relay API. Anthropic, OpenAI, Google, Azure Foundry or any OpenAI-compatible endpoint.',
    href: '/getting-started/configuration',
  },
]

const steps = [
  {
    icon: 'route',
    title: 'Route',
    text: 'A fast router reads the question and picks the one or two skills that matter, so the model only sees tools it actually needs.',
    code: 'route → football · polymarket',
  },
  {
    icon: 'fetch',
    title: 'Fetch',
    text: 'sports-skills runs deterministic Python against ESPN, FastF1, Kalshi, Polymarket and more. Identical calls hit a turn cache; huge results are queried, not truncated.',
    code: 'football_get_season_standings(…)',
  },
  {
    icon: 'check',
    title: 'Check',
    text: 'A fact-check compares the draft with the raw tool output and records any discrepancy in the run trace. If a tool failed, the answer is held to the data that came back.',
    code: 'verification: kept | flagged',
  },
  {
    icon: 'answer',
    title: 'Answer',
    text: 'One sourced answer, wherever the question came from: your terminal, a bot, the relay API, or your own app. Add --json for NDJSON.',
    code: 'sportsclaw "…" --json',
  },
]

const lives = {
  open: [
    'CLI one-shots and chat, Discord and Telegram bots, Docker, or a library import',
    'Keyless data from sports-skills — no ESPN key, no paid feeds',
    'Memory in local files (or a Hindsight server), per user and agent',
    'Your model key, or your existing Claude Code login',
  ],
  machina: [
    'A relay is provisioned with every project, next to its API, workers and MCP server',
    "Reads the project's MCP tools — licensed feeds, documents, workflows — with the project token",
    'Memory defaults to project documents — fan profile, reflections, history — isolated per user and agent',
    'Serves Machina products over an authenticated HTTP API — Factory queries it for live data while it builds apps',
  ],
}

const contributions = [
  {
    icon: 'key',
    title: 'Live data, zero setup',
    text: 'Every project starts with 17 sports and market skills that need no data credentials.',
    status: 'live',
  },
  {
    icon: 'layers',
    title: 'Licensed feeds, same agent',
    text: 'The project’s MCP tools sit next to the keyless skills. When a public feed runs out, an upgrade signal points to the licensed path — once, never as a nag.',
    status: 'live',
  },
  {
    icon: 'memory',
    title: 'Pod memory',
    text: 'With a Machina server connected, memory defaults to project documents — SOUL, fan profile, reflections, strategy — isolated per user and agent.',
    status: 'live',
  },
  {
    icon: 'loop',
    title: 'Durable delegation',
    text: 'Long, multi-step work goes to the project’s loop-runner. Every turn is a document; a turn only closes after a code check and an independent evaluator.',
    status: 'rolling out',
    href: '/advanced/durable-loop',
  },
  {
    icon: 'decide',
    title: 'Typed decisions',
    text: '/api/decide answers bounded Choice, Score and Noul questions in one authenticated call. Disabled by default.',
    status: 'opt-in',
    href: '/guide/decision-relay',
  },
  {
    icon: 'film',
    title: 'Highlight clipping',
    text: 'Play-by-play turned into clip windows: rights-gated, bounded async jobs with SHA-256 receipts for every clip.',
    status: 'preview',
    href: '/machina/highlights',
  },
]

const nuances = [
  {
    title: 'Track, not trade',
    text: 'Order, wallet and balance tools are blocked before they reach the model and again before execution. Bots and servers are hard read-only.',
    href: '/core-concepts/safety-and-trading',
  },
  {
    title: 'Keyless isn’t licensed',
    text: 'The open skills ride public APIs meant for personal, non-commercial use. Production workloads need licensed data.',
    href: '/sports-data/machina',
  },
  {
    title: 'Flags, not rewrites',
    text: 'On our own benchmark, auto-correcting drafts broke more right answers than it fixed. The default fact-check now flags instead of rewriting.',
    href: '/core-concepts/good-to-know#the-fact-check-flags-it-doesn-t-rewrite',
  },
  {
    title: 'MCP means every tool',
    text: 'A connected MCP server exposes all of its tools — writes included — unless you pin a tools allowlist.',
    href: '/advanced/mcp',
  },
  {
    title: 'Side effects need a yes',
    text: 'Writing files, running shell commands and starting durable sessions wait for explicit approval.',
    href: '/core-concepts/safety-and-trading#approvals-for-everything-else',
  },
  {
    title: 'Opt-in stays opt-in',
    text: 'Jev routing and verification, OpenShell sandboxing and Hindsight memory are off by default. Cloud transfer needs explicit consent.',
    href: '/core-concepts/good-to-know#opt-in-means-opt-in',
  },
  {
    title: 'Limits are per relay',
    text: '20,000-character prompts, 4 concurrent queries, 300 s max timeout — per relay instance, not distributed quotas.',
    href: '/advanced/relay-contract',
  },
  {
    title: 'Relays follow releases',
    text: 'Relay features ship with relay-v* releases. /api/capabilities reports the engine, skills and limits a relay actually runs.',
    href: '/core-concepts/good-to-know#relays-follow-releases',
  },
]

const agentPrompt = `Build a sports AI app with sportsclaw. First read https://sportsclaw.gg/llms.txt
for the full doc map, then follow https://sportsclaw.gg/getting-started/quickstart
to install and scaffold. sportsclaw gives you keyless live scores, standings, odds
and markets via sports-skills, plus one-command Discord and Telegram bots. Use the
docs at https://sportsclaw.gg for the CLI, data coverage, and deployment.`

const copied = ref(false)
async function copyPrompt() {
  try {
    await navigator.clipboard.writeText(agentPrompt)
    copied.value = true
    window.setTimeout(() => (copied.value = false), 1600)
  } catch {
    /* clipboard unavailable — the prompt stays selectable */
  }
}
</script>

<template>
  <div class="sc-home">
    <!-- ── Hero ─────────────────────────────────────────────────────── -->
    <section class="sc-hero">
      <div class="sc-hero-bg" aria-hidden="true">
        <div class="sc-hero-glow" />
        <svg class="sc-hero-pitch" viewBox="0 0 1500 700" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="40" y="40" width="1420" height="620" rx="4" />
          <path d="M750 40v620" />
          <circle cx="750" cy="350" r="92" />
          <circle cx="750" cy="350" r="4" fill="currentColor" />
          <path d="M40 190h190v320H40M1460 190h-190v320h190M40 270h70v160H40M1460 270h-70v160h70" />
          <path d="M230 285a92 92 0 0 1 0 130M1270 285a92 92 0 0 0 0 130" />
        </svg>
      </div>
      <div class="sc-wrap sc-hero-grid">
        <div class="sc-hero-copy">
          <a class="sc-pill" href="https://github.com/machina-sports/sportsclaw/releases" target="_blank" rel="noopener">
            <span class="sc-pill-tag">{{ data.latestTag ?? `v${data.version}` }}</span>
            <span class="sc-pill-text">Open source · MIT · built by Machina Sports</span>
            <svg class="sc-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
          </a>
          <h1 class="sc-h1">Build AI that understands <span class="sc-h1-accent">live sports.</span></h1>
          <p class="sc-lead">
            sportsclaw is an open-source agent engine with keyless live data, market odds and real-time game
            events built in. Run it in your terminal, ship it as a bot — or use it inside
            <a href="/machina/" class="sc-inline-machina">Machina</a>, where every project ships with its own
            sportsclaw relay.
          </p>
          <InstallCommand />
          <div class="sc-ctas">
            <a class="sc-btn sc-btn-volt" href="/getting-started/quickstart">
              Get started
              <svg class="sc-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
            </a>
            <a class="sc-btn" href="/machina/"><MachinaStar /> How it runs in Machina</a>
            <a class="sc-btn sc-btn-ghost" href="https://github.com/machina-sports/sportsclaw" target="_blank" rel="noopener">
              <svg class="sc-ico sc-ico-fill" viewBox="0 0 24 24" aria-hidden="true"><path :d="icons.github" /></svg>
              GitHub
            </a>
          </div>
        </div>
        <HeroTerminal />
      </div>
    </section>

    <!-- ── Stats ────────────────────────────────────────────────────── -->
    <section class="sc-wrap" aria-label="sportsclaw at a glance">
      <dl class="sc-stats" data-reveal>
        <div v-for="s in stats" :key="s.label" :class="{ 'is-machina': s.machina }">
          <dd>{{ s.value }}</dd>
          <dt>{{ s.label }}</dt>
        </div>
      </dl>
    </section>

    <!-- ── What you can build ───────────────────────────────────────── -->
    <section id="build" class="sc-section">
      <div class="sc-wrap">
        <header class="sc-head" data-reveal>
          <span class="sc-eyebrow">What you can build</span>
          <h2>Everything a sports agent needs, already wired.</h2>
          <p>The data, the live game events and the real-time plumbing ship in the box, so you spend your time on the experience instead of stitching feeds together.</p>
        </header>
        <div class="sc-cards">
          <a v-for="b in builds" :key="b.title" class="sc-card" :href="b.href" data-reveal>
            <span class="sc-card-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path :d="icons[b.icon]" /></svg></span>
            <h3>{{ b.title }}</h3>
            <p>{{ b.text }}</p>
            <span class="sc-card-more">Read more <span aria-hidden="true">→</span></span>
          </a>
        </div>
      </div>
    </section>

    <!-- ── How it works ─────────────────────────────────────────────── -->
    <section id="how" class="sc-section">
      <div class="sc-wrap">
        <header class="sc-head" data-reveal>
          <span class="sc-eyebrow">How it works</span>
          <h2>Grounded, not guessed.</h2>
          <p>An LLM on its own will happily invent a score. sportsclaw doesn't let it answer from memory for anything it can look up — every number comes from a real data call.</p>
        </header>
        <ol class="sc-steps">
          <li v-for="(s, i) in steps" :key="s.title" class="sc-step" data-reveal>
            <div class="sc-step-top">
              <span class="sc-step-n">{{ String(i + 1).padStart(2, '0') }}</span>
              <span class="sc-step-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path :d="icons[s.icon]" /></svg></span>
            </div>
            <h3>{{ s.title }}</h3>
            <p>{{ s.text }}</p>
            <code>{{ s.code }}</code>
          </li>
        </ol>
      </div>
    </section>

    <!-- ── Machina ──────────────────────────────────────────────────── -->
    <section id="machina" class="sc-section sc-section-machina">
      <div class="sc-wrap">
        <header class="sc-head" data-reveal>
          <span class="sc-eyebrow is-machina"><MachinaStar /> sportsclaw × Machina</span>
          <h2>The open-source side of Machina.</h2>
          <p>
            Machina Sports builds and runs sportsclaw. The engine you install is the same one the platform
            deploys inside every project — so what you prototype on a laptop is what runs in production, with
            licensed data and durable workflows on top.
          </p>
        </header>

        <div class="sc-lives">
          <article class="sc-life" data-reveal>
            <span class="sc-life-tag">Standalone · open source</span>
            <h3>On your machine, in your community</h3>
            <ul>
              <li v-for="l in lives.open" :key="l">{{ l }}</li>
            </ul>
            <code class="sc-life-cmd">curl -fsSL https://sportsclaw.gg/install.sh | bash</code>
          </article>
          <article class="sc-life is-machina" data-reveal>
            <span class="sc-life-tag">Inside Machina · every project</span>
            <h3>Part of the platform, wired to the project</h3>
            <ul>
              <li v-for="l in lives.machina" :key="l">{{ l }}</li>
            </ul>
            <code class="sc-life-cmd">sportsclaw machina connect</code>
          </article>
        </div>

        <div class="sc-arch-wrap" data-reveal>
          <MachinaArchitecture />
        </div>

        <h3 class="sc-subhead" data-reveal>What the claw brings to a Machina project</h3>
        <div class="sc-tiles">
          <component
            :is="c.href ? 'a' : 'div'"
            v-for="c in contributions"
            :key="c.title"
            class="sc-tile"
            :href="c.href"
            data-reveal
          >
            <div class="sc-tile-top">
              <span class="sc-tile-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path :d="icons[c.icon]" /></svg></span>
              <span class="sc-status" :class="'is-' + c.status.replace(' ', '-')">{{ c.status }}</span>
            </div>
            <h4>{{ c.title }}</h4>
            <p>{{ c.text }}</p>
          </component>
        </div>

        <div class="sc-compare" data-reveal>
          <table>
            <thead>
              <tr>
                <th scope="col"><span class="sr-only">Aspect</span></th>
                <th scope="col">Open source</th>
                <th scope="col" class="is-machina">With Machina</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">Data</th>
                <td>Public APIs, keyless — ESPN, FastF1, Kalshi, Polymarket…</td>
                <td>Adds licensed, real-time feeds through the project's MCP server</td>
              </tr>
              <tr>
                <th scope="row">Best for</th>
                <td>Personal use, prototypes, community bots</td>
                <td>Commercial production, with SLAs and support</td>
              </tr>
              <tr>
                <th scope="row">Memory</th>
                <td>Local files, or a Hindsight server</td>
                <td>Project documents, isolated per user and agent</td>
              </tr>
              <tr>
                <th scope="row">Long tasks</th>
                <td>In-process, one turn at a time</td>
                <td>Durable loop on the project, resumable</td>
              </tr>
              <tr>
                <th scope="row">Setup</th>
                <td><code>curl … | bash</code></td>
                <td><code>sportsclaw machina connect</code> — or nothing, inside a project</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="sc-ctas sc-ctas-center" data-reveal>
          <a class="sc-btn sc-btn-machina" href="/machina/">
            Read: sportsclaw in Machina
            <svg class="sc-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
          </a>
          <a class="sc-btn sc-btn-ghost" href="https://machina.gg" target="_blank" rel="noopener">machina.gg ↗</a>
        </div>
      </div>
    </section>

    <!-- ── Good to know ─────────────────────────────────────────────── -->
    <section id="nuances" class="sc-section">
      <div class="sc-wrap">
        <header class="sc-head" data-reveal>
          <span class="sc-eyebrow">Good to know</span>
          <h2>Defaults that keep it honest.</h2>
          <p>The trade-offs are deliberate. Here's what sportsclaw will and won't do — and where each rule is enforced.</p>
        </header>
        <div class="sc-nuances">
          <a v-for="n in nuances" :key="n.title" class="sc-nuance" :href="n.href" data-reveal>
            <h3>{{ n.title }}</h3>
            <p>{{ n.text }}</p>
          </a>
        </div>
        <p class="sc-section-foot" data-reveal>
          All of it, with the details: <a href="/core-concepts/good-to-know">Good to know: defaults, limits and trade-offs →</a>
        </p>
      </div>
    </section>

    <!-- ── Contribute ───────────────────────────────────────────────── -->
    <section id="contribute" class="sc-section">
      <div class="sc-wrap">
        <header class="sc-head" data-reveal>
          <span class="sc-eyebrow">Built in the open</span>
          <h2>Contributions welcome.</h2>
          <p>
            sportsclaw is developed in public. Engine fixes, new bot surfaces, benchmark cases and docs all land
            through pull requests on GitHub — the same way the Machina team ships.
          </p>
        </header>
        <div data-reveal>
          <Contributors />
        </div>
        <div class="sc-contrib-steps">
          <div class="sc-contrib-step" data-reveal>
            <span class="sc-step-n">01</span>
            <h3>Set up</h3>
            <pre><code>git clone https://github.com/machina-sports/sportsclaw
cd sportsclaw &amp;&amp; npm install</code></pre>
          </div>
          <div class="sc-contrib-step" data-reveal>
            <span class="sc-step-n">02</span>
            <h3>Build &amp; test</h3>
            <pre><code>npm run build   # tsc, strict
npm test        # node:test suite</code></pre>
            <p>CI runs both plus a smoke test that needs no API key.</p>
          </div>
          <div class="sc-contrib-step" data-reveal>
            <span class="sc-step-n">03</span>
            <h3>Open a PR</h3>
            <p>Kebab-case files, explicit <code>.js</code> imports, and no invented feeds — if it isn't in sports-skills, the agent can't claim it.</p>
          </div>
        </div>
        <div class="sc-where" data-reveal>
          <div>
            <strong>Engine, bots, relay, CLI</strong>
            <span>machina-sports/sportsclaw</span>
          </div>
          <div>
            <strong>A new sport or data endpoint</strong>
            <span>machina-sports/sports-skills — sportsclaw picks it up automatically</span>
          </div>
          <div>
            <strong>These docs</strong>
            <span><code>npm run docs:dev</code> · files in <code>docs/</code></span>
          </div>
        </div>
        <div class="sc-ctas" data-reveal>
          <a class="sc-btn sc-btn-volt" href="/contributing">
            Contributing guide
            <svg class="sc-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
          </a>
          <a class="sc-btn sc-btn-ghost" href="https://github.com/machina-sports/sportsclaw/issues" target="_blank" rel="noopener">Open issues ↗</a>
        </div>
        <p class="sc-thanks" data-reveal>
          Standing on the shoulders of
          <a href="https://github.com/nanocoai/nanoclaw" target="_blank" rel="noopener">NanoClaw</a>,
          <a href="https://github.com/openclaw/openclaw" target="_blank" rel="noopener">OpenClaw</a>,
          <a href="https://github.com/NVIDIA/NemoClaw" target="_blank" rel="noopener">NemoClaw</a>,
          <a href="https://pi.dev" target="_blank" rel="noopener">pi.dev</a>,
          the <a href="https://ai-sdk.dev" target="_blank" rel="noopener">Vercel AI SDK</a> and
          <a href="https://github.com/bombshell-dev/clack" target="_blank" rel="noopener">Clack</a>.
        </p>
      </div>
    </section>

    <!-- ── Agent prompt ─────────────────────────────────────────────── -->
    <section id="agents" class="sc-section">
      <div class="sc-wrap sc-agent">
        <header class="sc-head" data-reveal>
          <span class="sc-eyebrow">For coding agents</span>
          <h2>Hand it to your coding agent.</h2>
          <p>
            Paste this into Claude Code, Cursor or any coding agent. <code>/llms.txt</code> lists every doc page
            as a fetchable URL, so the agent can read the whole reference on its own.
          </p>
        </header>
        <div class="sc-prompt" data-reveal>
          <div class="sc-prompt-bar">
            <span>prompt.txt</span>
            <button type="button" @click="copyPrompt">{{ copied ? 'Copied' : 'Copy' }}</button>
          </div>
          <pre><code>{{ agentPrompt }}</code></pre>
        </div>
      </div>
    </section>

    <!-- ── Final CTA ────────────────────────────────────────────────── -->
    <section class="sc-final">
      <div class="sc-wrap" data-reveal>
        <h2>Start in your terminal. <span>Grow on Machina.</span></h2>
        <div class="sc-ctas sc-ctas-center">
          <a class="sc-btn sc-btn-volt" href="/getting-started/quickstart">
            Get started
            <svg class="sc-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
          </a>
          <a class="sc-btn" href="https://machina.gg" target="_blank" rel="noopener"><MachinaStar /> Talk to Machina</a>
        </div>
      </div>
    </section>
  </div>
</template>
