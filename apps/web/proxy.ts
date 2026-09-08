import { isMarkdownPreferred, rewritePath } from "fumadocs-core/negotiation"
import { type NextRequest, NextResponse } from "next/server"

const markdownPath = rewritePath("/docs{/*path}", "/llms.mdx/docs{/*path}")

export function proxy(request: NextRequest) {
  // Explicit Markdown URLs are handled by next.config.mjs; negotiating them
  // again would leave the .md suffix in the source lookup and return 404.
  if (request.nextUrl.pathname.endsWith(".md")) return
  if (!isMarkdownPreferred(request)) return

  const pathname = markdownPath.rewrite(request.nextUrl.pathname)

  if (!pathname) return

  const url = request.nextUrl.clone()
  url.pathname = pathname

  const response = NextResponse.rewrite(url)
  response.headers.set("Vary", "Accept")

  return response
}

export const config = { matcher: ["/docs/:path*"] }
