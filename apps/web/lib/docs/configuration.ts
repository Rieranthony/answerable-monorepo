// The rows of `<Configuration group="…" />`: the variables a service reads, from packages/config/inventory.json, which
// `bun run env:inventory` writes from each service's definition. Inline Markdown only: code spans.
import inventory from "../../../../packages/config/inventory.json"
import type { FieldMeta } from "../../../../packages/config/src"

type Group = { name: string; fields: FieldMeta[] }

const groups = inventory as Group[]

// Typed by the package's sources, so a new one fails the web typecheck until it is worded here.
const deployedFrom: Record<NonNullable<FieldMeta["source"]>, string> = {
  deploy: "The deploy step, from the GitHub environment",
  cluster: "The cluster: Terraform or the ops Jobs",
  chart: "The chart",
  image: "The image",
  operator: "An operator, when needed",
}

function defaultOf({ fallback, local, optional }: FieldMeta) {
  if (fallback !== undefined) return fallback ? `\`${fallback}\`` : "Empty"
  if (local === undefined) return optional ? "Optional" : "Required"
  return `\`${local}\` locally; ${optional ? "optional" : "required"} in production`
}

export const configurationHeaders = [
  "Variable",
  "Secret",
  "Default",
  "In a deployment",
  "Meaning",
]

/** One variable as a row: its name, whether it is a secret, its default, where a deployment's value comes from, its doc. */
export function configurationRow(field: FieldMeta) {
  return [
    `\`${field.name}\``,
    field.secret ? "Yes" : "No",
    defaultOf(field),
    field.source ? deployedFrom[field.source] : "Not set",
    field.doc,
  ]
}

/**
 * The rows of one inventory group, or of several in one table: each variable once, under the first group that reads
 * it. An unknown group name throws, so the page fails to build.
 */
export function configurationRows(group: string | string[]) {
  const seen = new Set<string>()

  return [group].flat().flatMap((name) => {
    const found = groups.find((candidate) => candidate.name === name)
    if (!found) {
      throw new Error(
        `packages/config/inventory.json has no group "${name}"; it has ${groups.map((candidate) => `"${candidate.name}"`).join(", ")}`,
      )
    }

    return found.fields
      .filter((field) => !seen.has(field.name) && seen.add(field.name))
      .map(configurationRow)
  })
}
