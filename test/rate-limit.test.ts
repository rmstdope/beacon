import { describe, expect, it } from "vitest";
import { FixedWindowLimiter } from "../src/rate-limit.js";

function clock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe("FixedWindowLimiter", () => {
  it("allows up to the limit within a window, then refuses with a retry delay", () => {
    const c = clock(1_000);
    const limiter = new FixedWindowLimiter({ limit: 2, windowMs: 60_000, now: c.now });
    expect(limiter.hit("a")).toEqual({ allowed: true });
    expect(limiter.hit("a")).toEqual({ allowed: true });
    c.advance(15_000);
    expect(limiter.hit("a")).toEqual({ allowed: false, retryAfterSeconds: 45 });
  });

  it("counts keys separately", () => {
    const limiter = new FixedWindowLimiter({ limit: 1, windowMs: 60_000, now: clock().now });
    expect(limiter.hit("a").allowed).toBe(true);
    expect(limiter.hit("b").allowed).toBe(true);
    expect(limiter.hit("a").allowed).toBe(false);
  });

  it("starts a fresh window once the old one has passed", () => {
    const c = clock();
    const limiter = new FixedWindowLimiter({ limit: 1, windowMs: 60_000, now: c.now });
    limiter.hit("a");
    c.advance(60_000);
    expect(limiter.hit("a").allowed).toBe(true);
  });

  it("rounds the retry delay up to at least one second", () => {
    const c = clock();
    const limiter = new FixedWindowLimiter({ limit: 1, windowMs: 60_000, now: c.now });
    limiter.hit("a");
    c.advance(59_999);
    expect(limiter.hit("a")).toEqual({ allowed: false, retryAfterSeconds: 1 });
  });

  it("forgets expired keys, so memory stays bounded under a flood", () => {
    const c = clock();
    const limiter = new FixedWindowLimiter({ limit: 5, windowMs: 1_000, now: c.now });
    for (let i = 0; i < 1_000; i++) limiter.hit(`ip-${String(i)}`);
    expect(limiter.size).toBe(1_000);
    c.advance(1_000);
    limiter.hit("late");
    expect(limiter.size).toBe(1);
  });

  it("peeks without consuming", () => {
    const limiter = new FixedWindowLimiter({ limit: 1, windowMs: 60_000, now: clock().now });
    expect(limiter.peek("a").allowed).toBe(true);
    expect(limiter.peek("a").allowed).toBe(true);
    limiter.hit("a");
    expect(limiter.peek("a")).toEqual({ allowed: false, retryAfterSeconds: 60 });
  });

  it("refuses new keys once it tracks maxKeys live ones, so a flood cannot exhaust memory", () => {
    const c = clock();
    const limiter = new FixedWindowLimiter({ limit: 5, windowMs: 1_000, maxKeys: 3, now: c.now });
    for (const key of ["a", "b", "c"]) expect(limiter.hit(key).allowed).toBe(true);
    expect(limiter.hit("d")).toEqual({ allowed: false, retryAfterSeconds: 1 });
    expect(limiter.hit("a").allowed).toBe(true);
    expect(limiter.size).toBe(3);
    c.advance(1_000);
    expect(limiter.hit("d").allowed).toBe(true);
  });

  it("reports the oldest live window's wait when full, even after a key's window was renewed", () => {
    const c = clock();
    const limiter = new FixedWindowLimiter({ limit: 5, windowMs: 10_000, maxKeys: 2, now: c.now });
    limiter.hit("a"); // a@0
    c.advance(9_000);
    limiter.hit("x"); // x@9000
    c.advance(1_000);
    limiter.hit("b"); // the periodic prune drops a; b@10000
    c.advance(9_500);
    limiter.hit("x"); // x expired but not yet pruned: renewed in place, x@19500
    c.advance(100);
    // b, not x, is now the oldest live window: it ends at 20000, 400 ms away.
    expect(limiter.hit("c")).toEqual({ allowed: false, retryAfterSeconds: 1 });
  });
});

