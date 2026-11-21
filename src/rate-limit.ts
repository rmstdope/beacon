export type LimitResult = { allowed: true } | { allowed: false; retryAfterSeconds: number };

interface Window {
  start: number;
  count: number;
}

/**
 * Counts hits per key in fixed windows, in memory. Counters reset when the process restarts,
 * which is acceptable for one instance whose worst case is some spam to delete.
 */
export class FixedWindowLimiter {
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  readonly #windows = new Map<string, Window>();
  #lastPrune: number;

  constructor(options: { limit: number; windowMs: number; now?: () => number }) {
    this.#limit = options.limit;
    this.#windowMs = options.windowMs;
    this.#now = options.now ?? Date.now;
    this.#lastPrune = this.#now();
  }

  /** Number of keys currently tracked. */
  get size(): number {
    return this.#windows.size;
  }

  /** Records a hit for `key` if it is within the limit. */
  hit(key: string): LimitResult {
    const now = this.#now();
    this.#prune(now);
    let window = this.#windows.get(key);
    if (!window || now - window.start >= this.#windowMs) {
      window = { start: now, count: 0 };
      this.#windows.set(key, window);
    }
    if (window.count >= this.#limit) {
      const remainingMs = window.start + this.#windowMs - now;
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(remainingMs / 1000)) };
    }
    window.count += 1;
    return { allowed: true };
  }

  /** Drops expired windows, at most once per window length, so memory stays bounded. */
  #prune(now: number): void {
    if (now - this.#lastPrune < this.#windowMs) return;
    this.#lastPrune = now;
    for (const [key, window] of this.#windows) {
      if (now - window.start >= this.#windowMs) this.#windows.delete(key);
    }
  }
}
