# syntax=docker/dockerfile:1

# Base images are pinned by digest; bump the tag and digest together.
FROM node:24-trixie-slim@sha256:af02d57b57719b9657a45199a79264a9437940cd55b3c7b3fc99615654f124a0 AS base
WORKDIR /app
RUN npm install --global --no-fund --no-audit pnpm@11.24.0
COPY package.json pnpm-lock.yaml ./

FROM base AS deps
RUN pnpm install --frozen-lockfile --prod

FROM base AS build
ARG REVISION
RUN test -n "$REVISION" || { echo "build with --build-arg REVISION=<full commit SHA>" >&2; exit 1; }
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm run build && printf '{"revision":"%s"}\n' "$REVISION" > release.json

FROM gcr.io/distroless/nodejs24-debian13@sha256:24bc0fe0225c7518f202a822587dad74fe143b96326b81fe5cc08c1df8bed03e
ARG REVISION
LABEL org.opencontainers.image.revision=$REVISION \
      org.opencontainers.image.source=https://github.com/rmstdope/beacon
ENV NODE_ENV=production
WORKDIR /app
COPY package.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/release.json ./release.json
USER 10001:10001
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --retries=6 --start-period=5s \
  CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["dist/main.js"]
