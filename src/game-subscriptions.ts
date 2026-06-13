/**
 * sportsclaw — Game Alert Subscription Store
 *
 * Team-level alert subscriptions persisted one JSON file per (userId, platform).
 * Atomic temp+rename writes (same pattern as SessionStore/FileMemoryStorage).
 * Default dir ~/.sportsclaw/game-subscriptions (override: SPORTSCLAW_SUBS_DIR).
 */

import { mkdirSync } from "node:fs";
import { readFile, writeFile, rename, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { GameSubscription } from "./types.js";

function sanitize(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 160);
}

export class GameSubscriptionStore {
  private dir: string;
  private dirReady = false;

  constructor(dir?: string) {
    this.dir = dir ?? process.env.SPORTSCLAW_SUBS_DIR ?? join(homedir(), ".sportsclaw", "game-subscriptions");
  }

  private filePath(userId: string, platform: string): string {
    return join(this.dir, `${sanitize(platform)}__${sanitize(userId)}.json`);
  }

  private ensureDir(): void {
    if (!this.dirReady) { mkdirSync(this.dir, { recursive: true }); this.dirReady = true; }
  }

  private async readFileSubs(path: string): Promise<GameSubscription[]> {
    try {
      const parsed = JSON.parse(await readFile(path, "utf-8"));
      return Array.isArray(parsed) ? (parsed as GameSubscription[]) : [];
    } catch {
      return [];
    }
  }

  private async writeFileSubs(path: string, subs: GameSubscription[]): Promise<void> {
    this.ensureDir();
    const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    await writeFile(tmp, JSON.stringify(subs), "utf-8");
    await rename(tmp, path);
  }

  private key(s: { sport: string; team: string }): string {
    return `${s.sport.toLowerCase()}:${s.team.toLowerCase()}`;
  }

  /** Add or update a subscription (idempotent on user/platform/sport/team). */
  async add(sub: GameSubscription): Promise<void> {
    const path = this.filePath(sub.userId, sub.platform);
    const subs = await this.readFileSubs(path);
    const idx = subs.findIndex((s) => this.key(s) === this.key(sub));
    if (idx >= 0) subs[idx] = sub; else subs.push(sub);
    await this.writeFileSubs(path, subs);
  }

  /** Remove one subscription. Returns true if something was removed. */
  async remove(userId: string, platform: string, sport: string, team: string): Promise<boolean> {
    const path = this.filePath(userId, platform);
    const subs = await this.readFileSubs(path);
    const target = `${sport.toLowerCase()}:${team.toLowerCase()}`;
    const next = subs.filter((s) => this.key(s) !== target);
    if (next.length === subs.length) return false;
    await this.writeFileSubs(path, next);
    return true;
  }

  async listForUser(userId: string, platform: string): Promise<GameSubscription[]> {
    return this.readFileSubs(this.filePath(userId, platform));
  }

  private async allSubs(): Promise<GameSubscription[]> {
    let files: string[];
    try { files = await readdir(this.dir); } catch { return []; }
    const all: GameSubscription[] = [];
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      all.push(...(await this.readFileSubs(join(this.dir, f))));
    }
    return all;
  }

  /** True if team names refer to the same team: exact, or one's tokens ⊆ the other's. */
  private teamMatches(a: string, b: string): boolean {
    const norm = (s: string) => s.toLowerCase().split(/\s+/).filter(Boolean);
    const at = norm(a), bt = norm(b);
    if (at.length === 0 || bt.length === 0) return false;
    const aset = new Set(at), bset = new Set(bt);
    const subset = (small: string[], big: Set<string>) => small.every((t) => big.has(t));
    return subset(at, bset) || subset(bt, aset);
  }

  /** All subscriptions for a given sport whose team matches (exact or token-subset). */
  async findSubscribers(sport: string, team: string): Promise<GameSubscription[]> {
    const sportLc = sport.toLowerCase();
    return (await this.allSubs()).filter(
      (s) => s.sport.toLowerCase() === sportLc && this.teamMatches(s.team, team)
    );
  }

  /** Distinct sports across all subscriptions (drives which scoreboards to poll). */
  async activeSports(): Promise<string[]> {
    return [...new Set((await this.allSubs()).map((s) => s.sport.toLowerCase()))];
  }
}

/** Shared default-location store. */
export const gameSubscriptionStore = new GameSubscriptionStore();
