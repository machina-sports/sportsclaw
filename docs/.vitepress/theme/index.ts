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
   Content is visible by default: only elements that are still below the fold
   when the observer is attached get `sc-reveal-pending` (hidden), and they
   lose it as they scroll in. Nodes re-rendered by hydration or a route change
   never carry the class, so a missed observation can't leave a blank page.
   No-JS and reduced-motion visitors always see everything. */
let observer: IntersectionObserver | undefined

function revealAll() {
  document.querySelectorAll('.sc-reveal-pending').forEach((el) => el.classList.remove('sc-reveal-pending'))
}

function setupReveal() {
  if (typeof window === 'undefined') return
  const root = document.documentElement
  observer?.disconnect()
  revealAll()
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    root.classList.remove('sc-reveal-ready')
    return
  }
  try {
    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          entry.target.classList.remove('sc-reveal-pending')
          observer?.unobserve(entry.target)
        }
      },
      { threshold: 0, rootMargin: '0px 0px -6% 0px' },
    )
    const fold = window.innerHeight
    document.querySelectorAll('[data-reveal]').forEach((el) => {
      // Already on screen (or scrolled past): leave it visible, no flash.
      if (el.getBoundingClientRect().top < fold) return
      el.classList.add('sc-reveal-pending')
      observer!.observe(el)
    })
  } catch {
    root.classList.remove('sc-reveal-ready')
    revealAll()
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
