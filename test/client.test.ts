import { readFileSync } from "node:fs";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import * as client from "../src/client.js";
import { createBeacon, type BeaconOptions, type ReportResult } from "../src/client.js";
import type { Client, RepoRef } from "../src/config.js";
import { GitHubError, type IssueFiler } from "../src/github.js";
import type { Issue } from "../src/issue.js";
import { FixedWindowLimiter } from "../src/rate-limit.js";
import * as server from "../src/report.js";
import { createApp, type AppOptions } from "../src/server.js";

const RQ = "https://retroquest.rmstdope.eu";
const ENDPOINT = "https://beacon.test";

const clients = new Map<string, Client>([
  ["retroquest", { repo: { owner: "rmstdope", name: "retroquest" }, origins: [RQ] }],
]);

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

function urlOf(input: Parameters<typeof fetch>[0]): string {
  return input instanceof Request ? input.url : input.toString();
}

/** A browser on `origin`, talking to the real Beacon app instead of the network. */
function setup(options: { origin?: string; app?: Partial<AppOptions>; client?: Partial<BeaconOptions> } = {}) {
  const filer = new FakeFiler();
  const now = () => 0;
  const app = createApp({
    clients,
    filer,
    ipLimiter: new FixedWindowLimiter({ limit: 5, windowMs: 600_000, now }),
    clientLimiter: new FixedWindowLimiter({ limit: 50, windowMs: 3_600_000, now }),
    ...options.app,
  });
  const requests: { url: string; body: Record<string, unknown> }[] = [];
  const fetchViaApp: typeof fetch = async (input, init) => {
    const url = urlOf(input);
    requests.push({ url, body: JSON.parse(init?.body as string) as Record<string, unknown> });
    const headers = new Headers(init?.headers);
    headers.set("origin", options.origin ?? RQ);
    headers.set("x-forwarded-for", "203.0.113.7");
    return app.request(url.replace(ENDPOINT, ""), { ...init, headers });
  };
  const beacon = createBeacon({ clientId: "retroquest", endpoint: ENDPOINT, fetch: fetchViaApp, ...options.client });
  return { beacon, filer, requests };
}

/** A client whose every request gets `response`, or a rejection when given an Error. */
function stubbed(response: Response | Error) {
  return createBeacon({
    clientId: "retroquest",
    endpoint: ENDPOINT,
    fetch: () => (response instanceof Error ? Promise.reject(response) : Promise.resolve(response)),
  });
}

function errorResponse(status: number, error: string, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify({ error, message: `developer text for ${error}` }), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

const bug = { type: "bug", title: "Score resets", description: "It resets when resized." } as const;

function errorOf(result: ReportResult) {
  if (result.ok) throw new Error(`expected an error, got reference ${String(result.reference)}`);
  return result.error;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Beacon client, against the real app", () => {
  it("files a report with one call and returns its reference", async () => {
    const { beacon, filer, requests } = setup();
    expect(await beacon.report(bug)).toEqual({ ok: true, reference: 101 });
    expect(requests[0]?.url).toBe(`${ENDPOINT}/v1/reports`);
    expect(filer.filed[0]?.repo).toEqual({ owner: "rmstdope", name: "retroquest" });
    expect(filer.filed[0]?.issue.title).toBe("Score resets");
    expect(filer.filed[0]?.issue.body).toContain("It resets when resized.");
  });

  it("defaults the endpoint to Beacon's public address", async () => {
    let url = "";
    const beacon = createBeacon({
      clientId: "retroquest",
      fetch: (input) => {
        url = urlOf(input);
        return Promise.resolve(new Response(JSON.stringify({ reference: 7 }), { status: 201 }));
      },
    });
    expect(await beacon.report(bug)).toEqual({ ok: true, reference: 7 });
    expect(url).toBe("https://beacon.rmstdope.eu/v1/reports");
  });

  it("fills in the page, without its query or fragment, the user agent and the app version", async () => {
    vi.stubGlobal("location", new URL(`${RQ}/play/3?token=SECRET#level`));
    vi.stubGlobal("navigator", { userAgent: "TestBrowser/1.0" });
    const { beacon, filer, requests } = setup({ client: { appVersion: "1.4.2" } });
    expect((await beacon.report(bug)).ok).toBe(true);
    expect(requests[0]?.body).toMatchObject({
      clientId: "retroquest",
      pageUrl: `${RQ}/play/3`,
      userAgent: "TestBrowser/1.0",
      appVersion: "1.4.2",
    });
    expect(filer.filed[0]?.issue.body).not.toContain("SECRET");
  });

  it("leaves out a page that is not http(s) or is too long, and still files the report", async () => {
    vi.stubGlobal("location", new URL("file:///home/me/index.html"));
    const first = setup();
    expect((await first.beacon.report(bug)).ok).toBe(true);
    expect(first.requests[0]?.body).not.toHaveProperty("pageUrl");

    vi.stubGlobal("location", new URL(`${RQ}/${"a".repeat(2_100)}`));
    const second = setup();
    expect((await second.beacon.report(bug)).ok).toBe(true);
    expect(second.requests[0]?.body).not.toHaveProperty("pageUrl");
  });

  it("cuts the user agent at the server's 512-character limit", async () => {
    vi.stubGlobal("navigator", { userAgent: "U".repeat(600) });
    const { beacon, requests } = setup();
    expect((await beacon.report(bug)).ok).toBe(true);
    expect(requests[0]?.body.userAgent).toBe("U".repeat(512));
  });

  it("reports an invalid report as invalid_report naming the field", async () => {
    const { beacon } = setup();
    expect(errorOf(await beacon.report({ ...bug, title: "x" }))).toMatchObject({ code: "invalid_report", field: "title" });
  });

  // A refused origin gets no CORS headers, so a browser's fetch rejects (network); this is the 403 it can see.
  it("reports an unknown client ID as forbidden", async () => {
    const { beacon } = setup({ client: { clientId: "unknown" } });
    expect(errorOf(await beacon.report(bug)).code).toBe("forbidden");
  });

  it("reports an oversized body as too_large", async () => {
    const { beacon } = setup();
    expect(errorOf(await beacon.report({ ...bug, description: "x".repeat(20_000) })).code).toBe("too_large");
  });

  it("reports a rate limit as rate_limited with the seconds to wait", async () => {
    const limiter = new FixedWindowLimiter({ limit: 1, windowMs: 600_000, now: () => 0 });
    const { beacon } = setup({ app: { clientLimiter: limiter } });
    expect((await beacon.report(bug)).ok).toBe(true);
    expect(errorOf(await beacon.report(bug))).toMatchObject({ code: "rate_limited", retryAfterSeconds: 600 });
  });

  it("reports a GitHub failure as upstream_failed", async () => {
    const { beacon, filer } = setup();
    filer.failWith = new GitHubError("issue creation failed: 503");
    expect(errorOf(await beacon.report(bug)).code).toBe("upstream_failed");
  });

  it("reports a failure inside Beacon as internal", async () => {
    const { beacon, filer } = setup();
    filer.failWith = new Error("boom");
    expect(errorOf(await beacon.report(bug)).code).toBe("internal");
  });
});

describe("Beacon client, against responses the real client cannot provoke", () => {
  it("passes the server's code and developer message through", async () => {
    expect(errorOf(await stubbed(errorResponse(415, "unsupported_media_type")).report(bug))).toEqual({
      code: "unsupported_media_type",
      message: "developer text for unsupported_media_type",
    });
  });

  it("reports a request that never got a response as network", async () => {
    expect(errorOf(await stubbed(new TypeError("Failed to fetch")).report(bug)).code).toBe("network");
  });

  it("reports an undocumented response as unexpected, with its status", async () => {
    const html = new Response("<html>Not found</html>", { status: 404 });
    expect(errorOf(await stubbed(html).report(bug))).toMatchObject({ code: "unexpected", status: 404 });
    const noReference = new Response(JSON.stringify({ ok: true }), { status: 201 });
    expect(errorOf(await stubbed(noReference).report(bug))).toMatchObject({ code: "unexpected", status: 201 });
    for (const reference of [0, 1.5, "12"]) {
      const notAnIssue = new Response(JSON.stringify({ reference }), { status: 201 });
      expect(errorOf(await stubbed(notAnIssue).report(bug))).toMatchObject({ code: "unexpected", status: 201 });
    }
    const unknownCode = errorResponse(418, "teapot");
    expect(errorOf(await stubbed(unknownCode).report(bug))).toMatchObject({ code: "unexpected", status: 418 });
    const badField = new Response(JSON.stringify({ error: "invalid_report", message: "m" }), { status: 400 });
    expect(errorOf(await stubbed(badField).report(bug))).toMatchObject({ code: "invalid_report", field: "body" });
  });

  it("waits 60 seconds when a rate limit names no usable Retry-After", async () => {
    expect(errorOf(await stubbed(errorResponse(429, "rate_limited")).report(bug))).toMatchObject({
      code: "rate_limited",
      retryAfterSeconds: 60,
    });
    const garbled = errorResponse(429, "rate_limited", { "retry-after": "soon" });
    expect(errorOf(await stubbed(garbled).report(bug))).toMatchObject({ retryAfterSeconds: 60 });
    const given = errorResponse(429, "rate_limited", { "retry-after": "17" });
    expect(errorOf(await stubbed(given).report(bug))).toMatchObject({ retryAfterSeconds: 17 });
  });
});

describe("Beacon client file", () => {
  it("shares the report types with the server", () => {
    expectTypeOf<client.ReportType>().toEqualTypeOf<server.ReportType>();
    expect(client.REPORT_TYPES).toEqual(server.REPORT_TYPES);
  });

  it("has no imports, so it can be copied into a frontend as it is", () => {
    const source = readFileSync(new URL("../src/client.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/^\s*import\b/m);
    expect(source).not.toMatch(/\brequire\(/);
  });
});
