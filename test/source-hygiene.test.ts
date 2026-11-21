import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** Invisible or direction-changing characters in source hide what code does ("Trojan Source"). */
const INVISIBLE = /[\p{Cf}\u00A0]/u;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

describe("source files", () => {
  it("contain no literal invisible or bidirectional characters; write them as \\u escapes", () => {
    const offenders = ["src", "test"]
      .flatMap(files)
      .filter((path) => path.endsWith(".ts"))
      .filter((path) => INVISIBLE.test(readFileSync(path, "utf8")));
    expect(offenders).toEqual([]);
  });
});
