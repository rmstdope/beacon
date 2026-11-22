export type LimitResult = { allowed: true } | { allowed: false; retryAfterSeconds: number };

interface Window {
  start: number;
  count: number;
}

/**
 * Counts hits per key in fixed windows, in memory. Counters reset when the process restarts,
 * which is acceptable for one instance whose worst case is some spam to delete. At most `maxKeys`
 * live keys are tracked; while that many are live, new keys are refused, so a flood from rotating
 * addresses cannot exhaust memory.
 */
export class FixedWindowLimiter {
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #maxKeys: number;
  readonly #now: () => number;
  readonly #windows = new Map<string, Window>();
  #lastPrune: number;

  constructor(options: { limit: number; windowMs: number; maxKeys?: number; now?: () => number }) {
    this.#limit = options.limit;
    this.#windowMs = options.windowMs;
    this.#maxKeys = options.maxKeys ?? 50_000;
    this.#now = options.now ?? Date.now;
    this.#lastPrune = this.#now();
  }

  /** Number of keys currently tracked. */
  get size(): number {
    return this.#windows.size;
  }

  /** Whether a hit for `key` would be allowed, without recording one. */
  peek(key: string): LimitResult {
    return this.#check(key, this.#now());
  }

  /** Records a hit for `key` if it is allowed. */
  hit(key: string): LimitResult {
    const now = this.#now();
    this.#prune(now);
    const result = this.#check(key, now);
    if (!result.allowed) return result;
    const window = this.#windows.get(key);
    if (window && now - window.start < this.#windowMs) {
      window.count += 1;
    } else {
      // Re-insert so the map stays ordered by window start, oldest first.
      this.#windows.delete(key);
      this.#windows.set(key, { start: now, count: 1 });
    }
    return result;
  }

  #check(key: string, now: number): LimitResult {
    const window = this.#windows.get(key);
    if (window && now - window.start < this.#windowMs) {
      if (window.count < this.#limit) return { allowed: true };
      return { allowed: false, retryAfterSeconds: this.#secondsLeft(window, now) };
    }
    if (window || this.#windows.size < this.#maxKeys) return { allowed: true };
    this.#prune(now, true);
    if (this.#windows.size < this.#maxKeys) return { allowed: true };
    const oldest = this.#windows.values().next().value;
    return { allowed: false, retryAfterSeconds: oldest ? this.#secondsLeft(oldest, now) : 1 };
  }

  #secondsLeft(window: Window, now: number): number {
    return Math.max(1, Math.ceil((window.start + this.#windowMs - now) / 1000));
  }

  /** Drops expired windows, at most once per window length unless forced. */
  #prune(now: number, force = false): void {
    if (!force && now - this.#lastPrune < this.#windowMs) return;
    this.#lastPrune = now;
    for (const [key, window] of this.#windows) {
      if (now - window.start >= this.#windowMs) this.#windows.delete(key);
    }
  }
}
