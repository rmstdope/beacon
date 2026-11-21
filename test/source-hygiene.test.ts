import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Invisible or direction-changing characters in source hide what code does ("Trojan Source"). */
const INVISIBLE = /[\p{Cf}\u00A0]/u;

describe("tracked files", () => {
  it("contain no literal invisible or bidirectional characters; write them as \\u escapes", () => {
    const tracked = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
      encoding: "utf8",
    })
      .split("\n")
      .filter((path) => path !== "" && !path.startsWith("docs/") && path !== "pnpm-lock.yaml");
    const offenders = tracked.filter((path) => {
      try {
        return INVISIBLE.test(readFileSync(path, "utf8"));
      } catch {
        return false; // deleted in the working tree
      }
    });
    expect(offenders).toEqual([]);
  });
});
