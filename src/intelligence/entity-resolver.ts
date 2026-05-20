/**
 * sportsclaw — Sports Entity Resolver
 *
 * Implements canonical sports entity identification and cross-provider mapping
 * (e.g. mapping ESPN IDs, bookmakers, and prediction markets to the same graph node).
 */

export interface EntityMapping {
  canonicalId: string;
  aliases: Set<string>;
  providerIds: Map<string, string>; // provider -> external ID
}

export class EntityResolver {
  private static instance: EntityResolver;
  
  // Storage for mappings: sport -> entityType -> entityMap
  private registry: Map<string, Map<string, Map<string, EntityMapping>>> = new Map();

  private constructor() {
    this.bootstrapDefaults();
  }

  public static getInstance(): EntityResolver {
    if (!EntityResolver.instance) {
      EntityResolver.instance = new EntityResolver();
    }
    return EntityResolver.instance;
  }

  /**
   * Register a new entity mapping into the resolver.
   */
  public register(sport: string, type: "team" | "player" | "event", mapping: {
    canonicalId: string;
    aliases?: string[];
    providerIds?: Record<string, string>;
  }): void {
    const sportLower = sport.toLowerCase();
    
    if (!this.registry.has(sportLower)) {
      this.registry.set(sportLower, new Map());
    }
    
    const sportMap = this.registry.get(sportLower)!;
    if (!sportMap.has(type)) {
      sportMap.set(type, new Map());
    }
    
    const typeMap = sportMap.get(type)!;
    
    let existing = typeMap.get(mapping.canonicalId);
    if (!existing) {
      existing = {
        canonicalId: mapping.canonicalId,
        aliases: new Set<string>(),
        providerIds: new Map<string, string>(),
      };
      typeMap.set(mapping.canonicalId, existing);
    }

    if (mapping.aliases) {
      for (const alias of mapping.aliases) {
        existing.aliases.add(alias.toLowerCase());
      }
    }

    if (mapping.providerIds) {
      for (const [provider, extId] of Object.entries(mapping.providerIds)) {
        existing.providerIds.set(provider, extId);
      }
    }
  }

  /**
   * Resolve a team name or alias to its canonical ID.
   */
  public resolveTeam(sport: string, query: string): string {
    const sportLower = sport.toLowerCase();
    const queryLower = query.trim().toLowerCase();
    
    if (!queryLower) return `unknown:team:${sportLower}`;

    const sportMap = this.registry.get(sportLower);
    if (!sportMap) return `${sportLower}:team:${this.slugify(query)}`;

    const typeMap = sportMap.get("team");
    if (!typeMap) return `${sportLower}:team:${this.slugify(query)}`;

    // 1. Exact match on canonical ID or slug
    const directSlug = `${sportLower}:team:${this.slugify(query)}`;
    if (typeMap.has(directSlug)) return directSlug;

    // 2. Scan exact alias or canonical name match
    let foundId: string | undefined = undefined;
    typeMap.forEach((mapping, canonicalId) => {
      if (foundId) return;
      if (canonicalId.endsWith(queryLower) || mapping.aliases.has(queryLower)) {
        foundId = canonicalId;
      }
    });
    if (foundId) return foundId;

    // 3. Fuzzy match helper
    let bestScore = 0;
    let bestMatchId = directSlug;

    typeMap.forEach((mapping, canonicalId) => {
      // Check distance against canonicalId slug suffix
      const suffix = canonicalId.split(":").pop() || "";
      const scoreSuffix = this.stringSimilarity(queryLower, suffix.replace(/_/g, " "));
      if (scoreSuffix > bestScore) {
        bestScore = scoreSuffix;
        bestMatchId = canonicalId;
      }

      // Check distance against aliases
      mapping.aliases.forEach((alias) => {
        const scoreAlias = this.stringSimilarity(queryLower, alias);
        if (scoreAlias > bestScore) {
          bestScore = scoreAlias;
          bestMatchId = canonicalId;
        }
      });
    });

    // High threshold for teams to avoid false positives (e.g. Lakers vs Clippers)
    if (bestScore > 0.75) {
      return bestMatchId;
    }

    return directSlug;
  }

  /**
   * Resolve a player name with optional team constraint.
   */
  public resolvePlayer(sport: string, name: string, _teamHint?: string): string {
    const sportLower = sport.toLowerCase();
    const nameLower = name.trim().toLowerCase();
    
    if (!nameLower) return `unknown:player:${sportLower}`;

    const sportMap = this.registry.get(sportLower);
    if (!sportMap) return `${sportLower}:player:${this.slugify(name)}`;

    const typeMap = sportMap.get("player");
    if (!typeMap) return `${sportLower}:player:${this.slugify(name)}`;

    const directSlug = `${sportLower}:player:${this.slugify(name)}`;
    if (typeMap.has(directSlug)) return directSlug;

    // Scan exact match
    let foundPlayerId: string | undefined = undefined;
    typeMap.forEach((mapping, canonicalId) => {
      if (foundPlayerId) return;
      if (mapping.aliases.has(nameLower)) {
        foundPlayerId = canonicalId;
      }
    });
    if (foundPlayerId) return foundPlayerId;

    // Fuzzy match on names
    let bestScore = 0;
    let bestMatchId = directSlug;

    typeMap.forEach((mapping, canonicalId) => {
      const pName = canonicalId.split(":").pop()?.replace(/_/g, " ") || "";
      const scoreName = this.stringSimilarity(nameLower, pName);
      if (scoreName > bestScore) {
        bestScore = scoreName;
        bestMatchId = canonicalId;
      }

      mapping.aliases.forEach((alias) => {
        const scoreAlias = this.stringSimilarity(nameLower, alias);
        if (scoreAlias > bestScore) {
          bestScore = scoreAlias;
          bestMatchId = canonicalId;
        }
      });
    });

    // Players have more unique names, but 0.6 is a solid fuzzy threshold for nicknames/abbreviations
    if (bestScore > 0.60) {
      return bestMatchId;
    }

    return directSlug;
  }

  /**
   * Get an external provider identifier mapped to a canonical ID.
   */
  public mapToProviderId(sport: string, type: "team" | "player" | "event", canonicalId: string, provider: string): string | undefined {
    const sportLower = sport.toLowerCase();
    const sportMap = this.registry.get(sportLower);
    if (!sportMap) return undefined;

    const typeMap = sportMap.get(type);
    if (!typeMap) return undefined;

    return typeMap.get(canonicalId)?.providerIds.get(provider);
  }

  /**
   * Slugify a string into standard canonical key format (lowercase, underscores).
   */
  public slugify(str: string): string {
    return str
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/[\s-]+/g, "_");
  }

  /**
   * Levenshtein-based string similarity ratio (0 to 1).
   */
  private stringSimilarity(s1: string, s2: string): number {
    const longer = s1.length > s2.length ? s1 : s2;
    const shorter = s1.length > s2.length ? s2 : s1;
    
    if (longer.length === 0) return 1.0;
    
    const distance = this.levenshteinDistance(longer, shorter);
    return (longer.length - distance) / longer.length;
  }

  private levenshteinDistance(s1: string, s2: string): number {
    const costs: number[] = [];
    for (let i = 0; i <= s1.length; i++) {
      let lastValue = i;
      for (let j = 0; j <= s2.length; j++) {
        if (i === 0) {
          costs[j] = j;
        } else if (j > 0) {
          let newValue = costs[j - 1];
          if (s1.charAt(i - 1) !== s2.charAt(j - 1)) {
            newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
          }
          costs[j - 1] = lastValue;
          lastValue = newValue;
        }
      }
      if (i > 0) costs[s2.length] = lastValue;
    }
    return costs[s2.length];
  }

  /**
   * Pre-load common high-value sports entities to bootstrap the resolver.
   */
  private bootstrapDefaults(): void {
    // NBA Defaults
    this.register("nba", "team", {
      canonicalId: "nba:team:lal",
      aliases: ["lakers", "los angeles lakers", "la lakers", "lal"],
      providerIds: { espn: "13", draftkings: "nba:team:lal" },
    });
    this.register("nba", "team", {
      canonicalId: "nba:team:gsw",
      aliases: ["warriors", "golden state warriors", "golden state", "gsw"],
      providerIds: { espn: "9", draftkings: "nba:team:gsw" },
    });
    this.register("nba", "team", {
      canonicalId: "nba:team:bos",
      aliases: ["celtics", "boston celtics", "boston", "bos"],
      providerIds: { espn: "2", draftkings: "nba:team:bos" },
    });

    // NFL Defaults
    this.register("nfl", "team", {
      canonicalId: "nfl:team:kc",
      aliases: ["chiefs", "kansas city chiefs", "kansas city", "kc"],
      providerIds: { espn: "12", draftkings: "nfl:team:kc" },
    });
    this.register("nfl", "team", {
      canonicalId: "nfl:team:sf",
      aliases: ["49ers", "san francisco 49ers", "san francisco", "sf", "niners"],
      providerIds: { espn: "25", draftkings: "nfl:team:sf" },
    });

    // Soccer (Football) Defaults
    this.register("football", "team", {
      canonicalId: "football:team:rma",
      aliases: ["real madrid", "real madrid cf", "rma", "madrid"],
      providerIds: { espn: "110", transfermarkt: "418" },
    });
    this.register("football", "team", {
      canonicalId: "football:team:bar",
      aliases: ["barcelona", "fc barcelona", "bar", "fcb"],
      providerIds: { espn: "83", transfermarkt: "131" },
    });
    this.register("football", "team", {
      canonicalId: "football:team:ars",
      aliases: ["arsenal", "arsenal fc", "ars"],
      providerIds: { espn: "359", transfermarkt: "11" },
    });
  }
}

export const entityResolver = EntityResolver.getInstance();
