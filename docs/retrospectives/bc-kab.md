# bc-kab — retrospective

- **Implementer:** Cyclops
- **Date:** 2026-11-22
- **PR:** #6

## A regex check crashed with a stack overflow on a large screenshot

**What happened.** The base64 check `/^(?:[A-Za-z0-9+/]{4})*(?:...)?$/` passed every test, which
used inputs up to 2 MiB plus one byte. The cold review ran it on a single 4.6M-character string and
got `RangeError: Maximum call stack size exceeded`. The check runs before the size check, so the
crash escaped as `500 internal` where the agreed answer was `413 too_large`. The cut-off is about
4.47M characters, well inside the new 9 MB body limit.

**Why.** Observed, not explained: the grouped pattern overflows V8's regex stack once the input
passes about 4.47M characters, and the flat class `[A-Za-z0-9+/]*` does not at 9M. The mechanism
inside the engine was not established.

**Cost.** One review round: a fix commit, a new test, and a focused re-review.

**Prevent by.** Test every check on untrusted input at the largest size the request limit lets
through, not only at its own boundary. Here that means `test/report.test.ts` checking a screenshot
at 9 MB, not just at 2 MiB + 1. When a regex will see multi-megabyte input, use no quantified
groups: a flat character class, with any structure (such as a length modulo) checked separately.

**Seen before.** none found

## Raising the body limit broke the assumption that rate limits bound a flood, and the first fix opened a slow-sender hole

**What happened.** The body limit went from 16 KB to 9 MB. The rate limits need the client ID, and
the client ID is inside the body, so they are checked only after the body is read and parsed. A
refused 9 MB request had therefore already cost about 40 MB. About eight concurrent requests could
OOM the container, and the cold review flagged it. The fix capped large bodies in flight at three.
The follow-up review then found that a slot was held while the body arrived, with only Node's
300 s timeout as a limit, so three one-byte-a-minute uploads blocked every screenshot report. The
final design adds one slot per address and a 60 s deadline for the body once a slot is granted
(`408 request_timeout`).

**Why.** The plan measured memory for honest concurrency only. It did not ask which limits run
before the body is read, once the body is 576 times larger. The first fix then bounded memory
without asking how long a slot could be held.

**Cost.** Three extra review rounds, four fix commits, a new status outside the agreed refusal
table, and real-socket experiments to confirm the behaviour.

**Prevent by.** When a bead raises a request-size limit, its plan's *Known traps* or *Validation*
should answer three questions: which checks run before the body is read; what N concurrent
maximum-size requests from different addresses cost; and, for any capacity cap, how long one
sender can hold a unit of it. The third question is also worth adding to `produce-bead`'s
description of *Validation* for any change that adds a shared limit.

**Seen before.** none found
