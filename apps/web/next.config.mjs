import { fileURLToPath } from "node:url"
import { createMDX } from "fumadocs-mdx/next"

/** @type {import("next").NextConfig} */
const config = {
  // app/global-not-found.tsx: with two root layouts, an unmatched URL has no layout of its own.
  experimental: { globalNotFound: true },
  logging: {
    incomingRequests: {
      ignore: [/^\/api\/oauth-test\/callback(?:\?|$)/],
    },
  },
  // The repository root, not the nearest lockfile Next infers: a worktree sits
  // inside the main checkout, and Tailwind scans from this root.
  turbopack: { root: fileURLToPath(new URL("../..", import.meta.url)) },
  // Google's design.md linter reads its spec file beside its own module.
  serverExternalPackages: ["@takumi-rs/core", "@google/design.md"],
  transpilePackages: [
    "@answerable/ui",
    "@answerable/countries",
    "@answerable/design",
  ],
  async headers() {
    return [
      "/docs/:path*",
      "/docs.md",
      "/design.md",
      "/llms.mdx/:path*",
      "/llms.txt",
      "/llms-full.txt",
      "/api/search",
    ].map((source) => ({
      source,
      headers: [{ key: "X-Robots-Tag", value: "noindex, follow" }],
    }))
  },
  // Pages that moved when the docs were split into Answerable ID, the MCP kit and the Toolbox.
  async redirects() {
    return [
      ["/docs/mcp/authoring", "/docs/mcp/tools"],
      ["/docs/mcp/toolbox", "/docs/toolbox"],
      ["/docs/mcp/toolbox-admin", "/docs/toolbox/admin"],
    ].flatMap(([source, destination]) => [
      { source, destination, permanent: true },
      {
        source: `${source}.md`,
        destination: `${destination}.md`,
        permanent: true,
      },
    ])
  },
  async rewrites() {
    return [
      {
        source: "/docs/:path*.md",
        destination: "/llms.mdx/docs/:path*",
      },
    ]
  },
}

export default createMDX()(config)
