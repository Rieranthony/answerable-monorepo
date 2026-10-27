# The ops image: the database bootstrap, the registration in ID and the first administrator (infra/ops/README.md).
# Build from the repository root:
# docker build -f infra/ops/Dockerfile -t answerable/ops .
# The chart's Jobs run it as bun infra/ops/src/cli.ts bootstrap, register or make-admin.
ARG BUN_IMAGE=oven/bun:1.3.1-slim@sha256:86604aff15a156a8854137896af174e2d29e2310f9c9f1aa63de13882e25893d

# The lockfile, bunfig.toml (the linker) and every workspace's package.json, alone, so that the install layers change only when they do.
FROM ${BUN_IMAGE} AS manifests
WORKDIR /src
COPY . .
RUN find . -type f ! -name package.json ! -name bun.lock ! -name bunfig.toml -delete && find . -depth -type d -empty -delete

FROM ${BUN_IMAGE} AS dependencies
WORKDIR /app
COPY --from=manifests /src ./
RUN --mount=type=cache,target=/root/.bun/install/cache,sharing=locked bun install --frozen-lockfile --production --filter @answerable/infra-ops

FROM ${BUN_IMAGE}
ARG REVISION=unknown
LABEL org.opencontainers.image.title="Answerable ops" \
      org.opencontainers.image.source="https://github.com/Rieranthony/answerable-monorepo" \
      org.opencontainers.image.revision="${REVISION}"
WORKDIR /app
COPY --from=dependencies /app ./
# connect() is the only import from mcp-postgres, which brings drizzle-orm and pg; its imports of @answerable/mcp are types, which Bun strips.
COPY packages/mcp-postgres packages/mcp-postgres
# The OPS_* definitions (src/commands.ts).
COPY packages/config packages/config
COPY infra/ops infra/ops
# Bun's transpiler cache would write under the home directory; the root filesystem is read-only.
ENV NODE_ENV=production \
    BUN_RUNTIME_TRANSPILER_CACHE_PATH=0
USER bun
CMD ["bun", "infra/ops/src/cli.ts"]
