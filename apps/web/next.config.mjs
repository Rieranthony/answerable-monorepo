import { createMDX } from "fumadocs-mdx/next"

/** @type {import("next").NextConfig} */
const config = {
  logging: {
    incomingRequests: {
      ignore: [/^\/api\/oauth-test\/callback(?:\?|$)/],
    },
  },
  serverExternalPackages: ["@takumi-rs/core"],
  transpilePackages: ["@answerable/ui", "@answerable/countries"],
  async headers() {
    return [
      "/docs/:path*",
      "/docs.md",
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
