import type { InferPageType } from "fumadocs-core/source"

import type { docs, source } from "@/lib/source"

const CONTRACT_URL = "https://id.answerable.org/openapi.json"

export async function getLLMText(page: InferPageType<typeof source>) {
  const heading = `# ${page.data.title} (${page.url})`

  if (page.type === "openapi") {
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
      `Schemas referenced by \`$ref\` are in the full contract: ${CONTRACT_URL}`,
    ]
      .filter(Boolean)
      .join("\n\n")
  }

  const data = page.data as (typeof docs.docs)[number]

  return `${heading}\n\n${await data.getText("processed")}`
}
