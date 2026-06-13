/**
 * sportsclaw Engine — Circuit Breaker
 *
 * Keyed failure tracker for external data sources. After a threshold of
 * consecutive failures for a key, calls fail fast until a cooldown elapses;
 * then a single half-open probe is allowed. A success closes the circuit,
 * a failed probe re-opens it for another full cooldown.
 *
 * Pure in-memory state with an injectable clock — no I/O, fully unit-testable.
 * Only degraded keys hold an entry — healthy keys cost nothing, so the map stays bounded even with caller-supplied key strings.
 */

export interface CircuitBreakerOptions {
  /** Consecutive failures before the circuit opens (default: 5) */
  failureThreshold?: number;
  /** How long an open circuit fails fast before allowing a probe (default: 60s) */
  cooldownMs?: number;
  /** Clock override for tests (default: Date.now) */
  now?: () => number;
}

interface BreakerEntry {
  consecutiveFailures: number;
  openedAt: number | null;
}

export class CircuitBreaker {
  private entries = new Map<string, BreakerEntry>();
  private failureThreshold: number;
  private cooldownMs: number;
  private now: () => number;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 5;
    this.cooldownMs = options.cooldownMs ?? 60_000;
    this.now = options.now ?? Date.now;
  }

  private entry(key: string): BreakerEntry {
    let e = this.entries.get(key);
    if (!e) {
      e = { consecutiveFailures: 0, openedAt: null };
      this.entries.set(key, e);
    }
    return e;
  }

  /** True if calls for this key may proceed (closed, or cooldown elapsed → half-open). */
  canProceed(key: string): boolean {
    const e = this.entries.get(key);
    if (!e || e.openedAt === null) return true;
    return this.now() - e.openedAt >= this.cooldownMs;
  }

  recordSuccess(key: string): void {
    this.entries.delete(key);
  }

  recordFailure(key: string): void {
    const e = this.entry(key);
    e.consecutiveFailures++;
    if (e.consecutiveFailures >= this.failureThreshold) {
      e.openedAt = this.now();
    }
  }

  /** Clear all breaker state (used by tests). */
  reset(): void {
    this.entries.clear();
  }
}
