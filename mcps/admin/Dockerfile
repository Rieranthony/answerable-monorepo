# The admin MCP. Build from the repository root: docker build -f mcps/admin/Dockerfile -t answerable/admin-mcp .
# The server runs from source; the migration runs with the same image: bun mcps/admin/scripts/migrate.ts.
ARG BUN_IMAGE=oven/bun:1.3.1-slim@sha256:86604aff15a156a8854137896af174e2d29e2310f9c9f1aa63de13882e25893d

# The lockfile, bunfig.toml (the linker) and every workspace's package.json, alone, so that the install layers change only when they do.
FROM ${BUN_IMAGE} AS manifests
WORKDIR /src
COPY . .
RUN find . -type f ! -name package.json ! -name bun.lock ! -name bunfig.toml -delete && find . -depth -type d -empty -delete

FROM ${BUN_IMAGE} AS dependencies
WORKDIR /app
COPY --from=manifests /src ./
RUN --mount=type=cache,target=/root/.bun/install/cache,sharing=locked bun install --frozen-lockfile --production --filter @answerable/mcp-admin

FROM ${BUN_IMAGE}
ARG REVISION=unknown
LABEL org.opencontainers.image.title="Answerable admin MCP" \
      org.opencontainers.image.source="https://github.com/Rieranthony/answerable-monorepo" \
      org.opencontainers.image.revision="${REVISION}"
WORKDIR /app
COPY --from=dependencies /app ./
COPY packages/auth packages/auth
COPY packages/config packages/config
COPY packages/id-admin packages/id-admin
COPY packages/mcp packages/mcp
COPY packages/mcp-platform packages/mcp-platform
COPY packages/mcp-postgres packages/mcp-postgres
COPY mcps/admin mcps/admin
# Bun's transpiler cache would write under the home directory; the root filesystem is read-only.
ENV NODE_ENV=production \
    ADMIN_HOST=0.0.0.0 \
    ADMIN_PORT=47520 \
    BUN_RUNTIME_TRANSPILER_CACHE_PATH=0
USER bun
EXPOSE 47520
CMD ["bun", "mcps/admin/src/server.ts"]
