import { describe, expect, it } from "vitest";
import { clientIp, rateLimitKey } from "../src/client-ip.js";

describe("clientIp", () => {
  it("takes the rightmost X-Forwarded-For entry, the one Caddy added", () => {
    expect(clientIp("6.6.6.6, 203.0.113.7", "172.18.0.2")).toBe("203.0.113.7");
  });

  it("trims whitespace around the entry", () => {
    expect(clientIp("  203.0.113.7  ", "172.18.0.2")).toBe("203.0.113.7");
  });

  it("ignores empty trailing entries", () => {
    expect(clientIp("203.0.113.7, ", "172.18.0.2")).toBe("203.0.113.7");
  });

  it("falls back to the socket address without the header", () => {
    expect(clientIp(undefined, "172.18.0.2")).toBe("172.18.0.2");
    expect(clientIp("", "172.18.0.2")).toBe("172.18.0.2");
  });

  it("returns unknown with neither", () => {
    expect(clientIp(undefined, undefined)).toBe("unknown");
  });
});

describe("rateLimitKey", () => {
  it("keys IPv4 by the whole address", () => {
    expect(rateLimitKey("203.0.113.7")).toBe("203.0.113.7");
  });

  it("keys IPv6 by its /64, since one subscriber holds a whole /64", () => {
    expect(rateLimitKey("2001:db8:1:2:aaaa::1")).toBe("2001:db8:1:2::/64");
    expect(rateLimitKey("2001:db8:1:2:ffff:ffff:ffff:ffff")).toBe("2001:db8:1:2::/64");
    expect(rateLimitKey("2001:DB8::1")).toBe("2001:db8:0:0::/64");
    expect(rateLimitKey("::1")).toBe("0:0:0:0::/64");
  });

  it("treats an IPv4-mapped IPv6 address as IPv4", () => {
    expect(rateLimitKey("::ffff:203.0.113.7")).toBe("203.0.113.7");
  });

  it("passes through anything else unchanged", () => {
    expect(rateLimitKey("unknown")).toBe("unknown");
  });
});
