# The Toolbox. Build from the repository root: docker build -f mcps/toolbox/Dockerfile -t answerable/toolbox .
# The server runs from source and imports the e2e provider's built view; the migration runs with the same image:
# bun mcps/toolbox/scripts/migrate.ts.
ARG BUN_IMAGE=oven/bun:1.3.1-slim@sha256:86604aff15a156a8854137896af174e2d29e2310f9c9f1aa63de13882e25893d

# The lockfile, bunfig.toml (the linker) and every workspace's package.json, alone, so that the install layers change only when they do.
FROM ${BUN_IMAGE} AS manifests
WORKDIR /src
COPY . .
RUN find . -type f ! -name package.json ! -name bun.lock ! -name bunfig.toml -delete && find . -depth -type d -empty -delete

FROM ${BUN_IMAGE} AS build
WORKDIR /app
COPY --from=manifests /src ./
RUN --mount=type=cache,target=/root/.bun/install/cache,sharing=locked bun install --frozen-lockfile --filter @answerable/mcp-e2e
COPY packages/auth packages/auth
COPY packages/mcp packages/mcp
COPY mcps/e2e mcps/e2e
RUN bun run --filter @answerable/mcp-e2e build

FROM ${BUN_IMAGE} AS dependencies
WORKDIR /app
COPY --from=manifests /src ./
RUN --mount=type=cache,target=/root/.bun/install/cache,sharing=locked bun install --frozen-lockfile --production --filter @answerable/mcp-toolbox

FROM ${BUN_IMAGE}
ARG REVISION=unknown
LABEL org.opencontainers.image.title="Answerable Toolbox" \
      org.opencontainers.image.source="https://github.com/Rieranthony/answerable-monorepo" \
      org.opencontainers.image.revision="${REVISION}"
WORKDIR /app
COPY --from=dependencies /app ./
COPY packages/auth packages/auth
COPY packages/config packages/config
COPY packages/id-admin packages/id-admin
COPY packages/mcp packages/mcp
COPY packages/mcp-postgres packages/mcp-postgres
COPY mcps/e2e mcps/e2e
COPY --from=build /app/mcps/e2e/dist mcps/e2e/dist
COPY mcps/toolbox mcps/toolbox
# Bun's transpiler cache would write under the home directory; the root filesystem is read-only.
ENV NODE_ENV=production \
    TOOLBOX_HOST=0.0.0.0 \
    TOOLBOX_PORT=47400 \
    BUN_RUNTIME_TRANSPILER_CACHE_PATH=0
USER bun
EXPOSE 47400
CMD ["bun", "mcps/toolbox/src/server.ts"]
