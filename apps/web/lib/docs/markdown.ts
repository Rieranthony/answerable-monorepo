// The Markdown forms of the docs' generated blocks, for `.md` pages and llms-full.txt.

/** One field of a type table: what `fumadocs-typescript` generates from a TypeScript type and its doc comments. */
export type TypeField = {
  name: string
  description: string
  type: string
  simplifiedType: string
  required: boolean
  tags?: { name: string; text: string }[]
}

const cell = (text: string) =>
  text
    .replace(/\|/g, "\\|")
    .replace(/\s*\n\s*/g, " ")
    .trim()

/** A GitHub-flavoured Markdown table. Pipes and line breaks inside cells are escaped. */
export function markdownTable(headers: string[], rows: string[][]) {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`),
  ].join("\n")
}

/**
 * The type as written when it is short, else the simplified form the HTML table shows; `?` already says optional.
 * A `@remarks` tag in the source names the type outright, as it does for the HTML table.
 */
export function displayType({
  type,
  simplifiedType,
  required,
  tags,
}: TypeField) {
  if (tags?.some((tag) => tag.name === "remarks")) return simplifiedType
  const written = required ? type : type.replace(/ \| undefined$/, "")

  return written.length <= 60 && !written.includes("\n")
    ? written
    : simplifiedType
}

export const typeTableHeaders = ["Field", "Type", "Description"]

/**
 * The rows of a type table, in inline Markdown: field (with `?` when optional), type and description. The HTML and the
 * Markdown form of a page render these same rows, so both carry the same words.
 */
export function typeTableRows(fields: TypeField[]) {
  return fields.map((field) => [
    `\`${field.name}${field.required ? "" : "?"}\``,
    `\`${displayType(field)}\``,
    field.description,
  ])
}

/** A type table as a Markdown table. */
export function typeTableMarkdown(fields: TypeField[]) {
  return markdownTable(typeTableHeaders, typeTableRows(fields))
}

/** Number the `###` headings of a Steps block, `### 1. Scaffold a server`, as the page numbers its steps. */
export function numberSteps(markdown: string) {
  let step = 0

  return markdown.replace(
    /^### (.+)$/gm,
    (_, heading) => `### ${++step}. ${heading}`,
  )
}

/** A fenced code block, with a `title` when given. */
export function codeFence(code: string, lang: string, title?: string) {
  const fence = code.includes("```") ? "````" : "```"
  const meta = title ? ` title="${title}"` : ""

  return `${fence}${lang}${meta}\n${code.replace(/\n$/, "")}\n${fence}`
}
