import type { HttpBindings } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { clientIp, rateLimitKey } from "./client-ip.js";
import type { Client } from "./config.js";
import { GitHubError, type IssueFiler } from "./github.js";
import { buildIssue } from "./issue.js";
import type { FixedWindowLimiter } from "./rate-limit.js";
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
}

const MAX_BODY_BYTES = 16 * 1024;
const MAX_USER_AGENT = 512;

type Env = { Bindings: Partial<HttpBindings> };

function fail(c: Context, status: 400 | 403 | 404 | 413 | 415 | 429 | 500 | 502, error: string, message: string) {
  return c.json({ error, message }, status);
}

export function createApp(options: AppOptions): Hono<Env> {
  const { clients, filer, ipLimiter, clientLimiter, revision } = options;
  const log = options.log ?? (() => undefined);
  const now = options.now ?? Date.now;
  const allOrigins = new Set([...clients.values()].flatMap((client) => client.origins));

  const app = new Hono<Env>();

  /** Sets CORS headers when the request's Origin belongs to some client. */
  function allowOrigin(c: Context): string | undefined {
    const origin = c.req.header("origin");
    if (origin === undefined || !allOrigins.has(origin)) return undefined;
    c.header("Access-Control-Allow-Origin", origin);
    c.header("Vary", "Origin");
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
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) => {
        log({ event: "report.rejected", status: 413 });
        return fail(c, 413, "too_large", `body is over ${String(MAX_BODY_BYTES / 1024)} KB`);
      },
    }),
    async (c) => {
      let input: unknown;
      try {
        input = await c.req.json();
      } catch {
        log({ event: "report.rejected", status: 400, field: "body" });
        return fail(c, 400, "invalid_report", "body is not valid JSON");
      }
      const parsed = parseReport(input);
      if (!parsed.ok) {
        log({ event: "report.rejected", status: 400, field: parsed.field });
        return fail(c, 400, "invalid_report", parsed.message);
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
      try {
        const reference = await filer.fileIssue(client.repo, buildIssue(report));
        log({
          event: "report.filed",
          client: report.clientId,
          type: report.type,
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
