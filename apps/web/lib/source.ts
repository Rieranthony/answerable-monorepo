import { loader } from "fumadocs-core/source"
import { pageSchema } from "fumadocs-core/source/schema"
import { defineDocs } from "fumadocs-mdx/macro"
import { z } from "zod"

import { openapi } from "@/lib/openapi"

export const docs = defineDocs({
  dir: "content/docs",
  docs: {
    postprocess: { includeProcessedMarkdown: true },
    schema: pageSchema.extend({ description: z.string().min(1) }),
  },
})

export const source = loader(
  {
    docs: docs.toFumadocsSource(),
    openapi: await openapi.staticSource({
      baseDir: "id/api",
      per: "operation",
      groupBy: "tag",
    }),
  },
  { baseUrl: "/docs", plugins: [openapi.loaderPlugin()] },
)

export function getPageImageUrl(page: (typeof source)["$inferPage"]) {
  const segments = [...page.slugs, "image.webp"]

  return {
    segments,
    url: "/" + ["og", "docs", ...segments].join("/"),
  }
}
