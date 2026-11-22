# Beacon

Beacon relays bug reports, enhancement suggestions and feature requests from the browser frontends of
rmstdope apps to GitHub issues in each app's repository. It stores nothing. It runs at
`https://beacon.rmstdope.eu`.

The design, the HTTP API and the reasoning behind both are in [docs/design.md](docs/design.md).

## Sending a report from a frontend

Copy [src/client.ts](src/client.ts) into the frontend, for example as `beacon-client.ts` (it has no
imports or dependencies), then:

```ts
import { createBeacon } from "./beacon-client";

const beacon = createBeacon({ clientId: "retroquest", appVersion: "1.4.2" });
const result = await beacon.report({
  type: "bug",                       // "bug" | "enhancement" | "feature"
  title: "Score resets when the window is resized",
  description: "Steps: start a level, resize the window, the score shows 0.",
});
if (result.ok) showThanks(result.reference);                 // "Thanks! Reference #123"
else if (result.error.code === "rate_limited") retryIn(result.error.retryAfterSeconds);
else if (result.error.code === "invalid_report") highlight(result.error.field);
```

The client fills in the page (without its query or fragment) and the user agent. Every outcome is a
result, never an exception; the error codes are in [Browser client](docs/design.md#browser-client).
To call the HTTP API directly instead, see [HTTP API](docs/design.md#http-api).

The page's origin must be one of the client's configured origins.

## Adding a client

1. Install the `rmstdope-beacon` GitHub App on the app's repository (GitHub → Settings →
   Applications → rmstdope-beacon → Configure).
2. Add the client to `BEACON_CLIENTS` in `/srv/rmstdope/secrets/beacon/web.env` on the VPS:
   `"<client-id>": {"repo": "rmstdope/<repo>", "origins": ["https://<app>.rmstdope.eu"]}`.
3. Restart Beacon. Its start-up log warns about any configured repository the App is not installed on.

## Development

Requires Node 24 and pnpm.

```sh
pnpm install
pnpm test            # Vitest
pnpm run typecheck
pnpm run lint
pnpm run build       # compiles to dist/
```

To run it locally, set `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY_BASE64` and `BEACON_CLIENTS` (see
[Configuration](docs/design.md#configuration)), then `pnpm run build && pnpm start`.

## Deployment

CI builds the image, smoke-tests it and, on `main`, publishes it to `ghcr.io/rmstdope/beacon` with a
`deployment-manifest` artifact. rmstdope-infra deploys it as a `fullstack` app from the bundle in
[deploy/](deploy/). See [Deployment](docs/design.md#deployment) for the first release.
