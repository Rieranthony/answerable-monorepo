import { loader } from "fumadocs-core/source"
import { pageSchema } from "fumadocs-core/source/schema"
import { defineDocs } from "fumadocs-mdx/macro"
import { z } from "zod"

import { adminOpenapi, openapi } from "@/lib/openapi"

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
    openapi: {
      files: [
        ...(
          await openapi.staticSource({
            baseDir: "id/api",
            per: "operation",
            groupBy: "tag",
          })
        ).files,
        ...(
          await adminOpenapi.staticSource({
            baseDir: "id/admin-api",
            per: "operation",
            groupBy: "tag",
          })
        ).files.map((file) =>
          file.type === "page"
            ? {
                ...file,
                data: {
                  ...file.data,
                  description: file.data.description ?? `${file.data.title}.`,
                },
              }
            : file,
        ),
      ],
    },
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
