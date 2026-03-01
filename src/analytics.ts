/**
 * sportsclaw Analytics Module
 *
 * Captures usage data for product insights, without PII.
 * All data is anonymized (user IDs are hashed, no raw prompts stored in aggregate).
 *
 * Data captured:
 *   - Query patterns (sport distribution, query types)
 *   - Tool performance (call counts, success rates, latency)
 *   - Engagement metrics (sessions, retention, depth)
 *   - Aggregated fan profiles (team/league preferences)
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const ANALYTICS_DIR = join(homedir(), ".sportsclaw", "analytics");
const QUERY_LOG = join(ANALYTICS_DIR, "queries.jsonl");
const TOOL_METRICS = join(ANALYTICS_DIR, "tool_metrics.json");
const AGGREGATE_STATS = join(ANALYTICS_DIR, "aggregate.json");
const SESSION_LOG = join(ANALYTICS_DIR, "sessions.jsonl");

function ensureDir(): void {
  if (!existsSync(ANALYTICS_DIR)) {
    mkdirSync(ANALYTICS_DIR, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QueryEvent {
  timestamp: string;
  userHash: string;
  sessionId: string;
  promptLength: number;
  detectedSports: string[];
  toolsCalled: string[];
  toolsSucceeded: string[];
  toolsFailed: string[];
  latencyMs: number;
  success: boolean;
  clarificationNeeded: boolean;
}

export interface ToolMetrics {
  [toolName: string]: {
    callCount: number;
    successCount: number;
    failCount: number;
    totalLatencyMs: number;
    avgLatencyMs: number;
    lastError?: string;
    lastUsed: string;
  };
}

export interface AggregateStats {
  totalQueries: number;
  uniqueUsers: number;
  sportDistribution: Record<string, number>;
  avgToolsPerQuery: number;
  avgLatencyMs: number;
  successRate: number;
  topTools: Array<{ name: string; calls: number }>;
  peakHours: Record<number, number>; // hour -> query count
  dailyActive: Record<string, number>; // date -> unique users
  lastUpdated: string;
}

export interface SessionEvent {
  timestamp: string;
  userHash: string;
  sessionId: string;
  event: "start" | "query" | "end";
  queryCount?: number;
  durationMs?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Hash user ID for privacy. Deterministic so we can track retention.
 */
export function hashUserId(userId: string): string {
  return createHash("sha256").update(userId).digest("hex").slice(0, 16);
}

/**
 * Generate a session ID for grouping queries.
 */
export function generateSessionId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// Query Logging
// ---------------------------------------------------------------------------

/**
 * Log a query event. Called after each engine.run() completes.
 */
export function logQuery(event: QueryEvent): void {
  ensureDir();
  const line = JSON.stringify(event) + "\n";
  appendFileSync(QUERY_LOG, line, "utf-8");

  // Update aggregate stats
  updateAggregateStats(event);
}

/**
 * Build a QueryEvent from engine execution data.
 */
export function buildQueryEvent(params: {
  userId: string;
  sessionId: string;
  promptLength: number;
  detectedSports: string[];
  toolsCalled: Array<{ name: string; success: boolean; latencyMs?: number }>;
  totalLatencyMs: number;
  clarificationNeeded: boolean;
}): QueryEvent {
  const succeeded = params.toolsCalled.filter((t) => t.success).map((t) => t.name);
  const failed = params.toolsCalled.filter((t) => !t.success).map((t) => t.name);

  return {
    timestamp: new Date().toISOString(),
    userHash: hashUserId(params.userId),
    sessionId: params.sessionId,
    promptLength: params.promptLength,
    detectedSports: params.detectedSports,
    toolsCalled: params.toolsCalled.map((t) => t.name),
    toolsSucceeded: succeeded,
    toolsFailed: failed,
    latencyMs: params.totalLatencyMs,
    success: failed.length === 0 || succeeded.length > 0,
    clarificationNeeded: params.clarificationNeeded,
  };
}

// ---------------------------------------------------------------------------
// Tool Metrics
// ---------------------------------------------------------------------------

function loadToolMetrics(): ToolMetrics {
  if (!existsSync(TOOL_METRICS)) return {};
  try {
    return JSON.parse(readFileSync(TOOL_METRICS, "utf-8")) as ToolMetrics;
  } catch {
    return {};
  }
}

function saveToolMetrics(metrics: ToolMetrics): void {
  ensureDir();
  writeFileSync(TOOL_METRICS, JSON.stringify(metrics, null, 2), "utf-8");
}

/**
 * Record a tool call for metrics tracking.
 */
export function recordToolCall(params: {
  toolName: string;
  success: boolean;
  latencyMs: number;
  error?: string;
}): void {
  const metrics = loadToolMetrics();
  const { toolName, success, latencyMs, error } = params;

  if (!metrics[toolName]) {
    metrics[toolName] = {
      callCount: 0,
      successCount: 0,
      failCount: 0,
      totalLatencyMs: 0,
      avgLatencyMs: 0,
      lastUsed: new Date().toISOString(),
    };
  }

  const m = metrics[toolName];
  m.callCount++;
  m.totalLatencyMs += latencyMs;
  m.avgLatencyMs = Math.round(m.totalLatencyMs / m.callCount);
  m.lastUsed = new Date().toISOString();

  if (success) {
    m.successCount++;
  } else {
    m.failCount++;
    if (error) {
      m.lastError = error.slice(0, 200);
    }
  }

  saveToolMetrics(metrics);
}

/**
 * Get current tool metrics for reporting.
 */
export function getToolMetrics(): ToolMetrics {
  return loadToolMetrics();
}

// ---------------------------------------------------------------------------
// Aggregate Stats
// ---------------------------------------------------------------------------

function loadAggregateStats(): AggregateStats {
  if (!existsSync(AGGREGATE_STATS)) {
    return {
      totalQueries: 0,
      uniqueUsers: 0,
      sportDistribution: {},
      avgToolsPerQuery: 0,
      avgLatencyMs: 0,
      successRate: 0,
      topTools: [],
      peakHours: {},
      dailyActive: {},
      lastUpdated: new Date().toISOString(),
    };
  }
  try {
    return JSON.parse(readFileSync(AGGREGATE_STATS, "utf-8")) as AggregateStats;
  } catch {
    return {
      totalQueries: 0,
      uniqueUsers: 0,
      sportDistribution: {},
      avgToolsPerQuery: 0,
      avgLatencyMs: 0,
      successRate: 0,
      topTools: [],
      peakHours: {},
      dailyActive: {},
      lastUpdated: new Date().toISOString(),
    };
  }
}

function saveAggregateStats(stats: AggregateStats): void {
  ensureDir();
  writeFileSync(AGGREGATE_STATS, JSON.stringify(stats, null, 2), "utf-8");
}

// Track unique users in memory (reset daily via cron or on-demand)
const seenUsers = new Set<string>();

function updateAggregateStats(event: QueryEvent): void {
  const stats = loadAggregateStats();

  // Total queries
  stats.totalQueries++;

  // Unique users
  if (!seenUsers.has(event.userHash)) {
    seenUsers.add(event.userHash);
    stats.uniqueUsers++;
  }

  // Sport distribution
  for (const sport of event.detectedSports) {
    stats.sportDistribution[sport] = (stats.sportDistribution[sport] || 0) + 1;
  }

  // Avg tools per query (running average)
  const totalTools = stats.avgToolsPerQuery * (stats.totalQueries - 1) + event.toolsCalled.length;
  stats.avgToolsPerQuery = Math.round((totalTools / stats.totalQueries) * 100) / 100;

  // Avg latency (running average)
  const totalLatency = stats.avgLatencyMs * (stats.totalQueries - 1) + event.latencyMs;
  stats.avgLatencyMs = Math.round(totalLatency / stats.totalQueries);

  // Success rate (running average)
  const totalSuccess = stats.successRate * (stats.totalQueries - 1) + (event.success ? 1 : 0);
  stats.successRate = Math.round((totalSuccess / stats.totalQueries) * 1000) / 1000;

  // Peak hours
  const hour = new Date(event.timestamp).getHours();
  stats.peakHours[hour] = (stats.peakHours[hour] || 0) + 1;

  // Daily active users
  const date = event.timestamp.slice(0, 10);
  stats.dailyActive[date] = (stats.dailyActive[date] || 0) + 1;

  stats.lastUpdated = new Date().toISOString();
  saveAggregateStats(stats);
}

/**
 * Get aggregate statistics for reporting.
 */
export function getAggregateStats(): AggregateStats {
  const stats = loadAggregateStats();

  // Compute top tools from tool metrics
  const toolMetrics = loadToolMetrics();
  stats.topTools = Object.entries(toolMetrics)
    .map(([name, m]) => ({ name, calls: m.callCount }))
    .sort((a, b) => b.calls - a.calls)
    .slice(0, 10);

  return stats;
}

// ---------------------------------------------------------------------------
// Session Tracking
// ---------------------------------------------------------------------------

/**
 * Log a session event for retention analysis.
 */
export function logSession(event: SessionEvent): void {
  ensureDir();
  const line = JSON.stringify(event) + "\n";
  appendFileSync(SESSION_LOG, line, "utf-8");
}

// ---------------------------------------------------------------------------
// Reporting (CLI-friendly)
// ---------------------------------------------------------------------------

/**
 * Generate a human-readable analytics report.
 */
export function generateReport(): string {
  const stats = getAggregateStats();
  const tools = getToolMetrics();

  const lines: string[] = [
    "# sportsclaw Analytics Report",
    `Generated: ${new Date().toISOString()}`,
    "",
    "## Overview",
    `- Total Queries: ${stats.totalQueries.toLocaleString()}`,
    `- Unique Users: ${stats.uniqueUsers.toLocaleString()}`,
    `- Success Rate: ${(stats.successRate * 100).toFixed(1)}%`,
    `- Avg Latency: ${stats.avgLatencyMs}ms`,
    `- Avg Tools/Query: ${stats.avgToolsPerQuery}`,
    "",
    "## Sport Distribution",
  ];

  const sortedSports = Object.entries(stats.sportDistribution)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  for (const [sport, count] of sortedSports) {
    const pct = ((count / stats.totalQueries) * 100).toFixed(1);
    lines.push(`- ${sport}: ${count.toLocaleString()} (${pct}%)`);
  }

  lines.push("", "## Top Tools");
  for (const { name, calls } of stats.topTools.slice(0, 10)) {
    const m = tools[name];
    const successRate = m ? ((m.successCount / m.callCount) * 100).toFixed(1) : "N/A";
    lines.push(`- ${name}: ${calls.toLocaleString()} calls (${successRate}% success)`);
  }

  lines.push("", "## Peak Hours (UTC)");
  const peakSorted = Object.entries(stats.peakHours)
    .map(([h, c]) => ({ hour: parseInt(h), count: c }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  for (const { hour, count } of peakSorted) {
    lines.push(`- ${hour}:00: ${count.toLocaleString()} queries`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Export for CLI
// ---------------------------------------------------------------------------

export const analytics = {
  logQuery,
  buildQueryEvent,
  recordToolCall,
  logSession,
  getToolMetrics,
  getAggregateStats,
  generateReport,
  hashUserId,
  generateSessionId,
};
