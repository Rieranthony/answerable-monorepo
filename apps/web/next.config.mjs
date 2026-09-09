import { createMDX } from "fumadocs-mdx/next"

/** @type {import("next").NextConfig} */
const config = {
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
