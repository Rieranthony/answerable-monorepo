import { createMDX } from "fumadocs-mdx/next"

/** @type {import("next").NextConfig} */
const config = {
  serverExternalPackages: ["@takumi-rs/core"],
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
