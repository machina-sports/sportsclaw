import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type EntityType = "team" | "player" | "competition" | "season" | "market";

export interface CachedEntity {
  id: string;
  entityType: EntityType;
  sport: string | null;
  league: string | null;
  canonicalName: string;
  aliases: string[];
  providerIds: Record<string, string>;
  metadata: Record<string, unknown>;
  confidence: number;
  firstSeenAt: string;
  lastVerifiedAt: string;
  mentionCount: number;
}

const TTL_DAYS: Record<EntityType, number> = {
  team: 180, player: 90, competition: 365, season: 30, market: 1,
};

export function entityIsStale(entity: CachedEntity, now: number = Date.now()): boolean {
  const ttlDays = TTL_DAYS[entity.entityType];
  if (ttlDays === undefined) return true;
  const ttlMs = ttlDays * 86_400_000;
  const verified = Date.parse(entity.lastVerifiedAt);
  if (Number.isNaN(verified)) return true;
  return now - verified > ttlMs;
}

const DEFAULT_PATH = join(homedir(), ".sportsclaw", "entity-cache.json");

export class EntityStore {
  private byId = new Map<string, CachedEntity>();
  private loaded = false;

  constructor(private filePath: string = DEFAULT_PATH) {}

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const arr = JSON.parse(raw) as CachedEntity[];
      for (const e of arr) this.byId.set(e.id, e);
    } catch {
      // Missing/corrupt file → start empty.
    }
    this.loaded = true;
  }

  get(query: string, entityType?: EntityType, sport?: string): CachedEntity | undefined {
    const q = query.trim().toLowerCase();
    for (const e of this.byId.values()) {
      if (entityType && e.entityType !== entityType) continue;
      if (sport && (e.sport ?? "").toLowerCase() !== sport.toLowerCase()) continue;
      if (entityIsStale(e)) continue;
      const names = [e.canonicalName, ...e.aliases].map((n) => n.toLowerCase());
      if (names.includes(q)) return e;
    }
    return undefined;
  }

  async upsert(entity: CachedEntity): Promise<void> {
    if (!this.loaded) await this.load();
    const existing = this.byId.get(entity.id);
    if (existing) {
      entity.mentionCount = existing.mentionCount + 1;
      entity.firstSeenAt = existing.firstSeenAt;
    }
    this.byId.set(entity.id, entity);
    await this.persist();
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify([...this.byId.values()], null, 2), "utf8");
    await rename(tmp, this.filePath); // atomic replace
  }
}
