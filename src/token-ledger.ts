/**
 * sportsclaw Engine — Daily Token Ledger
 *
 * Tiny on-disk tally of LLM tokens spent per UTC day, used by the optional
 * dailyTokenBudget guardrail. Accounting is best-effort and must never
 * break the main flow: all errors are swallowed.
 *
 * Note: the read-modify-write below is not cross-process atomic. Two
 * processes recording simultaneously can undercount slightly — acceptable
 * for a spend guardrail, not suitable for billing.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const DEFAULT_LEDGER = join(homedir(), ".sportsclaw", "analytics", "token-ledger.json");

type LedgerShape = Record<string, number>;

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function readLedger(ledgerPath: string): LedgerShape {
  try {
    if (!existsSync(ledgerPath)) return {};
    const parsed = JSON.parse(readFileSync(ledgerPath, "utf-8"));
    return parsed && typeof parsed === "object" ? (parsed as LedgerShape) : {};
  } catch {
    return {};
  }
}

/** Add tokens to today's tally. Non-positive or non-finite values are ignored. */
export function recordTokens(tokens: number, ledgerPath: string = DEFAULT_LEDGER): void {
  if (!Number.isFinite(tokens) || tokens <= 0) return;
  try {
    mkdirSync(dirname(ledgerPath), { recursive: true });
    const ledger = readLedger(ledgerPath);
    const key = todayKey();
    ledger[key] = (ledger[key] ?? 0) + tokens;
    // Atomic write: temp + rename so a crash never corrupts the ledger.
    // Random suffix (matching SessionStore/FileMemoryStorage) avoids two
    // concurrent same-process writers colliding on one temp file.
    const tmp = `${ledgerPath}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    writeFileSync(tmp, JSON.stringify(ledger), "utf-8");
    renameSync(tmp, ledgerPath);
  } catch {
    // Accounting must never break the main flow.
  }
}

/** Tokens recorded so far for the current UTC day. */
export function tokensUsedToday(ledgerPath: string = DEFAULT_LEDGER): number {
  const value = readLedger(ledgerPath)[todayKey()];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
