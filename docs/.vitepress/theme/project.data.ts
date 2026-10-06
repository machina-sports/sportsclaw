// Build-time project stats for the landing page (commits, merged PRs,
// contributors, latest release). Everything is best-effort: a failed git or
// GitHub call falls back to the dated snapshot below instead of failing the
// build. Set SPORTSCLAW_SITE_OFFLINE=1 to skip the network entirely.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export interface Contributor {
  login: string
  name: string
  avatar: string
  url: string
  commits: number
}

export interface ProjectData {
  version: string
  latestTag: string | null
  commits: number | null
  firstCommit: string | null
  mergedPrs: number | null
  contributors: Contributor[]
  source: 'live' | 'snapshot'
}

declare const data: ProjectData
export { data }

const REPO = 'machina-sports/sportsclaw'
// Automation and AI co-author accounts are credited in commits, not here.
const EXCLUDE = new Set(['claude', 'dependabot[bot]', 'github-actions[bot]', 'Copilot'])
// One person, two GitHub logins.
const ALIASES: Record<string, string> = { ecavan95: 'ecavan' }
const NAMES: Record<string, string> = {
  antonelli182: 'André Antonelli',
  bombassaro: 'Fernando Bombassaro',
  pinhepo: 'Mateus Pinheiro',
  ecavan: 'Elijah Cavan',
}

// Snapshot from 2026-10-06 — used only when the GitHub API is unreachable.
const SNAPSHOT = {
  mergedPrs: 177,
  contributors: [
    { login: 'antonelli182', commits: 510 },
    { login: 'bombassaro', commits: 23 },
    { login: 'pinhepo', commits: 18 },
    { login: 'ecavan', commits: 8 },
    { login: 'Squidy247-goat', commits: 1 },
  ],
}

function git(args: string[]): string | null {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

async function gh<T>(path: string): Promise<T> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'sportsclaw-site',
  }
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  const res = await fetch(`https://api.github.com/${path}`, { headers, signal: AbortSignal.timeout(8000) })
  if (!res.ok) throw new Error(`GitHub ${path}: ${res.status}`)
  return (await res.json()) as T
}

function person(login: string, commits: number, avatar?: string): Contributor {
  return {
    login,
    name: NAMES[login] ?? login,
    avatar: avatar ?? `https://github.com/${login}.png?size=96`,
    url: `https://github.com/${login}`,
    commits,
  }
}

function merge(list: Array<{ login: string; commits: number; avatar?: string }>): Contributor[] {
  const byLogin = new Map<string, Contributor>()
  for (const c of list) {
    if (EXCLUDE.has(c.login)) continue
    const login = ALIASES[c.login] ?? c.login
    const prev = byLogin.get(login)
    if (prev) prev.commits += c.commits
    else byLogin.set(login, person(login, c.commits, login === c.login ? c.avatar : undefined))
  }
  return [...byLogin.values()].sort((a, b) => b.commits - a.commits)
}

export default {
  async load(): Promise<ProjectData> {
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as { version: string }

    const shallow = git(['rev-parse', '--is-shallow-repository']) === 'true'
    const count = shallow ? null : git(['rev-list', '--count', 'HEAD'])
    const first = shallow ? null : git(['log', '--reverse', '--format=%cs', 'HEAD'])?.split('\n')[0] ?? null
    const latestTag = git(['describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*'])

    const base: Omit<ProjectData, 'mergedPrs' | 'contributors' | 'source'> = {
      version: pkg.version,
      latestTag,
      commits: count ? Number(count) : null,
      firstCommit: first,
    }
    const snapshot: ProjectData = {
      ...base,
      mergedPrs: SNAPSHOT.mergedPrs,
      contributors: merge(SNAPSHOT.contributors),
      source: 'snapshot',
    }
    if (process.env.SPORTSCLAW_SITE_OFFLINE === '1') return snapshot

    try {
      const [contributors, merged] = await Promise.all([
        gh<Array<{ login: string; contributions: number; avatar_url: string; type: string }>>(
          `repos/${REPO}/contributors?per_page=100`,
        ),
        gh<{ total_count: number }>(`search/issues?q=repo:${REPO}+is:pr+is:merged&per_page=1`),
      ])
      return {
        ...base,
        mergedPrs: merged.total_count,
        contributors: merge(
          contributors
            .filter((c) => c.type !== 'Bot')
            .map((c) => ({ login: c.login, commits: c.contributions, avatar: `${c.avatar_url}&s=96` })),
        ),
        source: 'live',
      }
    } catch (err) {
      console.warn(`[project.data] GitHub stats unavailable, using snapshot: ${(err as Error).message}`)
      return snapshot
    }
  },
}
