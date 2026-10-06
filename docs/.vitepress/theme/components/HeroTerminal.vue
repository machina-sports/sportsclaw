<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

/* A stylized sportsclaw session. Tool names and arguments are the real
   sports-skills calls; the "ask" scene is a recorded example run (ESPN +
   Polymarket, 6 Oct 2026), the "edge" numbers come straight from
   betting.evaluate_bet, and the alert lines are the formats documented in
   Live-Game Alerts. */

type Line =
  | { kind: 'ask'; text: string }
  | { kind: 'route'; skills: string[] }
  | { kind: 'call'; tool: string; args: string }
  | { kind: 'check'; text: string }
  | { kind: 'answer'; html: string }
  | { kind: 'blocked'; text: string }
  | { kind: 'event'; icon: string; text: string }
  | { kind: 'meta'; text: string }

interface Scene {
  id: string
  label: string
  meta: string
  lines: Line[]
}

const scenes: Scene[] = [
  {
    id: 'ask',
    label: 'Ask',
    meta: 'example run · 6 Oct 2026',
    lines: [
      { kind: 'ask', text: "Who's top of the Premier League, and how does Polymarket price United v Spurs?" },
      { kind: 'route', skills: ['football', 'polymarket'] },
      { kind: 'call', tool: 'football_get_season_standings', args: 'season_id: premier-league-2026' },
      { kind: 'call', tool: 'polymarket_search_markets', args: 'query: "Premier League" · sport: epl' },
      { kind: 'check', text: 'fact-check · kept' },
      {
        kind: 'answer',
        html: 'Man City top the 2026-27 table on <b>15 pts</b> — five wins from five — three clear of Arsenal (12), with Brighton third (10).',
      },
      {
        kind: 'answer',
        html: 'United v Tottenham (Oct 10) on Polymarket: United <b class="a">57.5¢</b> · draw <b class="a">22.5¢</b> · Spurs <b class="a">21.5¢</b>.',
      },
      { kind: 'meta', text: 'sources: ESPN standings · Polymarket' },
    ],
  },
  {
    id: 'edge',
    label: 'Edge',
    meta: 'betting skill · pure math',
    lines: [
      { kind: 'ask', text: 'Lakers are -150 / +130 at the book and 54¢ on Polymarket. Any edge?' },
      { kind: 'route', skills: ['betting'] },
      { kind: 'call', tool: 'betting_evaluate_bet', args: 'book_odds: "-150,+130" · market_prob: 0.54' },
      {
        kind: 'answer',
        html: 'De-vigged book: Lakers <b>58.0%</b> (vig 3.48%). Polymarket prices them at <b class="a">54.0%</b>.',
      },
      { kind: 'answer', html: 'Edge <b>+3.98%</b> · EV <b>+7.4%</b> per $1 · full Kelly 8.7% of bankroll.' },
      { kind: 'ask', text: 'Buy 100 shares.' },
      { kind: 'blocked', text: 'Trading is off. sportsclaw tracks markets — it never places orders.' },
    ],
  },
  {
    id: 'alerts',
    label: 'Alerts',
    meta: 'Discord · Telegram',
    lines: [
      { kind: 'ask', text: 'Alert me about the Lakers.' },
      { kind: 'check', text: "Subscribed to the Lakers (NBA). I'll message you on scores, lead changes, and the final." },
      { kind: 'meta', text: '· · · game night · · ·' },
      { kind: 'event', icon: '🏀', text: 'Lakers vs. Warriors is underway.' },
      { kind: 'event', icon: '🔄', text: 'The Lakers take the lead, 58–56.' },
      { kind: 'event', icon: '🏁', text: 'Final: Lakers 112, Warriors 108.' },
    ],
  },
]

const active = ref(0)
const shown = ref(scenes[0].lines.length) // SSR / no-JS: the full first scene
const typed = ref(-1) // chars typed on the line being typed (-1 = not typing)
const pending = ref(false) // spinner on the line about to resolve
const live = ref(false)
const auto = ref(true)
const termEl = ref<HTMLElement | null>(null)

const scene = computed(() => scenes[active.value])

let timers: number[] = []
let io: IntersectionObserver | undefined
let visible = true
let stalled = false // auto-advance came due while the terminal was off-screen
let reduced = false

function clear() {
  timers.forEach((t) => window.clearTimeout(t))
  timers = []
}
function later(fn: () => void, ms: number) {
  timers.push(window.setTimeout(fn, ms))
}

function play(index: number) {
  clear()
  active.value = index
  if (reduced) {
    shown.value = scenes[index].lines.length
    typed.value = -1
    return
  }
  shown.value = 0
  typed.value = -1
  step()
}

function step() {
  const lines = scene.value.lines
  if (shown.value >= lines.length) {
    if (auto.value)
      later(() => {
        if (visible) play((active.value + 1) % scenes.length)
        else stalled = true
      }, 4200)
    return
  }
  const line = lines[shown.value]
  if (line.kind === 'ask') {
    typed.value = 0
    const tick = () => {
      typed.value++
      if (typed.value < line.text.length) later(tick, 16 + Math.random() * 22)
      else
        later(() => {
          typed.value = -1
          shown.value++
          later(step, 260)
        }, 220)
    }
    later(tick, 380)
  } else if (line.kind === 'call' || line.kind === 'blocked') {
    pending.value = true
    later(() => {
      pending.value = false
      shown.value++
      step()
    }, line.kind === 'call' ? 620 : 520)
  } else {
    later(() => {
      shown.value++
      step()
    }, line.kind === 'answer' ? 260 : 340)
  }
}

function select(index: number) {
  auto.value = false
  play(index)
}

onMounted(() => {
  reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  if (reduced) return
  live.value = true
  shown.value = 0
  const el = termEl.value
  if (!el || !('IntersectionObserver' in window)) return play(0)
  let started = false
  io = new IntersectionObserver(
    ([entry]) => {
      visible = entry.isIntersecting
      if (!visible) return
      if (!started) {
        started = true
        play(0)
      } else if (stalled) {
        stalled = false
        play((active.value + 1) % scenes.length)
      }
    },
    { threshold: 0.25 },
  )
  io.observe(el)
})

onBeforeUnmount(() => {
  clear()
  io?.disconnect()
})
</script>

<template>
  <div ref="termEl" class="sc-term" :class="{ 'is-live': live }">
    <div class="sc-term-bar">
      <div class="sc-term-dots" aria-hidden="true"><i /><i /><i /></div>
      <div class="sc-term-tabs" role="tablist" aria-label="Example sessions">
        <button
          v-for="(s, i) in scenes"
          :key="s.id"
          type="button"
          role="tab"
          class="sc-term-tab"
          :aria-selected="i === active"
          @click="select(i)"
        >{{ s.label }}</button>
      </div>
      <div class="sc-term-meta"><span class="sc-live-dot" aria-hidden="true" />{{ scene.meta }}</div>
    </div>
    <div class="sc-term-body" role="tabpanel" :aria-label="scene.label">
      <template v-for="(line, i) in scene.lines" :key="scene.id + i">
        <div v-if="i < shown || (i === shown && (typed >= 0 || pending))" class="sc-t-row" :class="'sc-t-' + line.kind">
          <template v-if="line.kind === 'ask'">
            <span class="sc-t-gutter">›</span>
            <span class="sc-t-ask">{{ i === shown && typed >= 0 ? line.text.slice(0, typed) : line.text }}<span v-if="i === shown && typed >= 0" class="sc-t-caret" /></span>
          </template>
          <template v-else-if="line.kind === 'route'">
            <span class="sc-t-gutter">◇</span>
            <span><span class="sc-t-dim">route</span> <span v-for="(s, j) in line.skills" :key="s"><span v-if="j" class="sc-t-dim"> · </span><span class="sc-t-skill">{{ s }}</span></span></span>
          </template>
          <template v-else-if="line.kind === 'call'">
            <span class="sc-t-gutter"><span v-if="i === shown" class="sc-t-spin" /><span v-else class="sc-t-ok">✓</span></span>
            <span class="sc-t-callbody"><span class="sc-t-tool">{{ line.tool }}</span> <span class="sc-t-dim">{{ line.args }}</span></span>
          </template>
          <template v-else-if="line.kind === 'check'">
            <span class="sc-t-gutter sc-t-ok">✓</span>
            <span class="sc-t-checktext">{{ line.text }}</span>
          </template>
          <template v-else-if="line.kind === 'answer'">
            <span class="sc-t-gutter" />
            <span class="sc-t-answer" v-html="line.html" />
          </template>
          <template v-else-if="line.kind === 'blocked'">
            <span class="sc-t-gutter"><span v-if="i === shown" class="sc-t-spin is-red" /><span v-else class="sc-t-no">✕</span></span>
            <span class="sc-t-blocked"><b>blocked</b> {{ line.text }}</span>
          </template>
          <template v-else-if="line.kind === 'event'">
            <span class="sc-t-gutter">{{ line.icon }}</span>
            <span class="sc-t-event">{{ line.text }}</span>
          </template>
          <template v-else>
            <span class="sc-t-gutter" />
            <span class="sc-t-dim">{{ line.text }}</span>
          </template>
        </div>
      </template>
    </div>
  </div>
</template>
