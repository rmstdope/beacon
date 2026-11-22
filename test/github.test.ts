import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GitHubAppFiler, GitHubError } from "../src/github.js";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const publicKey = createPublicKey(privateKey);

const repo = { owner: "rmstdope", name: "retroquest" };
const issue = { title: "Score resets", body: "body", labels: ["bug", "via-beacon"] };

interface Call { method: string; path: string; auth: string; headers: Headers; body: unknown }
type Route = (call: Call) => Response | Promise<Response>;

function json(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function fakeGitHub(overrides: Record<string, Route> = {}) {
  const calls: Call[] = [];
  const existingLabels = new Set(["bug"]);
  const routes: Record<string, Route> = {
    "GET /repos/rmstdope/retroquest/installation": () => json(200, { id: 42 }),
    "POST /app/installations/42/access_tokens": () =>
      json(201, { token: "ghs_test", expires_at: new Date(Date.parse("2026-11-22T13:00:00Z")).toISOString() }),
    "POST /repos/rmstdope/retroquest/issues": () => json(201, { number: 17 }),
    "POST /repos/rmstdope/retroquest/labels": (call) => {
      existingLabels.add((call.body as { name: string }).name);
      return json(201, {});
    },
    ...overrides,
  };
  const fetchFn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    expect(url.origin).toBe("https://api.github.com");
    const headers = new Headers(init?.headers);
    const call: Call = {
      method: init?.method ?? "GET",
      path: url.pathname,
      auth: headers.get("authorization") ?? "",
      headers,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const label = /^\/repos\/rmstdope\/retroquest\/labels\/(.+)$/.exec(call.path);
    if (call.method === "GET" && label && !overrides[`GET ${call.path}`]) {
      return existingLabels.has(decodeURIComponent(label[1] ?? "")) ? json(200, {}) : json(404, {});
    }
    const route = routes[`${call.method} ${call.path}`];
    return route ? route(call) : json(404, { message: "Not Found" });
  };
  return { calls, fetch: fetchFn };
}

function filer(gh: ReturnType<typeof fakeGitHub>, now = () => Date.parse("2026-11-22T12:00:00Z")) {
  return new GitHubAppFiler({ appId: "5861192", privateKeyPem, fetch: gh.fetch, now });
}

function decodeJwt(auth: string) {
  const token = auth.replace(/^Bearer /, "");
  const [header, payload, signature] = token.split(".") as [string, string, string];
  const valid = verify(
    "sha256",
    Buffer.from(`${header}.${payload}`),
    publicKey,
    Buffer.from(signature, "base64url"),
  );
  return {
    valid,
    header: JSON.parse(Buffer.from(header, "base64url").toString()) as Record<string, unknown>,
    payload: JSON.parse(Buffer.from(payload, "base64url").toString()) as Record<string, unknown>,
  };
}

describe("GitHubAppFiler.fileIssue", () => {
  it("files the issue and returns its number", async () => {
    const gh = fakeGitHub();
    expect(await filer(gh).fileIssue(repo, issue)).toBe(17);
    const created = gh.calls.find((c) => c.method === "POST" && c.path.endsWith("/issues"));
    expect(created?.body).toEqual(issue);
    expect(created?.auth).toBe("token ghs_test");
  });

  it("authenticates as the app with a signed, short-lived JWT", async () => {
    const gh = fakeGitHub();
    await filer(gh).fileIssue(repo, issue);
    const lookup = gh.calls[0];
    expect(lookup?.path).toBe("/repos/rmstdope/retroquest/installation");
    const jwt = decodeJwt(lookup?.auth ?? "");
    expect(jwt.valid).toBe(true);
    expect(jwt.header).toEqual({ alg: "RS256", typ: "JWT" });
    const now = Date.parse("2026-11-22T12:00:00Z") / 1000;
    expect(jwt.payload).toEqual({ iss: "5861192", iat: now - 60, exp: now + 540 });
  });

  it("sends GitHub's API headers on every request", async () => {
    const gh = fakeGitHub();
    await filer(gh).fileIssue(repo, issue);
    for (const call of gh.calls) {
      expect(call.headers.get("accept")).toBe("application/vnd.github+json");
      expect(call.headers.get("x-github-api-version")).toBe("2022-11-28");
      expect(call.headers.get("user-agent")).toBe("beacon");
    }
  });

  it("creates missing labels once, and leaves existing ones alone", async () => {
    const gh = fakeGitHub();
    const f = filer(gh);
    await f.fileIssue(repo, issue);
    const created = gh.calls.filter((c) => c.method === "POST" && c.path.endsWith("/labels"));
    expect(created.map((c) => (c.body as { name: string }).name)).toEqual(["via-beacon"]);
    expect(created[0]?.body).toMatchObject({ color: expect.stringMatching(/^[0-9a-f]{6}$/) as unknown });
    await f.fileIssue(repo, issue);
    expect(gh.calls.filter((c) => c.path.includes("/labels")).length).toBe(3);
  });

  it("treats a label created concurrently as present", async () => {
    const gh = fakeGitHub({
      "POST /repos/rmstdope/retroquest/labels": () => json(422, { errors: [{ code: "already_exists" }] }),
    });
    expect(await filer(gh).fileIssue(repo, issue)).toBe(17);
  });

  it("reuses the installation and its token until shortly before expiry", async () => {
    const gh = fakeGitHub();
    let t = Date.parse("2026-11-22T12:00:00Z");
    const f = filer(gh, () => t);
    await f.fileIssue(repo, issue);
    await f.fileIssue(repo, issue);
    const count = (suffix: string) => gh.calls.filter((c) => c.path.endsWith(suffix)).length;
    expect(count("/installation")).toBe(1);
    expect(count("/access_tokens")).toBe(1);
    t = Date.parse("2026-11-22T12:54:00Z");
    await f.fileIssue(repo, issue);
    expect(count("/access_tokens")).toBe(1);
    t = Date.parse("2026-11-22T12:56:00Z");
    await f.fileIssue(repo, issue);
    expect(count("/access_tokens")).toBe(2);
    expect(count("/installation")).toBe(1);
  });

  it("asks for a token scoped to the one repository", async () => {
    const gh = fakeGitHub();
    await filer(gh).fileIssue(repo, issue);
    const exchange = gh.calls.find((c) => c.path.endsWith("/access_tokens"));
    expect(exchange?.body).toEqual({ repositories: ["retroquest"] });
  });

  it("forgets the installation and token after an auth failure, so a reinstall recovers", async () => {
    let status = 401;
    const gh = fakeGitHub({ "POST /repos/rmstdope/retroquest/issues": () => json(status, { number: 18 }) });
    const f = filer(gh);
    await expect(f.fileIssue(repo, issue)).rejects.toThrow(GitHubError);
    status = 201;
    expect(await f.fileIssue(repo, issue)).toBe(18);
    const count = (suffix: string) => gh.calls.filter((c) => c.path.endsWith(suffix)).length;
    expect(count("/installation")).toBe(2);
    expect(count("/access_tokens")).toBe(2);
  });

  it("forgets the installation after a 404 too, but keeps it after a 403", async () => {
    for (const [status, lookups] of [[404, 2], [403, 1]] as const) {
      let failing = true;
      const gh = fakeGitHub({
        "POST /repos/rmstdope/retroquest/issues": () => (failing ? json(status, {}) : json(201, { number: 1 })),
      });
      const f = filer(gh);
      await expect(f.fileIssue(repo, issue)).rejects.toThrow(GitHubError);
      failing = false;
      await f.fileIssue(repo, issue);
      expect(gh.calls.filter((c) => c.path.endsWith("/installation")).length, String(status)).toBe(lookups);
    }
  });

  it("renews only the token after a 403 that is not a rate limit, so new permissions apply", async () => {
    for (const [headers, tokens] of [
      [{}, 2],
      [{ "x-ratelimit-remaining": "0" }, 1],
      [{ "retry-after": "60" }, 1],
    ] as const) {
      let failing = true;
      const gh = fakeGitHub({
        "POST /repos/rmstdope/retroquest/issues": () =>
          failing ? new Response("{}", { status: 403, headers }) : json(201, { number: 1 }),
      });
      const f = filer(gh);
      await expect(f.fileIssue(repo, issue)).rejects.toThrow(GitHubError);
      failing = false;
      await f.fileIssue(repo, issue);
      const count = (suffix: string) => gh.calls.filter((c) => c.path.endsWith(suffix)).length;
      expect(count("/access_tokens"), JSON.stringify(headers)).toBe(tokens);
      expect(count("/installation"), JSON.stringify(headers)).toBe(1);
    }
  });

  it("applies the same forgetting when reading a label fails", async () => {
    let failing = true;
    const gh = fakeGitHub({
      "GET /repos/rmstdope/retroquest/labels/bug": () => (failing ? json(401, {}) : json(200, {})),
    });
    const f = filer(gh);
    await expect(f.fileIssue(repo, issue)).rejects.toThrow(GitHubError);
    failing = false;
    await f.fileIssue(repo, issue);
    const count = (suffix: string) => gh.calls.filter((c) => c.path.endsWith(suffix)).length;
    expect(count("/installation")).toBe(2);
    expect(count("/access_tokens")).toBe(2);
  });

  it("fails with a GitHubError when a success answer is not JSON", async () => {
    const gh = fakeGitHub({ "POST /repos/rmstdope/retroquest/issues": () => new Response("<html>", { status: 201 }) });
    await expect(filer(gh).fileIssue(repo, issue)).rejects.toThrow(GitHubError);
  });

  it("fails with a GitHubError when a success answer lacks the expected fields", async () => {
    const noNumber = fakeGitHub({ "POST /repos/rmstdope/retroquest/issues": () => json(201, {}) });
    await expect(filer(noNumber).fileIssue(repo, issue)).rejects.toThrow(GitHubError);
    const noToken = fakeGitHub({ "POST /app/installations/42/access_tokens": () => json(201, {}) });
    await expect(filer(noToken).fileIssue(repo, issue)).rejects.toThrow(GitHubError);
  });

  it("fails with a GitHubError when the answer's body stalls past the timeout", async () => {
    const gh = fakeGitHub({
      "POST /repos/rmstdope/retroquest/issues": () =>
        new Response(new ReadableStream({ start() { /* never sends a byte */ } }), { status: 201 }),
    });
    const f = new GitHubAppFiler({ appId: "1", privateKeyPem, fetch: gh.fetch, timeoutMs: 50 });
    await expect(f.fileIssue(repo, issue)).rejects.toThrow(GitHubError);
  });

  it("applies one timeout to the whole report, not to each request", async () => {
    const gh = fakeGitHub();
    const slowEach = async (input: string | URL | Request, init?: RequestInit) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      init?.signal?.throwIfAborted();
      return gh.fetch(input, init);
    };
    const f = new GitHubAppFiler({ appId: "1", privateKeyPem, fetch: slowEach, timeoutMs: 70 });
    await expect(f.fileIssue(repo, issue)).rejects.toThrow(GitHubError);
  });

  it("fails with a GitHubError when the app is not installed on the repository", async () => {
    const gh = fakeGitHub({ "GET /repos/rmstdope/retroquest/installation": () => json(404, {}) });
    await expect(filer(gh).fileIssue(repo, issue)).rejects.toBeInstanceOf(GitHubError);
  });

  it("fails with a GitHubError when GitHub refuses the issue", async () => {
    const gh = fakeGitHub({ "POST /repos/rmstdope/retroquest/issues": () => json(503, {}) });
    await expect(filer(gh).fileIssue(repo, issue)).rejects.toThrow(GitHubError);
  });

  it("fails with a GitHubError when the network fails", async () => {
    const gh = fakeGitHub({
      "POST /repos/rmstdope/retroquest/issues": () => {
        throw new TypeError("fetch failed");
      },
    });
    await expect(filer(gh).fileIssue(repo, issue)).rejects.toThrow(GitHubError);
  });

  it("gives up on a request that takes longer than the timeout", async () => {
    const slow = (_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "TimeoutError"));
        });
      });
    const f = new GitHubAppFiler({ appId: "1", privateKeyPem, fetch: slow, timeoutMs: 20 });
    await expect(f.fileIssue(repo, issue)).rejects.toThrow(GitHubError);
  });
});

describe("GitHubAppFiler.isInstalled", () => {
  it("is true when the app is installed on the repository", async () => {
    expect(await filer(fakeGitHub()).isInstalled(repo)).toBe(true);
  });

  it("is false when it is not", async () => {
    const gh = fakeGitHub({ "GET /repos/rmstdope/retroquest/installation": () => json(404, {}) });
    expect(await filer(gh).isInstalled(repo)).toBe(false);
  });
});
