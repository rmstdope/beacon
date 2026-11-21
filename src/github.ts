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

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

/**
 * Files issues as a GitHub App, through the REST API.
 *
 * Authentication follows GitHub's App flow: a JWT signed with the App's private key finds the
 * installation for a repository, and is exchanged for an installation token. Installation IDs,
 * tokens and the labels known to exist are kept in memory only.
 */
export class GitHubAppFiler implements IssueFiler {
  readonly #appId: string;
  readonly #privateKeyPem: string;
  readonly #fetch: Fetch;
  readonly #now: () => number;
  readonly #timeoutMs: number;
  readonly #installations = new Map<string, number>();
  readonly #tokens = new Map<number, { token: string; expiresAt: number }>();
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
    this.#timeoutMs = options.timeoutMs ?? 10_000;
  }

  async fileIssue(repo: RepoRef, issue: Issue): Promise<number> {
    const token = await this.#installationToken(repo);
    for (const label of issue.labels) await this.#ensureLabel(repo, label, token);
    const res = await this.#request("POST", `/repos/${repo.owner}/${repo.name}/issues`, `token ${token}`, issue);
    if (res.status !== 201) throw new GitHubError(`creating the issue answered ${String(res.status)}`, res.status);
    const { number } = (await res.json()) as { number: number };
    return number;
  }

  async isInstalled(repo: RepoRef): Promise<boolean> {
    try {
      await this.#installationId(repo);
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

  async #installationId(repo: RepoRef): Promise<number> {
    const key = `${repo.owner}/${repo.name}`;
    const cached = this.#installations.get(key);
    if (cached !== undefined) return cached;
    const res = await this.#request("GET", `/repos/${key}/installation`, `Bearer ${this.#jwt()}`);
    if (res.status !== 200) {
      throw new GitHubError(`finding the installation for ${key} answered ${String(res.status)}`, res.status);
    }
    const { id } = (await res.json()) as { id: number };
    this.#installations.set(key, id);
    return id;
  }

  async #installationToken(repo: RepoRef): Promise<string> {
    const id = await this.#installationId(repo);
    const cached = this.#tokens.get(id);
    if (cached && cached.expiresAt - this.#now() > TOKEN_RENEW_MS) return cached.token;
    const res = await this.#request("POST", `/app/installations/${String(id)}/access_tokens`, `Bearer ${this.#jwt()}`);
    if (res.status !== 201) {
      throw new GitHubError(`creating an installation token answered ${String(res.status)}`, res.status);
    }
    const { token, expires_at } = (await res.json()) as { token: string; expires_at: string };
    this.#tokens.set(id, { token, expiresAt: Date.parse(expires_at) });
    return token;
  }

  async #ensureLabel(repo: RepoRef, label: string, token: string): Promise<void> {
    const key = `${repo.owner}/${repo.name}#${label}`;
    if (this.#knownLabels.has(key)) return;
    const path = `/repos/${repo.owner}/${repo.name}/labels`;
    const found = await this.#request("GET", `${path}/${encodeURIComponent(label)}`, `token ${token}`);
    if (found.status === 404) {
      const style = LABEL_STYLE[label] ?? { color: "ededed", description: "" };
      const created = await this.#request("POST", path, `token ${token}`, { name: label, ...style });
      // 422 means it already exists: another request created it first.
      if (created.status !== 201 && created.status !== 422) {
        throw new GitHubError(`creating label ${label} answered ${String(created.status)}`, created.status);
      }
    } else if (found.status !== 200) {
      throw new GitHubError(`reading label ${label} answered ${String(found.status)}`, found.status);
    }
    this.#knownLabels.add(key);
  }

  async #request(method: string, path: string, authorization: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      authorization,
      "user-agent": "beacon",
      "x-github-api-version": "2022-11-28",
    };
    const init: RequestInit = { method, headers, signal: AbortSignal.timeout(this.#timeoutMs) };
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
