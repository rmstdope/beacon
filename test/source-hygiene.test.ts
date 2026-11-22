import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Invisible or direction-changing characters in source hide what code does ("Trojan Source"). */
const INVISIBLE = /[\p{Cf}\u00A0]/u;

/** Text files only: git treats a file with a NUL byte as binary, and so does this check. */
function isBinary(content: Buffer): boolean {
  return content.includes(0);
}

describe("repository files", () => {
  it("contain no literal invisible or bidirectional characters; write them as \\u escapes", () => {
    const paths = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      encoding: "utf8",
    })
      .split("\0")
      .filter((path) => path !== "");
    const offenders = paths.filter((path) => {
      let content: Buffer;
      try {
        content = readFileSync(path);
      } catch (error) {
        // A tracked file deleted in the working tree has nothing to scan; anything else is a failure.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
      return !isBinary(content) && INVISIBLE.test(content.toString("utf8"));
    });
    expect(offenders).toEqual([]);
  });
});
