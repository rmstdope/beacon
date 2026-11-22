import { execFileSync } from "node:child_process";
import { lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Invisible or direction-changing characters in source hide what code does ("Trojan Source").
 * NUL counts too: tools treat a file containing one as binary and stop looking at it.
 */
// eslint-disable-next-line no-control-regex -- NUL is matched on purpose: see above.
const INVISIBLE = /[\p{Cf}\u00A0\u0000]/u;
// eslint-disable-next-line no-control-regex -- the same set, every occurrence, for the report.
const INVISIBLE_ALL = /[\p{Cf}\u00A0\u0000]/gu;

/** Binary formats are skipped by extension, never by content, so a NUL cannot exempt a source file. */
const BINARY = /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf|pdf)$/i;

/** U+202E RIGHT-TO-LEFT OVERRIDE, built from its code point so no tool can write it literally here. */
const RLO = String.fromCodePoint(0x202e);

/** A path as the report prints it: each invisible character written as `\u{XXXX}`, never literally. */
function visible(path: string): string {
  return path.replace(
    INVISIBLE_ALL,
    (char) => `\\u{${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}}`,
  );
}

function git(cwd: string, args: string[], input?: string): Buffer {
  return execFileSync("git", args, { cwd, ...(input === undefined ? {} : { input }) });
}

/**
 * Every tracked path in the repository at `cwd` whose working-tree content holds an invisible
 * character, one line per finding: `<path> (<where>)`.
 */
function findInvisible(cwd: string): string[] {
  // Tracked files only: exactly what is committed and what CI sees. Stray local files (Finder's
  // .DS_Store, pack tarballs, symlinks) are not code and must not fail the suite. Run it after
  // `git add` to check a new file before committing.
  const paths = git(cwd, ["ls-files", "-z"])
    .toString("utf8")
    .split("\0")
    .filter((path) => path !== "");
  const offenders: string[] = [];
  for (const path of paths) {
    // A name is text whatever the file holds, so binary files are not exempt from this check.
    if (INVISIBLE.test(path)) offenders.push(`${visible(path)} (name)`);
    if (BINARY.test(path)) continue;
    let content: Buffer;
    try {
      // Symlinks and submodules (git lists a submodule as one path) are not file contents here:
      // a link's target is scanned at its own path, a submodule by its own repository.
      if (!lstatSync(join(cwd, path)).isFile()) continue;
      content = readFileSync(join(cwd, path));
    } catch (error) {
      // A tracked file deleted in the working tree has nothing to scan; anything else is a failure.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (INVISIBLE.test(content.toString("utf8"))) offenders.push(`${visible(path)} (working tree)`);
  }
  for (const path of stagedOffenders(cwd)) offenders.push(`${visible(path)} (staged)`);
  return offenders;
}

/**
 * Tracked paths whose staged content (what the next commit holds) has an invisible character,
 * even when the working tree has since been fixed and not re-staged. All blobs are read by one
 * `git cat-file --batch`, never one process per file.
 */
function stagedOffenders(cwd: string): string[] {
  // `<mode> <oid> <stage>\t<path>`; a conflicted path lists one entry per stage, each scanned.
  const entries = git(cwd, ["ls-files", "--stage", "-z"])
    .toString("utf8")
    .split("\0")
    .filter((entry) => entry !== "")
    .map((entry) => {
      const tab = entry.indexOf("\t");
      const [mode = "", oid = ""] = entry.slice(0, tab).split(" ");
      return { mode, oid, path: entry.slice(tab + 1) };
    })
    // Regular files only: a symlink's blob is its target path, a submodule's entry is a commit.
    .filter(({ mode, path }) => (mode === "100644" || mode === "100755") && !BINARY.test(path));
  if (entries.length === 0) return [];

  const out = git(cwd, ["cat-file", "--batch"], entries.map(({ oid }) => `${oid}\n`).join(""));
  const offenders: string[] = [];
  let at = 0;
  for (const { path } of entries) {
    // Each answer is `<oid> blob <size>\n<content>\n`; anything else means the index is unreadable.
    const eol = out.indexOf(0x0a, at);
    const header = out.subarray(at, eol).toString("utf8").split(" ");
    if (header[1] !== "blob" || header[2] === undefined) {
      throw new Error(`git cat-file could not read the staged blob of ${visible(path)}`);
    }
    const size = Number(header[2]);
    const content = out.subarray(eol + 1, eol + 1 + size);
    at = eol + 1 + size + 1;
    if (INVISIBLE.test(content.toString("utf8"))) offenders.push(path);
  }
  return offenders;
}

describe("findInvisible", () => {
  let repo = "";
  afterEach(() => {
    if (repo !== "") rmSync(repo, { recursive: true, force: true });
    repo = "";
  });

  /** A throwaway repository holding `files`, all staged; nothing is committed, so no identity is needed. */
  function stagedRepo(files: Record<string, string>): string {
    repo = mkdtempSync(join(tmpdir(), "beacon-hygiene-"));
    git(repo, ["init", "--quiet"]);
    for (const [name, content] of Object.entries(files)) writeFileSync(join(repo, name), content);
    git(repo, ["add", "--all"]);
    return repo;
  }

  it("reports a tracked file whose name contains U+202E", () => {
    const dir = stagedRepo({ [`a${RLO}b.txt`]: "clean\n" });
    expect(findInvisible(dir)).toEqual(["a\\u{202E}b.txt (name)"]);
  });

  it("reports staged content that the working tree has since fixed", () => {
    const dir = stagedRepo({ "bad.ts": `const a = 1;${RLO}\n` });
    writeFileSync(join(dir, "bad.ts"), "const a = 1;\n");
    expect(findInvisible(dir)).toEqual(["bad.ts (staged)"]);
  });

  it("reports nothing for a clean repository, and finds a bad blob after clean ones", () => {
    const dir = stagedRepo({ "a.ts": "one\ntwo\n\n", "b.ts": "", "c.md": "three\n" });
    symlinkSync("a.ts", join(dir, "link.ts"));
    git(dir, ["add", "link.ts"]);
    expect(findInvisible(dir)).toEqual([]);

    // The last blob in the batch is the bad one, so a framing error would misread or miss it.
    writeFileSync(join(dir, "z.ts"), `${RLO}\n`);
    git(dir, ["add", "z.ts"]);
    expect(findInvisible(dir)).toEqual(["z.ts (working tree)", "z.ts (staged)"]);
  });
});

describe("tracked files", () => {
  it("contain no literal invisible or bidirectional characters; write them as \\u escapes", () => {
    expect(findInvisible(process.cwd())).toEqual([]);
  });
});
