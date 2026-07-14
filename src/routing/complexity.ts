export type QueryComplexity = "simple" | "compound" | "research" | "betting" | "live_game";

export interface SkillCapPlan {
  complexity: QueryComplexity;
  maxSkills: number;
  addSkills: string[];
  reason: string;
}

const BETTING_KW = ["bet", "bets", "odds", "line", "spread", "total", "over", "under", "market", "price", "edge", "kelly"];
const LIVE_KW = ["live", "right now", "winning", "quarter", "period", "inning"];
const NEWS_KW = ["injury", "injuries", "out", "questionable", "news", "report"];
const MULTISPORT_KW = ["across sports", "what's happening", "whats happening", "everything", "all sports", "tonight across"];
const RESEARCH_KW = ["audit", "deep dive", "analyze", "research", "compare", "breakdown"];

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasAny(h: string, kws: string[]): boolean {
  return kws.some((k) => {
    if (k.includes(" ")) return h.includes(k);
    return new RegExp(`\\b${escapeRegex(k)}\\b`).test(h);
  });
}

export function classifyQueryComplexity(query: string): QueryComplexity {
  const h = query.toLowerCase();
  if (hasAny(h, MULTISPORT_KW)) return "research";
  if (hasAny(h, RESEARCH_KW)) return "research";
  if (hasAny(h, BETTING_KW)) return "betting";
  if (hasAny(h, NEWS_KW)) return "compound";
  if (hasAny(h, LIVE_KW)) return "live_game";
  return "simple";
}

export function planSkillCaps(
  query: string,
  base: { routingMaxSkills: number; routingAllowSpillover: number },
): SkillCapPlan {
  const complexity = classifyQueryComplexity(query);
  const addSkills: string[] = [];
  let maxSkills = base.routingMaxSkills;
  let reason = "simple query — default caps";

  switch (complexity) {
    case "betting":
      maxSkills = Math.max(maxSkills, 3);
      addSkills.push("betting", "markets", "kalshi", "polymarket");
      reason = "betting intent — added market skills";
      break;
    case "research":
      maxSkills = Math.max(maxSkills, 4);
      reason = "multi-sport/research — widened skill budget";
      break;
    case "compound":
      maxSkills = Math.max(maxSkills, 3);
      addSkills.push("news");
      reason = "compound (injury/news) — added news";
      break;
    case "live_game":
      maxSkills = Math.max(maxSkills, 3);
      reason = "live-game intent";
      break;
    case "simple":
    default:
      break;
  }
  return { complexity, maxSkills, addSkills, reason };
}
