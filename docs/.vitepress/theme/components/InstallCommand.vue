<script setup lang="ts">
import { computed, ref } from 'vue'

const options = [
  {
    id: 'curl',
    label: 'curl',
    cmd: 'curl -fsSL https://sportsclaw.gg/install.sh | bash',
    note: 'macOS / Linux. Installs the engine from npm and the sports-skills data layer from PyPI.',
  },
  {
    id: 'npm',
    label: 'npm',
    cmd: 'npm install -g sportsclaw-engine-core',
    note: 'Any OS with Node 20+. Python 3.10+ is needed for the data layer: pip install sports-skills.',
  },
  {
    id: 'claude',
    label: 'Claude Code',
    cmd: 'sportsclaw login claude',
    note: 'Already on Claude Pro / Max? Reuse your Claude Code session instead of an API key.',
  },
]

const active = ref(0)
const copied = ref(false)
const current = computed(() => options[active.value])

async function copy() {
  try {
    await navigator.clipboard.writeText(current.value.cmd)
    copied.value = true
    window.setTimeout(() => (copied.value = false), 1600)
  } catch {
    /* clipboard unavailable — the command stays selectable */
  }
}
</script>

<template>
  <div class="sc-install">
    <div class="sc-install-tabs" role="tablist" aria-label="Install method">
      <button
        v-for="(o, i) in options"
        :key="o.id"
        type="button"
        role="tab"
        :aria-selected="i === active"
        @click="active = i"
      >{{ o.label }}</button>
    </div>
    <div class="sc-install-cmd">
      <span class="sc-install-prompt" aria-hidden="true">$</span>
      <code>{{ current.cmd }}</code>
      <button type="button" class="sc-install-copy" :aria-label="copied ? 'Copied' : 'Copy command'" @click="copy">
        <svg v-if="!copied" viewBox="0 0 24 24" aria-hidden="true"><rect x="8.5" y="8.5" width="12" height="12" rx="2.5" /><path d="M15.5 8.5V6a2.5 2.5 0 0 0-2.5-2.5H6A2.5 2.5 0 0 0 3.5 6v7A2.5 2.5 0 0 0 6 15.5h2.5" /></svg>
        <svg v-else viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
      </button>
    </div>
    <p class="sc-install-note">{{ current.note }}</p>
  </div>
</template>
