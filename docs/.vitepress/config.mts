import { defineConfig } from 'vitepress'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

// https://vitepress.dev/reference/site-config
export default defineConfig({
  title: 'sportsclaw',
  description:
    'Build AI that understands live sports. One open-source engine with keyless live data, market odds, and real-time game events built in.',
  lang: 'en-US',

  // Serves the whole site at sportsclaw.gg/ (see site/Dockerfile + nginx.conf).
  // Legacy /docs/* URLs are 301'd to /* by nginx.
  base: '/',

  srcExclude: ['superpowers/**', 'openshell-research.md', 'README.md'],

  cleanUrls: true,
  lastUpdated: true,
  appearance: false, // light-only — the linen canvas is the design

  head: [
    ['link', { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' }],
    ['meta', { name: 'theme-color', content: '#fafffa' }],
    ['link', { rel: 'preconnect', href: 'https://fonts.googleapis.com' }],
    ['link', { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' }],
    [
      'link',
      {
        rel: 'stylesheet',
        href: 'https://fonts.googleapis.com/css2?family=Inter+Tight:wght@400;500;600;700&family=Inter:wght@300;400;500;600&family=JetBrains+Mono:wght@400;500&display=swap',
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
    siteTitle: 'sportsclaw',

    nav: [
      { text: 'Guide', link: '/getting-started/introduction' },
      { text: 'Sports & Markets', link: '/sports-data/coverage' },
      { text: 'CLI Reference', link: '/cli-reference' },
      { text: 'sports-skills', link: 'https://sports-skills.sh' },
      {
        text: 'GitHub',
        link: 'https://github.com/machina-sports/sportsclaw',
      },
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
          { text: 'Machina (Premium)', link: '/sports-data/machina' },
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
          { text: 'Watchers & Schedules', link: '/advanced/watchers' },
          { text: 'Operator Mode', link: '/advanced/operator' },
        ],
      },
      {
        text: 'Reference',
        items: [{ text: 'CLI Reference', link: '/cli-reference' }],
      },
    ],

    socialLinks: [
      { icon: 'github', link: 'https://github.com/machina-sports/sportsclaw' },
    ],

    search: { provider: 'local' },

    editLink: {
      pattern: 'https://github.com/machina-sports/sportsclaw/edit/main/docs/:path',
      text: 'Edit this page on GitHub',
    },

    footer: {
      message: 'Open source under the MIT License.',
      copyright: 'sportsclaw',
    },
  },

  // Machine-readable index for LLM/agent ingestion (served at /llms.txt).
  // Absolute URLs so an agent handed the file can fetch each page directly.
  buildEnd: async (siteConfig) => {
    const origin = 'https://sportsclaw.gg'
    const pages = siteConfig.pages
      .filter((p) => p !== 'index.md')
      .map((p) => `- ${origin}/${p.replace(/\.md$/, '')}`)
      .sort()
    const llms = [
      '# sportsclaw',
      '',
      '> Build AI that understands live sports. An open-source engine with keyless live data,',
      '> market odds, and real-time game events built in — for chat bots, broadcast widgets,',
      '> and odds trackers.',
      '',
      '## Getting started',
      `- Install: \`curl -fsSL ${origin}/install.sh | bash\``,
      `- Quickstart: ${origin}/getting-started/quickstart`,
      '',
      '## Docs',
      ...pages,
      '',
    ].join('\n')
    writeFileSync(join(siteConfig.outDir, 'llms.txt'), llms)
  },
})
