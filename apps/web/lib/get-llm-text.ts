import type { InferPageType } from "fumadocs-core/source"

import type { docs, source } from "@/lib/source"

export async function getLLMText(page: InferPageType<typeof source>) {
  const heading = `# ${page.data.title} (${page.url})`

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
      heading,
      page.data.description,
      ...sections,
      `Schemas referenced by \`$ref\` are in the full contract: ${contractUrl}`,
    ]
      .filter(Boolean)
      .join("\n\n")
  }

  const data = page.data as (typeof docs.docs)[number]

  return `${heading}\n\n${await data.getText("processed")}`
}
