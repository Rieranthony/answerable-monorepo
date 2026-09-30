import type { InferPageType } from "fumadocs-core/source"

import { getMDXComponents } from "@/components/mdx"
import { SITE } from "@/lib/metadata"

import type { docs, source } from "@/lib/source"

/**
 * A page as Markdown: its title and description, as the page shows them, then its body. `source: true` adds the page's
 * URL under the title, for llms-full.txt, where pages follow one another.
 */
export async function getLLMText(
  page: InferPageType<typeof source>,
  { source: withSource = false }: { source?: boolean } = {},
) {
  const head = [
    `# ${page.data.title}`,
    withSource ? `Source: ${SITE.origin}${page.url}` : "",
    page.data.description ?? "",
  ]

  if (page.type === "openapi") {
    const contractUrl =
      page.slugs[1] === "admin-api"
        ? "https://id.answerable.org/api/admin/openapi.json"
        : "https://id.answerable.org/openapi.json"
    const { bundled } = page.data.getSchema()
    const { operations = [] } = page.data.getOpenAPIPageProps()
    const sections = operations.map((operation) => {
      const item = bundled.paths?.[operation.path]?.[operation.method]

      return `## ${operation.method.toUpperCase()} ${operation.path}\n\n\`\`\`json\n${JSON.stringify(item, null, 2)}\n\`\`\``
    })

    return [
      ...head,
      ...sections,
      `Schemas referenced by \`$ref\` are in the full contract: ${contractUrl}`,
    ]
      .filter(Boolean)
      .join("\n\n")
  }

  const data = page.data as (typeof docs.docs)[number]
  // The processed Markdown is a component (`output: "function"`): its text was stringified when the page compiled, and
  // its components render their own Markdown forms here.
  const body = await data.getText("processed", {
    components: getMDXComponents(),
  })

  return [...head, body].filter(Boolean).join("\n\n")
}
