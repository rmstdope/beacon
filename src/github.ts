import { createSign } from "node:crypto";
import type { RepoRef } from "./config.js";
import type { Issue } from "./issue.js";

/** Files issues in a repository. The seam the HTTP layer depends on. */
export interface IssueFiler {
  /** Files the issue and returns its number. Throws a GitHubError on any GitHub failure. */
  fileIssue(repo: RepoRef, issue: Issue): Promise<number>;
  /** Whether the App is installed on the repository. */
  isInstalled(repo: RepoRef): Promise<boolean>;
}

export class GitHubError extends Error {
  override name = "GitHubError";
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const API = "https://api.github.com";

const LABEL_STYLE: Record<string, { color: string; description: string }> = {
  bug: { color: "d73a4a", description: "Something isn't working" },
  enhancement: { color: "a2eeef", description: "Improvement to an existing feature" },
  "feature-request": { color: "0e8a16", description: "A new feature" },
  "via-beacon": { color: "5319e7", description: "Filed by Beacon for an anonymous user; untrusted text" },
};

/** Installation tokens live an hour; renew this long before they expire. */
const TOKEN_RENEW_MS = 5 * 60_000;

/**
 * Statuses after which cached installation IDs and tokens may be stale (uninstalled, revoked).
 * Not 403: GitHub also answers 403 for rate limits, and re-authenticating then only adds calls.
 */
const AUTH_FAILURES = new Set([401, 404]);

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

function repoKey(repo: RepoRef): string {
  return `${repo.owner}/${repo.name}`;
}

/** Releases a response body we do not read, so its connection is freed now rather than at GC. */
async function discard(res: Response): Promise<void> {
  await res.body?.cancel().catch(() => undefined);
}

/**
 * Files issues as a GitHub App, through the REST API.
 *
 * Authentication follows GitHub's App flow: a JWT signed with the App's private key finds the
 * installation for a repository, and is exchanged for an installation token scoped to that one
 * repository. Installation IDs, tokens and the labels known to exist are kept in memory only.
 * Every call to GitHub made for one report shares a single timeout.
 */
export class GitHubAppFiler implements IssueFiler {
  readonly #appId: string;
  readonly #privateKeyPem: string;
  readonly #fetch: Fetch;
  readonly #now: () => number;
  readonly #timeoutMs: number;
  readonly #installations = new Map<string, number>();
  readonly #tokens = new Map<string, { token: string; expiresAt: number }>();
  readonly #knownLabels = new Set<string>();

  constructor(options: {
    appId: string;
    privateKeyPem: string;
    fetch?: Fetch;
    now?: () => number;
    timeoutMs?: number;
  }) {
    this.#appId = options.appId;
    this.#privateKeyPem = options.privateKeyPem;
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? Date.now;
    // Docker kills a container 10 s after SIGTERM; a report must finish well inside that.
    this.#timeoutMs = options.timeoutMs ?? 8_000;
  }

  async fileIssue(repo: RepoRef, issue: Issue): Promise<number> {
    const signal = AbortSignal.timeout(this.#timeoutMs);
    const token = await this.#installationToken(repo, signal);
    for (const label of issue.labels) await this.#ensureLabel(repo, label, token, signal);
    const res = await this.#request("POST", `/repos/${repoKey(repo)}/issues`, `token ${token}`, signal, issue);
    await this.#expect(res, 201, "creating the issue", repo);
    const body = await this.#json(res, signal);
    if (!Number.isInteger(body.number)) throw new GitHubError("creating the issue answered without a number");
    return body.number as number;
  }

  async isInstalled(repo: RepoRef): Promise<boolean> {
    try {
      await this.#installationId(repo, AbortSignal.timeout(this.#timeoutMs));
      return true;
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404) return false;
      throw error;
    }
  }

  #jwt(): string {
    const now = Math.floor(this.#now() / 1000);
    const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    // iat is backdated a minute against clock drift; GitHub accepts at most ten minutes of life.
    const payload = base64url(JSON.stringify({ iss: this.#appId, iat: now - 60, exp: now + 540 }));
    const signature = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(this.#privateKeyPem);
    return `${header}.${payload}.${base64url(signature)}`;
  }

  async #installationId(repo: RepoRef, signal: AbortSignal): Promise<number> {
    const key = repoKey(repo);
    const cached = this.#installations.get(key);
    if (cached !== undefined) return cached;
    const res = await this.#request("GET", `/repos/${key}/installation`, `Bearer ${this.#jwt()}`, signal);
    await this.#expect(res, 200, `finding the installation for ${key}`);
    const body = await this.#json(res, signal);
    if (!Number.isInteger(body.id)) throw new GitHubError(`finding the installation for ${key} answered without an id`);
    this.#installations.set(key, body.id as number);
    return body.id as number;
  }

  async #installationToken(repo: RepoRef, signal: AbortSignal): Promise<string> {
    const key = repoKey(repo);
    const cached = this.#tokens.get(key);
    if (cached && cached.expiresAt - this.#now() > TOKEN_RENEW_MS) return cached.token;
    const id = await this.#installationId(repo, signal);
    const res = await this.#request(
      "POST",
      `/app/installations/${String(id)}/access_tokens`,
      `Bearer ${this.#jwt()}`,
      signal,
      { repositories: [repo.name] },
    );
    await this.#expect(res, 201, "creating an installation token", repo);
    const body = await this.#json(res, signal);
    const expiresAt = typeof body.expires_at === "string" ? Date.parse(body.expires_at) : NaN;
    if (typeof body.token !== "string" || Number.isNaN(expiresAt)) {
      throw new GitHubError("creating an installation token answered without a token");
    }
    this.#tokens.set(key, { token: body.token, expiresAt });
    return body.token;
  }

  async #ensureLabel(repo: RepoRef, label: string, token: string, signal: AbortSignal): Promise<void> {
    const key = `${repoKey(repo)}#${label}`;
    if (this.#knownLabels.has(key)) return;
    const path = `/repos/${repoKey(repo)}/labels`;
    const found = await this.#request("GET", `${path}/${encodeURIComponent(label)}`, `token ${token}`, signal);
    await discard(found);
    if (found.status === 404) {
      const style = LABEL_STYLE[label] ?? { color: "ededed", description: "" };
      const created = await this.#request("POST", path, `token ${token}`, signal, { name: label, ...style });
      // 422 means it already exists: another request created it first.
      if (created.status !== 422) await this.#expect(created, 201, `creating label ${label}`, repo);
      await discard(created);
    } else if (found.status !== 200) {
      this.#forget(repo, found.status);
      throw new GitHubError(`reading label ${label} answered ${String(found.status)}`, found.status);
    }
    this.#knownLabels.add(key);
  }

  /** Throws a GitHubError unless `res` has the expected status, forgetting stale credentials. */
  async #expect(res: Response, status: number, what: string, repo?: RepoRef): Promise<void> {
    if (res.status === status) return;
    await discard(res);
    if (repo) this.#forget(repo, res.status);
    throw new GitHubError(`${what} answered ${String(res.status)}`, res.status);
  }

  #forget(repo: RepoRef, status: number): void {
    if (!AUTH_FAILURES.has(status)) return;
    this.#installations.delete(repoKey(repo));
    this.#tokens.delete(repoKey(repo));
  }

  /** Reads a JSON object, bounded by the report's timeout even if the body stalls. */
  async #json(res: Response, signal: AbortSignal): Promise<Record<string, unknown>> {
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => {
        reject(new GitHubError("reading GitHub's answer timed out"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      if (signal.aborted) throw new GitHubError("reading GitHub's answer timed out");
      const value: unknown = await Promise.race([res.json(), aborted]);
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new GitHubError("GitHub answered something other than a JSON object");
      }
      return value as Record<string, unknown>;
    } catch (error) {
      await discard(res);
      if (error instanceof GitHubError) throw error;
      throw new GitHubError(`reading GitHub's answer failed: ${error instanceof Error ? error.name : "unknown"}`);
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
  }

  async #request(
    method: string,
    path: string,
    authorization: string,
    signal: AbortSignal,
    body?: unknown,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      authorization,
      "user-agent": "beacon",
      "x-github-api-version": "2022-11-28",
    };
    const init: RequestInit = { method, headers, signal };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    try {
      return await this.#fetch(`${API}${path}`, init);
    } catch (error) {
      const reason = error instanceof Error ? error.name : "unknown error";
      throw new GitHubError(`${method} ${path} failed: ${reason}`);
    }
  }
}
