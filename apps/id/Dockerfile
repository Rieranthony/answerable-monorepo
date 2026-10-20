# Answerable ID. Build from the repository root: docker build -f apps/id/Dockerfile -t answerable/id .
# The service runs the bundle (apps/id/dist/server.js); the migration runs the same image's bundled script:
# bun --no-install apps/id/dist/scripts/migrate.js, with DATABASE_MIGRATION_URL and DATABASE_RUNTIME_ROLE. Both bundles
# carry every dependency, so the image holds apps/id/dist and the migrations only: no node_modules and no sources.
# --no-install: with no node_modules, Bun would otherwise try to install an optional package a library imports on demand
# (and crash on the read-only root filesystem) instead of letting the import fail as the library expects.
ARG BUN_IMAGE=oven/bun:1.3.1-slim@sha256:86604aff15a156a8854137896af174e2d29e2310f9c9f1aa63de13882e25893d

# The lockfile and every workspace's package.json, alone, so that the install layers change only when they do.
FROM ${BUN_IMAGE} AS manifests
WORKDIR /src
COPY . .
RUN find . -type f ! -name package.json ! -name bun.lock -delete && find . -depth -type d -empty -delete

FROM ${BUN_IMAGE} AS build
WORKDIR /app
COPY --from=manifests /src ./
RUN --mount=type=cache,target=/root/.bun/install/cache,sharing=locked bun install --frozen-lockfile --filter @answerable/id
COPY packages/countries packages/countries
COPY packages/ui packages/ui
COPY apps/id apps/id
RUN bun run --filter @answerable/id build

FROM ${BUN_IMAGE}
ARG REVISION=unknown
LABEL org.opencontainers.image.title="Answerable ID" \
      org.opencontainers.image.source="https://github.com/Rieranthony/answerable-monorepo" \
      org.opencontainers.image.revision="${REVISION}"
WORKDIR /app
COPY apps/id/drizzle apps/id/drizzle
COPY --from=build /app/apps/id/dist apps/id/dist
# Bun's transpiler cache would write under the home directory; the root filesystem is read-only.
ENV NODE_ENV=production \
    PORT=47300 \
    BUN_RUNTIME_TRANSPILER_CACHE_PATH=0
USER bun
EXPOSE 47300
CMD ["bun", "--no-install", "apps/id/dist/server.js"]
