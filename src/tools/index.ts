import { sportsQueryTool } from "./sports_query.js";
import { sportsIntelligenceSnapshotTool } from "./sports_intelligence_snapshot.js";
import type { BuiltinTool } from "./builtin-tool.js";

export { BuiltinTool } from "./builtin-tool.js";
export { sportsQueryTool } from "./sports_query.js";
export { sportsIntelligenceSnapshotTool } from "./sports_intelligence_snapshot.js";

export const BUILTIN_TOOLS: BuiltinTool[] = [
  sportsQueryTool,
  sportsIntelligenceSnapshotTool,
];
