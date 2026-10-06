<script setup lang="ts">
import { computed } from 'vue'
import { data } from '../project.data'

const fmt = new Intl.NumberFormat('en-US')
const since = computed(() => {
  if (!data.firstCommit) return null
  const d = new Date(`${data.firstCommit}T12:00:00Z`)
  return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' })
})

const stats = computed(() =>
  [
    data.commits != null && { value: fmt.format(data.commits), label: 'commits' },
    data.mergedPrs != null && { value: fmt.format(data.mergedPrs), label: 'merged PRs' },
    { value: String(data.contributors.length), label: 'contributors' },
    data.latestTag && { value: data.latestTag, label: 'latest release' },
    since.value && { value: since.value, label: 'first commit' },
  ].filter(Boolean) as Array<{ value: string; label: string }>,
)
</script>

<template>
  <div class="sc-contrib">
    <dl class="sc-contrib-stats">
      <div v-for="s in stats" :key="s.label">
        <dt>{{ s.label }}</dt>
        <dd>{{ s.value }}</dd>
      </div>
    </dl>
    <ul class="sc-contrib-people" aria-label="Contributors">
      <li v-for="c in data.contributors" :key="c.login">
        <a :href="c.url" target="_blank" rel="noopener" :title="`${c.name} · ${c.commits} commits`">
          <img :src="c.avatar" :alt="''" width="40" height="40" loading="lazy" decoding="async" />
          <span class="sc-contrib-name">{{ c.name }}</span>
          <span class="sc-contrib-handle">@{{ c.login }}</span>
        </a>
      </li>
      <li class="sc-contrib-you">
        <a href="/contributing">
          <span class="sc-contrib-plus" aria-hidden="true">+</span>
          <span class="sc-contrib-name">You?</span>
          <span class="sc-contrib-handle">read the guide</span>
        </a>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.sc-contrib-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 1px;
  margin: 0 0 20px;
  border: 1px solid var(--sc-line);
  border-radius: var(--sc-r);
  overflow: hidden;
  background: var(--sc-line);
}
.sc-contrib-stats > div {
  flex: 1 1 112px;
  padding: 14px 16px;
  background: var(--sc-surface);
}
.sc-contrib-stats dt {
  font-family: var(--sc-mono);
  font-size: 11px;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--sc-text-3);
}
.sc-contrib-stats dd {
  margin: 4px 0 0;
  font-size: 22px;
  font-weight: 600;
  letter-spacing: -0.02em;
  color: var(--sc-text);
  font-variant-numeric: tabular-nums;
}
.sc-contrib-people {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.sc-contrib-people a {
  display: grid;
  grid-template-columns: 40px minmax(0, 1fr);
  grid-template-rows: auto auto;
  column-gap: 12px;
  align-items: center;
  padding: 10px 12px;
  border-radius: var(--sc-r);
  border: 1px solid var(--sc-line);
  background: var(--sc-surface);
  text-decoration: none;
  transition: border-color 0.15s ease, transform 0.15s ease;
}
.sc-contrib-people a:hover {
  border-color: var(--sc-claw);
  transform: translateY(-1px);
}
.sc-contrib-people img,
.sc-contrib-plus {
  grid-row: 1 / span 2;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: var(--sc-surface-3);
}
.sc-contrib-plus {
  display: grid;
  place-items: center;
  font-size: 20px;
  color: var(--sc-claw);
  border: 1px dashed var(--sc-claw);
  background: var(--sc-claw-a);
}
.sc-contrib-name {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  font-size: 14px;
  line-height: 1.3;
  font-weight: 600;
  color: var(--sc-text);
}
.sc-contrib-handle {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--sc-mono);
  font-size: 12px;
  color: var(--sc-text-3);
}
.sc-contrib-you a {
  border-style: dashed;
}
</style>
