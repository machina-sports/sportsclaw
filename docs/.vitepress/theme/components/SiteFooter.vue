<script setup lang="ts">
import { useSidebar } from 'vitepress/theme'
import MachinaLogo from './MachinaLogo.vue'
import pkg from '../../../../package.json'

const { hasSidebar } = useSidebar()
const year = new Date().getFullYear()

const columns = [
  {
    title: 'sportsclaw',
    links: [
      { text: 'Quickstart', href: '/getting-started/quickstart' },
      { text: 'How it works', href: '/core-concepts/how-it-works' },
      { text: 'Good to know', href: '/core-concepts/good-to-know' },
      { text: 'CLI reference', href: '/cli-reference' },
      { text: 'llms.txt', href: '/llms.txt', external: true },
    ],
  },
  {
    title: 'Machina',
    links: [
      { text: 'sportsclaw in Machina', href: '/machina/' },
      { text: 'Licensed data & machina-cli', href: '/sports-data/machina' },
      { text: 'machina.gg', href: 'https://machina.gg', external: true },
      { text: 'Platform docs', href: 'https://docs.machina.gg', external: true },
      { text: 'sports-skills.sh', href: 'https://sports-skills.sh', external: true },
    ],
  },
  {
    title: 'Community',
    links: [
      { text: 'Contributing', href: '/contributing' },
      { text: 'GitHub', href: 'https://github.com/machina-sports/sportsclaw', external: true },
      { text: 'Releases', href: 'https://github.com/machina-sports/sportsclaw/releases', external: true },
      { text: 'npm', href: 'https://www.npmjs.com/package/sportsclaw-engine-core', external: true },
      { text: 'Discord', href: 'https://discord.gg/CU5KmQWHD9', external: true },
    ],
  },
]
</script>

<template>
  <footer class="sc-footer" :class="{ 'has-sidebar': hasSidebar }">
    <div class="sc-footer-inner">
      <div class="sc-footer-grid">
        <div class="sc-footer-brand">
          <a href="https://machina.gg" target="_blank" rel="noopener" class="sc-footer-logo" aria-label="Machina Sports — machina.gg">
            <MachinaLogo />
          </a>
          <p>
            sportsclaw is built and maintained in the open by
            <a href="https://machina.gg" target="_blank" rel="noopener">Machina Sports</a>,
            the AI agent platform for sports. Every Machina project ships with its own sportsclaw relay.
          </p>
        </div>
        <nav v-for="col in columns" :key="col.title" class="sc-footer-col" :aria-label="col.title">
          <h4>{{ col.title }}</h4>
          <ul>
            <li v-for="l in col.links" :key="l.text">
              <a
                :href="l.href"
                :target="l.external ? '_blank' : undefined"
                :rel="l.external ? 'noopener' : undefined"
              >{{ l.text }}<span v-if="l.external" class="sc-ext" aria-hidden="true">↗</span></a>
            </li>
          </ul>
        </nav>
      </div>
      <div class="sc-footer-bottom">
        <span>© {{ year }} Machina Sports · MIT licensed</span>
        <span class="sc-footer-version">sportsclaw-engine-core v{{ pkg.version }}</span>
      </div>
    </div>
  </footer>
</template>

<style scoped>
.sc-footer {
  position: relative;
  z-index: var(--vp-z-index-footer, 10);
  border-top: 1px solid var(--sc-line);
  background: var(--sc-bg-2);
  padding: 56px 24px 36px;
}
@media (min-width: 960px) {
  .sc-footer.has-sidebar {
    padding-left: calc(var(--vp-sidebar-width) + 32px);
  }
}
@media (min-width: 1440px) {
  .sc-footer.has-sidebar {
    padding-left: calc((100vw - var(--vp-layout-max-width)) / 2 + var(--vp-sidebar-width) + 32px);
  }
}
.sc-footer-inner {
  max-width: 1200px;
  margin: 0 auto;
}
.sc-footer.has-sidebar .sc-footer-inner {
  max-width: 1040px;
  margin: 0;
}
.sc-footer-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.5fr) repeat(3, minmax(0, 1fr));
  gap: 36px 32px;
}
@media (max-width: 860px) {
  .sc-footer-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .sc-footer-brand {
    grid-column: 1 / -1;
  }
}
@media (max-width: 340px) {
  .sc-footer-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
.sc-footer-logo {
  display: inline-block;
  color: var(--sc-logo-ink);
  transition: opacity 0.15s ease;
}
.sc-footer-logo:hover {
  opacity: 0.85;
}
.sc-footer-logo :deep(.machina-logo) {
  display: block;
  height: 46px;
  width: auto;
}
.sc-footer-brand p {
  margin-top: 18px;
  max-width: 40ch;
  font-size: 14px;
  line-height: 1.65;
  color: var(--sc-text-3);
}
.sc-footer-brand p a {
  color: var(--sc-text-2);
  text-decoration: underline;
  text-decoration-color: var(--sc-line-2);
  text-underline-offset: 3px;
}
.sc-footer-brand p a:hover {
  color: var(--sc-text);
}
.sc-footer-col h4 {
  margin-bottom: 14px;
  font-family: var(--sc-mono);
  font-size: 11.5px;
  font-weight: 500;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--sc-text-3);
}
.sc-footer-col ul {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 9px;
}
.sc-footer-col a {
  font-size: 14px;
  color: var(--sc-text-2);
  transition: color 0.15s ease;
}
.sc-footer-col a:hover {
  color: var(--sc-text);
}
.sc-ext {
  margin-left: 4px;
  font-size: 11px;
  color: var(--sc-text-3);
}
.sc-footer-bottom {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 8px 16px;
  margin-top: 44px;
  padding-top: 22px;
  border-top: 1px solid var(--sc-line);
  font-family: var(--sc-mono);
  font-size: 12px;
  color: var(--sc-text-3);
}
</style>
