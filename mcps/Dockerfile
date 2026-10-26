# The mcps image (D8): the Toolbox, the admin MCP and every MCP under mcps/, from source. Build from the repository root:
# docker build -f mcps/Dockerfile -t answerable/mcps .
# Each Deployment and Job chooses its server or script by command: bun mcps/toolbox/src/server.ts or bun mcps/admin/src/server.ts, and the
# migrations bun mcps/toolbox/scripts/migrate.ts (the Toolbox's database, then every MCP) and bun mcps/admin/scripts/migrate.ts. A new MCP
# needs no line here: every workspace under mcps/ is installed and copied, and so is every package. e2e's view is bundled when it is first
# imported, so there is no build stage.
ARG BUN_IMAGE=oven/bun:1.3.1-slim@sha256:86604aff15a156a8854137896af174e2d29e2310f9c9f1aa63de13882e25893d

# The lockfile, bunfig.toml (the linker) and every workspace's package.json, alone, so that the install layers change only when they do.
FROM ${BUN_IMAGE} AS manifests
WORKDIR /src
COPY . .
RUN find . -type f ! -name package.json ! -name bun.lock ! -name bunfig.toml -delete && find . -depth -type d -empty -delete

FROM ${BUN_IMAGE} AS dependencies
WORKDIR /app
COPY --from=manifests /src ./
RUN --mount=type=cache,target=/root/.bun/install/cache,sharing=locked bun install --frozen-lockfile --production --filter './mcps/*'

FROM ${BUN_IMAGE}
ARG REVISION=unknown
LABEL org.opencontainers.image.title="Answerable MCPs" \
      org.opencontainers.image.source="https://github.com/Rieranthony/answerable-monorepo" \
      org.opencontainers.image.revision="${REVISION}"
WORKDIR /app
COPY --from=dependencies /app ./
# Every package, so that an MCP may use any of them; .dockerignore leaves out their tests, Markdown, coverage and the acceptance kit.
COPY packages packages
COPY mcps mcps
# Bun's transpiler cache would write under the home directory; the root filesystem is read-only. Each server listens on every address of its
# pod, on its own port (47400, 47520).
ENV NODE_ENV=production \
    TOOLBOX_HOST=0.0.0.0 \
    ADMIN_HOST=0.0.0.0 \
    BUN_RUNTIME_TRANSPILER_CACHE_PATH=0
USER bun
EXPOSE 47400 47520
