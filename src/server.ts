import { randomBytes } from "node:crypto";
import type { HttpBindings } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { clientIp, rateLimitKey } from "./client-ip.js";
import type { Client } from "./config.js";
import { GitHubError, type IssueFiler, type ScreenshotFile } from "./github.js";
import { buildIssue } from "./issue.js";
import type { FixedWindowLimiter } from "./rate-limit.js";
import type { CleanImage, ImageType } from "./image.js";
import { parseReport } from "./report.js";

export type LogEntry = { event: string } & Record<string, string | number | boolean>;

export interface AppOptions {
  clients: Map<string, Client>;
  filer: IssueFiler;
  ipLimiter: FixedWindowLimiter;
  clientLimiter: FixedWindowLimiter;
  /** Full commit SHA served at /release.json; absent outside a release image. */
  revision?: string | undefined;
  /** Receives one entry per request outcome. Never given report text or client IPs. */
  log?: (entry: LogEntry) => void;
  now?: () => number;
  /** Six lowercase hex digits naming a report's screenshot folder; random by default. */
  randomHex?: () => string;
  /** Large bodies read and handled at once; the rest wait their turn. Defaults to 3. */
  maxLargeInFlight?: number;
}

/** Three 2 MiB screenshots, base64-encoded, plus the text. */
const MAX_BODY_BYTES = 9 * 1024 * 1024;
const MAX_USER_AGENT = 512;

type Env = { Bindings: Partial<HttpBindings> };

/** Bodies up to this size (a report without screenshots) are never made to wait. */
const SMALL_BODY_BYTES = 16 * 1024;

/**
 * Lets `limit` holders in at once and queues the rest in order. A queued request has not had its
 * body read, so it holds a socket, not memory: the rate limits are checked only after parsing,
 * and this is what bounds the memory a flood of 9 MB requests can take.
 */
function slots(limit: number): () => Promise<() => void> {
  let free = limit;
  const waiting: (() => void)[] = [];
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else free++;
  };
  return async () => {
    if (free > 0) free--;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    return release;
  };
}

const EXTENSIONS: Record<ImageType, string> = { png: "png", jpeg: "jpg", webp: "webp" };

/** `YYYY-MM-DD-<6 hex>/<N>.<ext>`, N counting from 1 in the order sent. */
function screenshotFiles(images: readonly CleanImage[], now: number, code: string): ScreenshotFile[] {
  const folder = `${new Date(now).toISOString().slice(0, 10)}-${code}`;
  return images.map((image, index) => ({
    path: `${folder}/${String(index + 1)}.${EXTENSIONS[image.type]}`,
    bytes: image.bytes,
  }));
}

function fail(
  c: Context,
  status: 400 | 403 | 404 | 413 | 415 | 429 | 500 | 502,
  error: string,
  message: string,
  extra: { field?: string } = {},
) {
  return c.json({ error, message, ...extra }, status);
}

export function createApp(options: AppOptions): Hono<Env> {
  const { clients, filer, ipLimiter, clientLimiter, revision } = options;
  const log = options.log ?? (() => undefined);
  const now = options.now ?? Date.now;
  const randomHex = options.randomHex ?? (() => randomBytes(3).toString("hex"));
  const largeBody = slots(options.maxLargeInFlight ?? 3);
  const allOrigins = new Set([...clients.values()].flatMap((client) => client.origins));

  const app = new Hono<Env>();

  /** Sets CORS headers when the request's Origin belongs to some client. */
  function allowOrigin(c: Context): string | undefined {
    const origin = c.req.header("origin");
    if (origin === undefined || !allOrigins.has(origin)) return undefined;
    c.header("Access-Control-Allow-Origin", origin);
    c.header("Vary", "Origin");
    // Not CORS-safelisted: without this a browser hides a 429's Retry-After from the frontend.
    c.header("Access-Control-Expose-Headers", "Retry-After");
    return origin;
  }

  app.get("/healthz", (c) => c.json({ status: "ok" }));

  app.get("/release.json", (c) => {
    if (revision === undefined) return fail(c, 404, "not_found", "no release marker in this build");
    c.header("Cache-Control", "no-cache");
    return c.json({ revision });
  });

  app.options("/v1/reports", (c) => {
    if (allowOrigin(c) === undefined) return fail(c, 403, "forbidden", "origin not allowed");
    c.header("Access-Control-Allow-Methods", "POST");
    c.header("Access-Control-Allow-Headers", "Content-Type");
    c.header("Access-Control-Max-Age", "600");
    return c.body(null, 204);
  });

  app.post(
    "/v1/reports",
    async (c, next) => {
      if (allowOrigin(c) === undefined) {
        log({ event: "report.rejected", status: 403, reason: "origin" });
        return fail(c, 403, "forbidden", "client or origin not allowed");
      }
      const contentType = c.req.header("content-type") ?? "";
      if (!/^application\/json\s*(;|$)/i.test(contentType)) {
        log({ event: "report.rejected", status: 415 });
        return fail(c, 415, "unsupported_media_type", "send application/json");
      }
      await next();
    },
    async (c, next) => {
      // A declared length over the limit is refused by bodyLimit at once, without waiting; an
      // unknown length (chunked) could be anything, so it waits like a large one.
      const header = c.req.header("content-length");
      const length = header === undefined ? NaN : Number(header);
      if (length <= SMALL_BODY_BYTES || length > MAX_BODY_BYTES) return next();
      const release = await largeBody();
      try {
        await next();
      } finally {
        release();
      }
    },
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) => {
        log({ event: "report.rejected", status: 413 });
        return fail(c, 413, "too_large", `body is over ${String(MAX_BODY_BYTES / 1024 / 1024)} MB`);
      },
    }),
    async (c) => {
      let input: unknown;
      try {
        input = await c.req.json();
      } catch {
        log({ event: "report.rejected", status: 400, field: "body" });
        return fail(c, 400, "invalid_report", "body is not valid JSON", { field: "body" });
      }
      const parsed = parseReport(input);
      if (!parsed.ok) {
        log({ event: "report.rejected", status: parsed.status, field: parsed.field });
        return fail(c, parsed.status, parsed.error, parsed.message, { field: parsed.field });
      }
      const report = parsed.report;

      const client = clients.get(report.clientId);
      if (client === undefined || !client.origins.includes(c.req.header("origin") ?? "")) {
        log({ event: "report.rejected", status: 403, reason: "client" });
        return fail(c, 403, "forbidden", "client or origin not allowed");
      }

      // c.env is undefined when the app is driven without a Node server, as in tests.
      const bindings = c.env as Partial<HttpBindings> | undefined;
      const ip = clientIp(c.req.header("x-forwarded-for"), bindings?.incoming?.socket.remoteAddress);
      const limits = [
        ["ip", ipLimiter, rateLimitKey(ip)],
        ["client", clientLimiter, report.clientId],
      ] as const;
      // Check every limit before recording any, so one limit's refusal spends no other allowance.
      for (const [limit, limiter, key] of limits) {
        const result = limiter.peek(key);
        if (!result.allowed) {
          log({ event: "report.rate_limited", client: report.clientId, limit });
          c.header("Retry-After", String(result.retryAfterSeconds));
          return fail(c, 429, "rate_limited", "too many reports; try again later");
        }
      }
      for (const [, limiter, key] of limits) limiter.hit(key);

      if (report.userAgent === undefined) {
        const header = c.req.header("user-agent");
        if (header) report.userAgent = header.slice(0, MAX_USER_AGENT);
      }

      const started = now();
      const images = report.screenshots ?? [];
      const files = images.length > 0 ? screenshotFiles(images, started, randomHex()) : [];
      try {
        const reference = await filer.fileIssue(client.repo, (urls) => buildIssue(report, urls), files);
        log({
          event: "report.filed",
          client: report.clientId,
          type: report.type,
          screenshots: files.length,
          issue: reference,
          githubMs: now() - started,
        });
        return c.json({ reference }, 201);
      } catch (error) {
        if (error instanceof GitHubError) {
          log({ event: "report.upstream_failed", client: report.clientId, reason: error.message });
          return fail(c, 502, "upstream_failed", "GitHub did not accept the report; try again later");
        }
        log({ event: "report.failed", client: report.clientId, reason: error instanceof Error ? error.name : "unknown" });
        return fail(c, 500, "internal", "unexpected error");
      }
    },
  );

  app.notFound((c) => fail(c, 404, "not_found", "no such endpoint"));
  app.onError((error, c) => {
    log({ event: "request.failed", reason: error.name });
    return fail(c, 500, "internal", "unexpected error");
  });

  return app;
}
