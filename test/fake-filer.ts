import type { RepoRef } from "../src/config.js";
import type { IssueBuilder, IssueFiler, ScreenshotFile } from "../src/github.js";
import type { Issue } from "../src/issue.js";

/** Records what would be filed. Stored screenshots get addresses under `https://github.com/stored/`. */
export class FakeFiler implements IssueFiler {
  filed: { repo: RepoRef; issue: Issue; screenshots: readonly ScreenshotFile[] }[] = [];
  calls = 0;
  inFlight = 0;
  maxInFlight = 0;
  failWith: Error | undefined;
  /** While set, every call waits for it before filing. */
  hold: Promise<void> | undefined;
  async fileIssue(repo: RepoRef, build: Issue | IssueBuilder, screenshots: readonly ScreenshotFile[] = []): Promise<number> {
    this.calls++;
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      await this.hold;
    } finally {
      this.inFlight--;
    }
    if (this.failWith) throw this.failWith;
    const urls = screenshots.map((file) => `https://github.com/stored/${file.path}?raw=true`);
    const issue = typeof build === "function" ? build(urls) : build;
    this.filed.push({ repo, issue, screenshots });
    return 100 + this.filed.length;
  }
  isInstalled(): Promise<boolean> {
    return Promise.resolve(true);
  }
}
