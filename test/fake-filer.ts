import type { RepoRef } from "../src/config.js";
import type { IssueBuilder, IssueFiler, StoredFile } from "../src/github.js";
import type { Issue } from "../src/issue.js";

/** Records what would be filed. Stored files get addresses under `https://github.com/stored/`. */
export class FakeFiler implements IssueFiler {
  filed: { repo: RepoRef; issue: Issue; files: readonly StoredFile[] }[] = [];
  calls = 0;
  inFlight = 0;
  maxInFlight = 0;
  failWith: Error | undefined;
  /** While set, every call waits for it before filing. */
  hold: Promise<void> | undefined;
  async fileIssue(repo: RepoRef, build: Issue | IssueBuilder, files: readonly StoredFile[] = []): Promise<number> {
    this.calls++;
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      await this.hold;
    } finally {
      this.inFlight--;
    }
    if (this.failWith) throw this.failWith;
    const urls = files.map((file) => `https://github.com/stored/${file.path}`);
    const issue = typeof build === "function" ? build(urls) : build;
    this.filed.push({ repo, issue, files });
    return 100 + this.filed.length;
  }
  isInstalled(): Promise<boolean> {
    return Promise.resolve(true);
  }
}
