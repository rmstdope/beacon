import type { RepoRef } from "../src/config.js";
import type { IssueBuilder, IssueFiler, ScreenshotFile } from "../src/github.js";
import type { Issue } from "../src/issue.js";

/** Records what would be filed. Stored screenshots get addresses under `https://github.com/stored/`. */
export class FakeFiler implements IssueFiler {
  filed: { repo: RepoRef; issue: Issue; screenshots: readonly ScreenshotFile[] }[] = [];
  calls = 0;
  failWith: Error | undefined;
  fileIssue(repo: RepoRef, build: Issue | IssueBuilder, screenshots: readonly ScreenshotFile[] = []): Promise<number> {
    this.calls++;
    if (this.failWith) return Promise.reject(this.failWith);
    const urls = screenshots.map((file) => `https://github.com/stored/${file.path}?raw=true`);
    const issue = typeof build === "function" ? build(urls) : build;
    this.filed.push({ repo, issue, screenshots });
    return Promise.resolve(100 + this.filed.length);
  }
  isInstalled(): Promise<boolean> {
    return Promise.resolve(true);
  }
}
