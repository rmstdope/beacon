# bc-y9z — retrospective

- **Implementer:** Cyclops
- **Date:** 2026-11-22
- **PR:** #3

## Editing tools wrote `\u` escapes as literal invisible characters

**What happened.** Four times in this run, a tool turned a `\u` escape into the literal character.
Writing `/[\p{Cf}\u00A0\u0000]/u` with the Write tool produced a literal NBSP in both regex
lines. A string `"a\u202Eb.txt"` produced a literal U+202E, and so did a later Edit. Each time,
the hygiene test caught it as `test/source-hygiene.test.ts (working tree)`. The fourth time was
this retrospective, written through a bash heredoc: its quoted escapes came out literal, and the
hygiene test passed anyway, because an untracked file is not in `git ls-files` and is not scanned.
`LC_ALL=C grep -c -P '[\x80-\xff]'` also reported 0 while U+202E bytes were present.
**Why.** Not established. The tool layer appears to decode `\uXXXX` in the text it is given
before the file is written, whichever tool writes it.
**Cost.** About fifteen minutes: four perl byte-replacement passes, one false "clean" reading from
grep, and one docs commit pushed with literal characters in it and fixed by the next.
**Prevent by.** CLAUDE.md, *Development practices*, "Source files are plain text you can see":
in test code, build an invisible character from its code point (`String.fromCodePoint(0x202e)`),
which has no escape a tool can decode. In prose, write the backslash as a placeholder and
substitute the byte afterwards (`perl -pi -e 's/BSL/\x5c/g'`). After any tool write, stage the
file (`git add -N <file>` is enough) and run `pnpm exec vitest run test/source-hygiene.test.ts`.
A non-ASCII byte count such as `tr -d '\11\12\40-\176' | wc -c` also counts visible
characters like an em dash, so it can only rule a file clean, never convict it.
**Seen before.** None found.

## `build-workload --classify` refuses to classify any change

**What happened.** `git diff --name-only -z origin/main...HEAD | xargs -0
.cerebro/cerebro/scripts/build-workload --classify` printed `build-workload: no rust_paths in
.cerebro/project.conf - cannot classify safely.` and gave no classification.
**Why.** `.cerebro/project.conf` leaves `rust_paths` commented out. Beacon has no Rust, and
`build-workload` cannot be told so: it exits on an empty value, and `project-conf` strips
everything from `#` on, so neither an empty declaration nor a commented one reads as "no Rust".
**Cost.** A minute. The plan's `non-rust` workload was taken as stated.
**Prevent by.** In cerebro, `scripts/build-workload`: classify a project with no `Cargo.toml` as
`non-rust`, or accept an explicit `rust_paths none`. The only consumer-side workaround is a regex
that never matches, such as `rust_paths ^$`, which hides the intent and is not recommended.
**Seen before.** None found.
