import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Invisible or direction-changing characters in source hide what code does ("Trojan Source").
 * NUL counts too: tools treat a file containing one as binary and stop looking at it.
 */
// eslint-disable-next-line no-control-regex -- NUL is matched on purpose: see above.
const INVISIBLE = /[\p{Cf}\u00A0\u0000]/u;

/** Binary formats are skipped by extension, never by content, so a NUL cannot exempt a source file. */
const BINARY = /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf|pdf)$/i;

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
      return !BINARY.test(path) && INVISIBLE.test(content.toString("utf8"));
    });
    expect(offenders).toEqual([]);
  });
});
