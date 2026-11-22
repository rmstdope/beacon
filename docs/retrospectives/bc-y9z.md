# bc-y9z — retrospective

- **Implementer:** Cyclops
- **Date:** 2026-11-22
- **PR:** #3

## Editing tools wrote `\u` escapes in TypeScript as literal invisible characters

**What happened.** Three times in this run, the Write and Edit tools turned a TypeScript `\u` escape
into the literal character. Writing `/[\p{Cf} \u0000]/u` produced a literal NBSP in both regex
lines. A string `"a‮b.txt"` produced a literal U+202E, and so did a later edit. The hygiene
test caught each one: `test/source-hygiene.test.ts (working tree)`. One check missed a case:
`LC_ALL=C grep -c -P '[\x80-\xff]'` reported 0 while the U+202E bytes were present. The check
that worked was `LC_ALL=C tr -d '\11\12\40-\176' < file | wc -c`.
**Why.** Not established. The tools appear to decode `\uXXXX` in the content they are given before
writing it.
**Cost.** About ten minutes. There were three perl byte-replacement passes, and one false "clean"
reading from grep.
**Prevent by.** CLAUDE.md, *Development practices*, "Source files are plain text you can see": in
test code, build an invisible character from its code point (`String.fromCodePoint(0x202e)`),
which has no escape a tool can decode. After any tool write, check the file with the `tr`
byte-count command rather than `grep -P`.
**Seen before.** None in `docs/retrospectives/`. CLAUDE.md already notes "Tools have written them
literally here before."

## `build-workload --classify` refuses to classify any change

**What happened.** `git diff --name-only -z origin/main...HEAD | xargs -0
.cerebro/cerebro/scripts/build-workload --classify` printed `build-workload: no rust_paths in
.cerebro/project.conf - cannot classify safely.` and gave no classification.
**Why.** `.cerebro/project.conf` declares no `rust_paths`. Beacon has no Rust, so nothing ever
prompted declaring an empty one.
**Cost.** A minute. The plan's `non-rust` workload was taken as stated.
**Prevent by.** Declare the absence of Rust in `.cerebro/project.conf`, in whatever form
`build-workload` accepts as "no Rust paths", so `produce-bead`'s *Building* classification step
gives an answer.
**Seen before.** None found.
