---
layout: home

hero:
  name: "sportsclaw"
  text: "Build AI that understands live sports."
  tagline: "An open-source engine with keyless live data, market odds, and real-time game events built in. Ship chat bots, broadcast widgets, and odds trackers in minutes — not months of data plumbing."
  actions:
    - theme: brand
      text: Get Started
      link: /getting-started/quickstart
    - theme: alt
      text: How It Works
      link: /core-concepts/how-it-works
    - theme: alt
      text: GitHub
      link: https://github.com/machina-sports/sportsclaw
---

<div class="sc-install-wrap">

```sh
curl -fsSL https://sportsclaw.gg/install.sh | bash
```

<p class="sc-install-note">macOS / Linux — verify the published SHA-256 before running. Windows: <code>npm install -g sportsclaw-engine-core</code></p>

</div>

<div class="sc-grid">

<a class="sc-card" href="/core-concepts/how-it-works">
<pre class="motif">┌───────────┐
│ LAL · <b>102</b> │
│ GSW ·  98 │
└───────────┘</pre>
<h3>Answers grounded in real data</h3>
<p>Ask in plain language and get answers backed by live scores, standings, stats, odds, and news across 14 sports. The agent looks it up — it doesn't guess.</p>
</a>

<a class="sc-card" href="/building-bots/discord">
<pre class="motif">╭─────────╮
│ score?  │
╰─────────╯
  ╭─────────╮
  │ <b>LAL 102</b> │
  ╰─────────╯</pre>
<h3>Discord &amp; Telegram bots</h3>
<p>Run a sports bot with rich embeds, buttons, polls, and image replies in one command. Your community asks; the bot answers with the real numbers.</p>
</a>

<a class="sc-card" href="/building-bots/live-game-alerts">
<pre class="motif">   ▟█▙
  ▟███▙
  ▀▀▀▀▀
    <b>●</b></pre>
<h3>It tells you when things happen</h3>
<p>Followers say "alert me about the Lakers" and get a message the moment the game starts, the lead changes, or it ends — no polling, no setup.</p>
</a>

<a class="sc-card" href="/sports-data/odds-and-markets">
<pre class="motif">┌─────────┐
│      ▂▅<b>█</b>│
│   ▂▅    │
│▂▅       │
└─────────┘</pre>
<h3>Live odds &amp; prediction markets</h3>
<p>Pull real-time odds from ESPN, Kalshi, and Polymarket, and run the betting math. Read-only by default — built to track, not trade.</p>
</a>

<a class="sc-card" href="/sports-data/images-and-vision">
<pre class="motif">┌────────┐
│   <b>▁▄</b>   │
│ ▁▄██▄▁ │
└────────┘</pre>
<h3>Generate graphics on the fly</h3>
<p>Ask for a matchday graphic and get one back, delivered straight into the chat. Vision works too — send a screenshot and ask about it.</p>
</a>

<a class="sc-card" href="/getting-started/quickstart">
<pre class="motif">┌────────┐
│ <b>></b> help │
│ <b>></b> _    │
└────────┘</pre>
<h3>Open source, runs anywhere</h3>
<p>MIT-licensed TypeScript. Run it from the CLI, host it as a bot, or deploy in Docker. Bring your own model — Anthropic, OpenAI, Google, reasoning models (gpt-5 / o-series), or your own endpoint (Azure AI Foundry, self-hosted NIM/vLLM).</p>
</a>

<a class="sc-card" href="/advanced/durable-loop">
<pre class="motif">┌─────────┐
│ turn <b>3</b>  │
│ resumes │
└─────────┘</pre>
<h3>Delegate durable, resumable work</h3>
<p>Connect a Machina pod and hand off long, multi-step tasks to its durable loop — it persists every turn and resumes after interruptions, async waits, or restarts, while sportsclaw stays responsive.</p>
</a>

</div>

<div class="sc-section">

## Hand it to your coding agent

Paste this into Claude Code, Cursor, or any coding agent — it reads the machine-readable doc index and builds from there:

```text
Build a sports AI app with sportsclaw. First read https://sportsclaw.gg/llms.txt
for the full doc map, then follow https://sportsclaw.gg/getting-started/quickstart
to install and scaffold. sportsclaw gives you keyless live scores, standings, odds
and markets via sports-skills, plus one-command Discord and Telegram bots. Use the
docs at https://sportsclaw.gg for the CLI, data coverage, and deployment.
```

<p class="sc-section-note"><code>llms.txt</code> lists every doc page as a fetchable URL, so the agent can crawl the whole reference on its own.</p>

</div>

<div class="sc-section">

## Day-one capabilities

Your agent ships with three built-in personas. Each learns from your chat — the more your users interact, the sharper it gets.

<div class="sc-caps">
<div class="sc-cap">
<h4>The Analyst</h4>
<span class="sc-tag">Prediction Markets</span>
<p>Drops odds and value bets into the chat. It learns which sports and markets your audience actually cares about and tailors its alerts.</p>
</div>
<div class="sc-cap">
<h4>The Scoreboard</h4>
<span class="sc-tag">Multi-Sport</span>
<p>Pulls live play-by-play and stats for any game. Over time it anticipates the matchups your audience follows and tracks them proactively.</p>
</div>
<div class="sc-cap">
<h4>The News Desk</h4>
<span class="sc-tag">Scheduled Reports</span>
<p>Curates morning injury reports and headlines, refining its daily feed based on the teams your chat interacts with most.</p>
</div>
</div>

</div>
