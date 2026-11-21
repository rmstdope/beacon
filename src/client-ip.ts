import { isIPv4, isIPv6 } from "node:net";

/**
 * The client's IP address as Caddy saw it.
 *
 * Caddy appends the address it accepted the connection from to `X-Forwarded-For`. Everything to
 * the left of that entry was sent by the client and can be anything, so only the rightmost entry
 * is trusted. Other containers on the shared proxy network could reach Beacon directly and set the
 * header freely; rmstdope-infra treats those apps as trusted.
 */
export function clientIp(forwardedFor: string | undefined, socketAddress: string | undefined): string {
  const entries = (forwardedFor ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  return entries.at(-1) ?? socketAddress ?? "unknown";
}

/** Expands an IPv6 address to its eight hextets. */
function hextets(address: string): string[] {
  const [head = "", tail = ""] = address.toLowerCase().split("::");
  const left = head === "" ? [] : head.split(":");
  const right = address.includes("::") ? (tail === "" ? [] : tail.split(":")) : [];
  const zeros = Array<string>(8 - left.length - right.length).fill("0");
  return [...left, ...zeros, ...right].map((part) => part.replace(/^0+(?=.)/, ""));
}

/**
 * The key an address is rate-limited under. One IPv6 subscriber is usually given a whole /64, so
 * IPv6 addresses are limited by their /64 rather than one by one.
 */
export function rateLimitKey(ip: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped?.[1] !== undefined && isIPv4(mapped[1])) return mapped[1];
  if (!isIPv6(ip)) return ip;
  const parts = hextets(ip);
  // An IPv4-mapped address written in hex (::ffff:cb00:7107) is still one IPv4 address.
  if (parts.slice(0, 5).every((part) => part === "0") && parts[5] === "ffff" && !ip.includes(".")) {
    const [high = 0, low = 0] = parts.slice(6).map((part) => parseInt(part, 16));
    return [high >> 8, high & 255, low >> 8, low & 255].join(".");
  }
  return `${parts.slice(0, 4).join(":")}::/64`;
}
