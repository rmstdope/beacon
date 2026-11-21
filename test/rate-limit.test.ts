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
});
