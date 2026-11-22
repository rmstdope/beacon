import { describe, expect, it } from "vitest";
import { GitHubError, type IssueFiler } from "../src/github.js";
import type { Issue } from "../src/issue.js";
import { FixedWindowLimiter } from "../src/rate-limit.js";
import { createApp, type AppOptions } from "../src/server.js";
import type { Client, RepoRef } from "../src/config.js";

const RQ = "https://retroquest.rmstdope.eu";
const NESER = "https://neser.rmstdope.eu";

const clients = new Map<string, Client>([
  ["retroquest", { repo: { owner: "rmstdope", name: "retroquest" }, origins: [RQ] }],
  ["neser", { repo: { owner: "rmstdope", name: "neser" }, origins: [NESER] }],
]);

const report = {
  clientId: "retroquest",
  type: "bug",
  title: "Score resets",
  description: "SECRET-DESCRIPTION-TEXT",
};

class FakeFiler implements IssueFiler {
  filed: { repo: RepoRef; issue: Issue }[] = [];
  failWith: Error | undefined;
  fileIssue(repo: RepoRef, issue: Issue): Promise<number> {
    if (this.failWith) return Promise.reject(this.failWith);
    this.filed.push({ repo, issue });
    return Promise.resolve(100 + this.filed.length);
  }
  isInstalled(): Promise<boolean> {
    return Promise.resolve(true);
  }
}

function setup(overrides: Partial<AppOptions> = {}) {
  const filer = new FakeFiler();
  const logs: string[] = [];
  const now = () => 0;
  const app = createApp({
    clients,
    filer,
    ipLimiter: new FixedWindowLimiter({ limit: 5, windowMs: 600_000, now }),
    clientLimiter: new FixedWindowLimiter({ limit: 50, windowMs: 3_600_000, now }),
    revision: "0123456789abcdef0123456789abcdef01234567",
    log: (entry) => logs.push(JSON.stringify(entry)),
    ...overrides,
  });
  return { app, filer, logs };
}

function post(app: ReturnType<typeof setup>["app"], body: unknown, headers: Record<string, string> = {}) {
  return app.request("/v1/reports", {
    method: "POST",
    headers: { origin: RQ, "content-type": "application/json", "x-forwarded-for": "203.0.113.7", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function errorOf(res: Response) {
  return (await res.json()) as { error: string; message: string };
}

describe("POST /v1/reports", () => {
  it("files the report in the client's repository and returns the issue number", async () => {
    const { app, filer } = setup();
    const res = await post(app, report);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ reference: 101 });
    expect(filer.filed[0]?.repo).toEqual({ owner: "rmstdope", name: "retroquest" });
    expect(filer.filed[0]?.issue.labels).toEqual(["bug", "via-beacon"]);
    expect(filer.filed[0]?.issue.body).toContain("SECRET-DESCRIPTION-TEXT");
  });

  it("echoes the allowed origin for CORS, without credentials", async () => {
    const { app } = setup();
    const res = await post(app, report);
    expect(res.headers.get("access-control-allow-origin")).toBe(RQ);
    expect(res.headers.get("vary")).toContain("Origin");
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("uses the browser's User-Agent header when the report has none, capped at 512", async () => {
    const { app, filer } = setup();
    await post(app, report, { "user-agent": `Agent/${"x".repeat(600)}` });
    const body = filer.filed[0]?.issue.body ?? "";
    expect(body).toContain("| Browser | `Agent/");
    expect(body).not.toContain("x".repeat(520));
  });

  it("prefers the report's own userAgent", async () => {
    const { app, filer } = setup();
    await post(app, { ...report, userAgent: "Reported/1" }, { "user-agent": "Header/1" });
    expect(filer.filed[0]?.issue.body).toContain("`Reported/1`");
  });

  it("refuses a request without an Origin header", async () => {
    const { app, filer } = setup();
    const res = await app.request("/v1/reports", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(report),
    });
    expect(res.status).toBe(403);
    expect((await errorOf(res)).error).toBe("forbidden");
    expect(filer.filed).toHaveLength(0);
  });

  it("checks the origin before the body size", async () => {
    const { app } = setup();
    const res = await post(app, { ...report, description: "x".repeat(20_000) }, { origin: "https://evil.example" });
    expect(res.status).toBe(403);
  });

  it("falls back to the socket address without X-Forwarded-For", async () => {
    const { app } = setup();
    const env = { incoming: { socket: { remoteAddress: "198.51.100.9" } } };
    const send = () =>
      app.request(
        "/v1/reports",
        { method: "POST", headers: { origin: RQ, "content-type": "application/json" }, body: JSON.stringify(report) },
        env,
      );
    for (let i = 0; i < 5; i++) expect((await send()).status).toBe(201);
    expect((await send()).status).toBe(429);
    expect((await post(app, report, { "x-forwarded-for": "198.51.100.10" })).status).toBe(201);
  });

  it("limits a whole IPv6 /64 together", async () => {
    const { app } = setup();
    for (let i = 0; i < 5; i++) {
      expect((await post(app, report, { "x-forwarded-for": `2001:db8:1:2::${String(i + 1)}` })).status).toBe(201);
    }
    expect((await post(app, report, { "x-forwarded-for": "2001:db8:1:2:ffff::9" })).status).toBe(429);
    expect((await post(app, report, { "x-forwarded-for": "2001:db8:1:3::1" })).status).toBe(201);
  });

  it("does not spend an IP's allowance when the client limit refuses", async () => {
    const now = () => 0;
    const { app } = setup({ clientLimiter: new FixedWindowLimiter({ limit: 1, windowMs: 60_000, now }) });
    expect((await post(app, report, { "x-forwarded-for": "203.0.113.1" })).status).toBe(201);
    for (let i = 0; i < 6; i++) {
      expect((await post(app, report, { "x-forwarded-for": "203.0.113.2" })).status).toBe(429);
    }
    const neser = { ...report, clientId: "neser" };
    const fromNeser = { "x-forwarded-for": "203.0.113.2", origin: NESER };
    expect((await post(app, neser, fromNeser)).status).toBe(201);
  });

  it("refuses an origin no client allows, without CORS headers", async () => {
    const { app } = setup();
    const res = await post(app, report, { origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("refuses another client's origin and an unknown client alike", async () => {
    const { app } = setup();
    const wrongOrigin = await post(app, report, { origin: NESER });
    const unknownClient = await post(app, { ...report, clientId: "nope" });
    expect(wrongOrigin.status).toBe(403);
    expect(unknownClient.status).toBe(403);
    expect(await errorOf(wrongOrigin)).toEqual(await errorOf(unknownClient));
  });

  it("refuses a body that is not JSON by content type", async () => {
    const { app } = setup();
    const res = await post(app, JSON.stringify(report), { "content-type": "text/plain" });
    expect(res.status).toBe(415);
    expect((await errorOf(res)).error).toBe("unsupported_media_type");
  });

  it("accepts a JSON content type with a charset", async () => {
    const { app } = setup();
    const res = await post(app, report, { "content-type": "application/json; charset=utf-8" });
    expect(res.status).toBe(201);
  });

  it("refuses a body over 16 KB", async () => {
    const { app } = setup();
    const res = await post(app, { ...report, description: "x".repeat(17_000) });
    expect(res.status).toBe(413);
    expect((await errorOf(res)).error).toBe("too_large");
  });

  it("rejects malformed JSON", async () => {
    const { app } = setup();
    const res = await post(app, "{not json");
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toMatchObject({ error: "invalid_report", field: "body" });
  });

  it("names the invalid field", async () => {
    const { app } = setup();
    const res = await post(app, { ...report, type: "question" });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toMatchObject({
      error: "invalid_report",
      field: "type",
      message: expect.stringContaining("type") as unknown,
    });
  });

  it("limits each client IP to 5 reports, read from the rightmost X-Forwarded-For entry", async () => {
    const { app } = setup();
    for (let i = 0; i < 5; i++) {
      expect((await post(app, report, { "x-forwarded-for": `10.0.0.${String(i)}, 203.0.113.7` })).status).toBe(201);
    }
    const res = await post(app, report, { "x-forwarded-for": "10.9.9.9, 203.0.113.7" });
    expect(res.status).toBe(429);
    expect((await errorOf(res)).error).toBe("rate_limited");
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await post(app, report, { "x-forwarded-for": "203.0.113.8" })).status).toBe(201);
  });

  it("limits each client ID", async () => {
    const now = () => 0;
    const { app } = setup({ clientLimiter: new FixedWindowLimiter({ limit: 1, windowMs: 60_000, now }) });
    expect((await post(app, report, { "x-forwarded-for": "203.0.113.1" })).status).toBe(201);
    expect((await post(app, report, { "x-forwarded-for": "203.0.113.2" })).status).toBe(429);
  });

  it("does not count rejected requests against the rate limit", async () => {
    const { app } = setup();
    for (let i = 0; i < 10; i++) await post(app, { ...report, type: "question" });
    expect((await post(app, report)).status).toBe(201);
  });

  it("answers 502 when GitHub fails, without retrying", async () => {
    const { app, filer } = setup();
    filer.failWith = new GitHubError("GitHub answered 503");
    const res = await post(app, report);
    expect(res.status).toBe(502);
    expect((await errorOf(res)).error).toBe("upstream_failed");
  });

  it("answers 500 for an unexpected failure", async () => {
    const { app, filer } = setup();
    filer.failWith = new Error("bug");
    const res = await post(app, report);
    expect(res.status).toBe(500);
    expect((await errorOf(res)).error).toBe("internal");
  });

  it("never logs report text or client IPs", async () => {
    const { app, logs, filer } = setup();
    await post(app, report);
    filer.failWith = new GitHubError("GitHub answered 503");
    await post(app, report);
    for (let i = 0; i < 6; i++) await post(app, report);
    await post(app, { ...report, "SECRET-KEY-NAME": 1 });
    const all = logs.join("\n");
    expect(logs.length).toBeGreaterThan(0);
    expect(all).not.toContain("SECRET-DESCRIPTION-TEXT");
    expect(all).not.toContain("Score resets");
    expect(all).not.toContain("203.0.113.7");
    expect(all).not.toContain("SECRET-KEY-NAME");
  });
});

describe("OPTIONS /v1/reports", () => {
  it("answers a preflight from any configured origin", async () => {
    const { app } = setup();
    const res = await app.request("/v1/reports", {
      method: "OPTIONS",
      headers: { origin: NESER, "access-control-request-method": "POST" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(NESER);
    expect(res.headers.get("access-control-allow-methods")).toBe("POST");
    expect(res.headers.get("access-control-allow-headers")).toBe("Content-Type");
    expect(res.headers.get("access-control-max-age")).toBe("600");
  });

  it("refuses a preflight from an unknown origin", async () => {
    const { app } = setup();
    const res = await app.request("/v1/reports", {
      method: "OPTIONS",
      headers: { origin: "https://evil.example", "access-control-request-method": "POST" },
    });
    expect(res.status).toBe(403);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("GET /healthz and /release.json", () => {
  it("reports health", async () => {
    const res = await setup().app.request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("serves the release revision, revalidated", async () => {
    const res = await setup().app.request("/release.json");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revision: "0123456789abcdef0123456789abcdef01234567" });
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });

  it("has no release marker when no revision is known", async () => {
    const res = await setup({ revision: undefined }).app.request("/release.json");
    expect(res.status).toBe(404);
  });

  it("answers unknown paths with a JSON 404", async () => {
    const res = await setup().app.request("/nope");
    expect(res.status).toBe(404);
    expect((await errorOf(res)).error).toBe("not_found");
  });
});
