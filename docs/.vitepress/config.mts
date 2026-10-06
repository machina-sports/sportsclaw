import { defineConfig } from 'vitepress'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ORIGIN = 'https://sportsclaw.gg'
const REPO = 'https://github.com/machina-sports/sportsclaw'
const DESCRIPTION =
  'The open-source agent engine for live sports — keyless live data, market odds and real-time game events built in. Built by Machina Sports, and the relay inside every Machina project.'

const machinaStar = '<span class="sc-sidebar-star" aria-hidden="true"></span>'
const previewBadge = '<span class="sc-sidebar-badge">preview</span>'

// https://vitepress.dev/reference/site-config
export default defineConfig({
  title: 'sportsclaw',
  description: DESCRIPTION,
  lang: 'en-US',

  // Serves the whole site at sportsclaw.gg/ (see site/Dockerfile + nginx.conf).
  // Legacy /docs/* URLs are 301'd to /* by nginx.
  base: '/',

  srcExclude: ['superpowers/**', 'openshell-research.md', 'README.md', 'HIGHLIGHTS-INTEGRITY.md'],

  cleanUrls: true,
  lastUpdated: true,
  // Dark-first, with a light toggle — same family as sports-skills.sh.
  appearance: 'dark',

  head: [
    ['link', { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' }],
    ['meta', { name: 'theme-color', content: '#050706', media: '(prefers-color-scheme: dark)' }],
    ['meta', { name: 'theme-color', content: '#fbfcfa', media: '(prefers-color-scheme: light)' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:site_name', content: 'sportsclaw' }],
    ['meta', { property: 'og:title', content: 'sportsclaw — build AI that understands live sports' }],
    ['meta', { property: 'og:description', content: DESCRIPTION }],
    ['meta', { property: 'og:url', content: ORIGIN }],
    ['meta', { name: 'twitter:card', content: 'summary' }],
    ['link', { rel: 'preconnect', href: 'https://fonts.googleapis.com' }],
    ['link', { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' }],
    [
      'link',
      {
        rel: 'stylesheet',
        href: 'https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500&display=swap',
      },
    ],
    // Hide reveal targets before first paint (no flash); skipped for reduced-motion.
    [
      'script',
      {},
      "try{if(!matchMedia('(prefers-reduced-motion: reduce)').matches){document.documentElement.classList.add('sc-reveal-ready')}}catch(e){}",
    ],
  ],

  themeConfig: {
    logo: '/logo-mark.svg',
    siteTitle: 'sportsclaw',

    nav: [
      { text: 'Guide', link: '/getting-started/introduction', activeMatch: '^/(getting-started|core-concepts|building-bots|deployment|advanced|hindsight)' },
      { text: 'Machina', link: '/machina/', activeMatch: '^/(machina|sports-data/machina)' },
      { text: 'Sports & Markets', link: '/sports-data/coverage', activeMatch: '^/sports-data/(?!machina)' },
      {
        text: 'Reference',
        items: [
          { text: 'CLI reference', link: '/cli-reference' },
          { text: 'Relay contract', link: '/advanced/relay-contract' },
          { text: 'Good to know', link: '/core-concepts/good-to-know' },
          { text: 'Releases', link: `${REPO}/releases` },
        ],
      },
      { text: 'Contribute', link: '/contributing' },
      { text: 'sports-skills', link: 'https://sports-skills.sh' },
    ],

    sidebar: [
      {
        text: 'Getting Started',
        items: [
          { text: 'Introduction', link: '/getting-started/introduction' },
          { text: 'Quickstart', link: '/getting-started/quickstart' },
          { text: 'Configuration', link: '/getting-started/configuration' },
        ],
      },
      {
        text: 'Core Concepts',
        items: [
          { text: 'How It Works', link: '/core-concepts/how-it-works' },
          { text: 'Read-Only by Default', link: '/core-concepts/safety-and-trading' },
          { text: 'Good to Know', link: '/core-concepts/good-to-know' },
        ],
      },
      {
        text: `${machinaStar}Machina`,
        items: [
          { text: 'sportsclaw in Machina', link: '/machina/' },
          { text: 'Licensed Data & machina-cli', link: '/sports-data/machina' },
          { text: 'Durable Task Delegation', link: '/advanced/durable-loop' },
          { text: 'Relay Contract', link: '/advanced/relay-contract' },
          { text: `Highlight Jobs ${previewBadge}`, link: '/machina/highlights' },
        ],
      },
      {
        text: 'Building Bots',
        items: [
          { text: 'Discord', link: '/building-bots/discord' },
          { text: 'Telegram', link: '/building-bots/telegram' },
          { text: 'Live-Game Alerts', link: '/building-bots/live-game-alerts' },
        ],
      },
      {
        text: 'Sports Data & Markets',
        items: [
          { text: 'Coverage', link: '/sports-data/coverage' },
          { text: 'Odds & Prediction Markets', link: '/sports-data/odds-and-markets' },
          { text: 'Images & Vision', link: '/sports-data/images-and-vision' },
          { text: 'Momentum Certification', link: '/sports-data/momentum-certification' },
        ],
      },
      {
        text: 'Deployment',
        items: [
          { text: 'Docker', link: '/deployment/docker' },
          { text: 'Running as a Daemon', link: '/deployment/daemons' },
          { text: 'NVIDIA OpenShell', link: '/deployment/openshell' },
        ],
      },
      {
        text: 'Advanced',
        items: [
          { text: 'Connecting MCP Servers', link: '/advanced/mcp' },
          { text: 'Hindsight Memory', link: '/hindsight-memory' },
          { text: 'Watchers & Schedules', link: '/advanced/watchers' },
          { text: 'Operator Mode', link: '/advanced/operator' },
        ],
      },
      {
        text: 'Decisions (opt-in)',
        collapsed: true,
        items: [
          { text: 'Capability Routing', link: '/guide/capability-routing' },
          { text: 'Jev Decision Client', link: '/guide/decision-client' },
          { text: 'Decision Relay', link: '/guide/decision-relay' },
          { text: 'Jev Evidence Verification', link: '/guide/jev-evidence-verifier' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'CLI Reference', link: '/cli-reference' },
          { text: 'Contributing', link: '/contributing' },
        ],
      },
    ],

    socialLinks: [
      { icon: 'github', link: REPO },
      { icon: 'discord', link: 'https://discord.gg/CU5KmQWHD9' },
    ],

    editLink: {
      pattern: `${REPO}/edit/main/docs/:path`,
      text: 'Suggest an edit on GitHub',
    },

    outline: { level: [2, 3] },

    search: { provider: 'local' },
  },

  // Machine-readable index for LLM/agent ingestion (served at /llms.txt).
  // Absolute URLs so an agent handed the file can fetch each page directly.
  buildEnd: async (siteConfig) => {
    const pages = siteConfig.pages
      .filter((p) => p !== 'index.md')
      .map((p) => `- ${ORIGIN}/${p.replace(/(^|\/)index\.md$/, '$1').replace(/\.md$/, '')}`)
      .sort()
    const llms = [
      '# sportsclaw',
      '',
      '> The open-source agent engine for live sports: keyless live data, market odds and',
      '> real-time game events built in — for chat bots, broadcast tools and odds trackers.',
      '> Built by Machina Sports; every Machina project ships with its own sportsclaw relay.',
      '',
      '## Getting started',
      `- Install: \`curl -fsSL ${ORIGIN}/install.sh | bash\``,
      `- Quickstart: ${ORIGIN}/getting-started/quickstart`,
      `- sportsclaw in Machina: ${ORIGIN}/machina/`,
      `- Defaults, limits and trade-offs: ${ORIGIN}/core-concepts/good-to-know`,
      '',
      '## Docs',
      ...pages,
      '',
    ].join('\n')
    writeFileSync(join(siteConfig.outDir, 'llms.txt'), llms)
  },
})
