import { describe, expect, it } from "vitest";
import { clientIp } from "../src/client-ip.js";

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
