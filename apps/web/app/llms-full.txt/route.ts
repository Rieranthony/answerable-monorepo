import { getLLMText } from "@/lib/get-llm-text"
import { source } from "@/lib/source"

export const revalidate = false

export async function GET() {
  const pages = await Promise.all(
    source.getPages().map((page) => getLLMText(page, { source: true })),
  )

  return new Response(pages.join("\n\n"))
}
