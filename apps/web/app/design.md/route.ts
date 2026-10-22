import { readDesignSource } from "@/lib/design"

export const revalidate = false

// The raw DESIGN.md the /design page renders, as the docs serve their pages.
export function GET() {
  return new Response(readDesignSource(), {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  })
}
