import DefaultTheme from 'vitepress/theme'
import type { Theme } from 'vitepress'
import Layout from './Layout.vue'
import HomePage from './components/HomePage.vue'
import MachinaArchitecture from './components/MachinaArchitecture.vue'
import Contributors from './components/Contributors.vue'
import './styles/tokens.css'
import './styles/base.css'
import './styles/home.css'

/* Landing-page reveal: elements marked [data-reveal] fade up as they enter
   the viewport. Docs pages stay static (they are read, not scrolled past).
   The head script in config.mts adds `sc-reveal-ready` before first paint,
   so no-JS and reduced-motion visitors always see everything. */
let observer: IntersectionObserver | undefined

function setupReveal() {
  if (typeof window === 'undefined') return
  const root = document.documentElement
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    root.classList.remove('sc-reveal-ready')
    return
  }
  try {
    observer?.disconnect()
    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          entry.target.classList.add('sc-in')
          observer?.unobserve(entry.target)
        }
      },
      { threshold: 0.12, rootMargin: '0px 0px -6% 0px' },
    )
    document.querySelectorAll('[data-reveal]:not(.sc-in)').forEach((el) => observer!.observe(el))
  } catch {
    root.classList.remove('sc-reveal-ready')
  }
}

const schedule = () => requestAnimationFrame(() => window.setTimeout(setupReveal, 40))

export default {
  extends: DefaultTheme,
  Layout,
  enhanceApp({ app, router }) {
    app.component('HomePage', HomePage)
    app.component('MachinaArchitecture', MachinaArchitecture)
    app.component('Contributors', Contributors)
    if (typeof window === 'undefined') return
    const prev = router.onAfterRouteChanged
    router.onAfterRouteChanged = (to) => {
      prev?.(to)
      schedule()
    }
    schedule()
  },
} satisfies Theme
