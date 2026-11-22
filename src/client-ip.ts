import { isIPv6 } from "node:net";

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

/** Expands a valid IPv6 address to its eight hextets, lower case, without leading zeros. */
function hextets(address: string): string[] {
  let text = address.toLowerCase().replace(/%.*$/, ""); // drop a zone ID
  // An embedded dotted IPv4 tail (::ffff:1.2.3.4) is two hextets.
  text = text.replace(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/, (_match, a: string, b: string, c: string, d: string) => {
    const [w, x, y, z] = [a, b, c, d].map(Number) as [number, number, number, number];
    return `${((w << 8) | x).toString(16)}:${((y << 8) | z).toString(16)}`;
  });
  const [head = "", tail = ""] = text.split("::");
  const left = head === "" ? [] : head.split(":");
  const right = text.includes("::") ? (tail === "" ? [] : tail.split(":")) : [];
  const zeros = Array<string>(8 - left.length - right.length).fill("0");
  return [...left, ...zeros, ...right].map((part) => part.replace(/^0+(?=.)/, ""));
}

/**
 * The key an address is rate-limited under. One IPv6 subscriber is usually given a whole /64, so
 * IPv6 addresses are limited by their /64 rather than one by one.
 */
export function rateLimitKey(ip: string): string {
  if (!isIPv6(ip)) return ip;
  const parts = hextets(ip);
  // An IPv4-mapped address (::ffff:1.2.3.4, in any notation) is one IPv4 address.
  if (parts.slice(0, 5).every((part) => part === "0") && parts[5] === "ffff") {
    const [high = 0, low = 0] = parts.slice(6).map((part) => parseInt(part, 16));
    return [high >> 8, high & 255, low >> 8, low & 255].join(".");
  }
  return `${parts.slice(0, 4).join(":")}::/64`;
}
