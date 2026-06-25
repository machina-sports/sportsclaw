import DefaultTheme from 'vitepress/theme'
import type { Theme } from 'vitepress'
import './custom.css'
import './reveal.css'

let observer: IntersectionObserver | undefined

const DOC_SELECTOR = [
  '.vp-doc > h1',
  '.vp-doc h2',
  '.vp-doc h3',
  '.vp-doc p',
  '.vp-doc ul',
  '.vp-doc ol',
  '.vp-doc blockquote',
  '.vp-doc table',
  '.vp-doc .custom-block',
  '.vp-doc div[class*="language-"]',
].join(',')

function reveal(el: Element) {
  el.classList.add('sc-in')
  // The home grid cards hide their own children via shared CSS; reveal them too.
  if (el.classList.contains('sc-card')) {
    el.querySelectorAll('.motif, h3, p').forEach((c) => c.classList.add('sc-in'))
  }
}

function setupReveal() {
  if (typeof window === 'undefined') return
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return

  try {
    document.documentElement.classList.add('sc-reveal-ready')
    if (observer) observer.disconnect()

    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            reveal(entry.target)
            observer?.unobserve(entry.target)
          }
        }
      },
      { threshold: 0.1, rootMargin: '0px 0px -6% 0px' },
    )

    const isHome = !!document.querySelector('.VPHome')

    if (isHome) {
      const hero = Array.from(
        document.querySelectorAll(
          '.VPHomeHero .name, .VPHomeHero .text, .VPHomeHero .tagline, .VPHomeHero .actions',
        ),
      )
      const cards = Array.from(document.querySelectorAll('.sc-grid .sc-card'))
      hero.forEach((el, i) => {
        ;(el as HTMLElement).style.transitionDelay = `${i * 90}ms`
        observer!.observe(el)
      })
      cards.forEach((el, i) => {
        ;(el as HTMLElement).style.transitionDelay = `${(i % 3) * 80}ms`
        observer!.observe(el)
      })
    } else {
      document.querySelectorAll(DOC_SELECTOR).forEach((el) => observer!.observe(el))
    }
  } catch {
    document.documentElement.classList.remove('sc-reveal-ready')
  }
}

const schedule = () =>
  requestAnimationFrame(() => window.setTimeout(setupReveal, 60))

export default {
  extends: DefaultTheme,
  enhanceApp({ router }) {
    if (typeof window === 'undefined') return
    const prev = router.onAfterRouteChanged
    router.onAfterRouteChanged = (to) => {
      prev?.(to)
      schedule()
    }
    schedule()
  },
} satisfies Theme
