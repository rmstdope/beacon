# bc-7ek — retrospective

- **Implementer:** Cyclops
- **Date:** 2026-11-22
- **PR:** #4

## Browsers never saw Retry-After, and in-process tests could not show it

**What happened.** The new browser client reads `Retry-After` from a 429. The review found that
Beacon had never sent `Access-Control-Expose-Headers`, so on a cross-origin response a browser hides
`Retry-After` from the frontend. This was true since the first release, for direct callers too. The
server tests and the client tests were all green, because `app.request` and an injected `fetch` apply
no CORS. The client's integration test also used a 60 s window, the same value as the client's
fallback, so it passed whether the header was read or not.
**Why.** The in-process harness models the HTTP exchange but not the browser between the frontend
and Beacon. Response headers outside the CORS safelist exist in tests and are hidden in production.
**Cost.** One review round and a fix commit. Without the review, every frontend would have retried
after 60 s against 600 s and 3600 s windows.
**Prevent by.** `docs/design.md`, *Testing*, *HTTP behaviour*: every response header a frontend is
meant to read has a server test asserting it is listed in `Access-Control-Expose-Headers`, as
`test/server.test.ts` now does for `Retry-After`. In a test that proves a value was read, choose a
value that differs from every default.
**Seen before.** None found.
