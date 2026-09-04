import { readFile } from "node:fs/promises"
import path from "node:path"
import { notFound } from "next/navigation"
import { ImageResponse } from "takumi-js/response"

import { DocsOgImage } from "@/components/docs/og-image"
import { getPageImageUrl, source } from "@/lib/source"

export const revalidate = false

const fontBuffers = Promise.all([
  readFile(path.join(process.cwd(), "assets/fonts/PublicSans-Regular.woff2")),
  readFile(path.join(process.cwd(), "assets/fonts/PublicSans-Bold.woff2")),
])

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string[] }> },
) {
  const { slug } = await params
  const page = source.getPage(slug.slice(0, -1))

  if (!page) notFound()

  const [regular, bold] = await fontBuffers

  return new ImageResponse(
    <DocsOgImage
      title={page.data.title ?? "Answerable docs"}
      description={page.data.description}
    />,
    {
      width: 1200,
      height: 630,
      format: "webp",
      fonts: [
        { name: "Public Sans", data: regular, weight: 400 },
        { name: "Public Sans", data: bold, weight: 700 },
      ],
    },
  )
}

export function generateStaticParams() {
  return source.getPages().map((page) => ({
    slug: getPageImageUrl(page).segments,
  }))
}
