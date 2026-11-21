/**
 * The client's IP address as Caddy saw it.
 *
 * Caddy is the only peer that can reach Beacon, and it appends the address it accepted the
 * connection from to `X-Forwarded-For`. Everything to the left of that entry was sent by the
 * client and can be anything, so only the rightmost entry is trusted.
 */
export function clientIp(forwardedFor: string | undefined, socketAddress: string | undefined): string {
  const entries = (forwardedFor ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  return entries.at(-1) ?? socketAddress ?? "unknown";
}
