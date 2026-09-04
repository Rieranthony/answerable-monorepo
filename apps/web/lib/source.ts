import { loader } from "fumadocs-core/source"
import { pageSchema } from "fumadocs-core/source/schema"
import { defineDocs } from "fumadocs-mdx/macro"
import { z } from "zod"

export const docs = defineDocs({
  dir: "content/docs",
  docs: {
    postprocess: { includeProcessedMarkdown: true },
    schema: pageSchema.extend({ description: z.string().min(1) }),
  },
})

export const source = loader({
  baseUrl: "/docs",
  source: docs.toFumadocsSource(),
})
