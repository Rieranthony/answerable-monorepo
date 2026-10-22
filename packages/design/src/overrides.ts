// Edits to a design: a contract token or a design path set to a value, and every path that references it following.
import {
  GROUP_TOKENS,
  TYPE_PROPERTIES,
  isColourRole,
  isRole,
  matchKey,
} from "./contract"
import { formatHex } from "./color"
import { levelName } from "./emit"
import { familyName, fontStack } from "./fonts"
import { referenceOf } from "./resolve"
import type { Design, DesignRole, TypeLevel } from "./types"

/**
 * The design path a contract token is written to: `primary` → `roles.primary`,
 * `type-button-size` → `typography.button.fontSize`, `control-md` → `sizes.control-md`.
 */
export function tokenPath(design: Design, name: string): string | undefined {
  if (isRole(name)) return `roles.${name}`
  for (const level of Object.keys(design.typography)) {
    for (const property of TYPE_PROPERTIES) {
      if (name === `type-${levelName(level)}-${property.suffix}`) {
        return `typography.${level}.${property.yaml}`
      }
    }
  }
  const spec = GROUP_TOKENS.find((entry) => entry.name === name)
  if (!spec) return undefined
  const key =
    matchKey(spec.keys, Object.keys(design[spec.source])) ?? spec.keys[0]
  return `${spec.source}.${key}${spec.field ? `.${spec.field}` : ""}`
}

const STRING_GROUPS = {
  rounded: "rounded",
  spacing: "spacing",
  sizes: "sizes",
  elevation: "elevation",
  focus: "focus",
  motion: "motion",
  "output-rules": "outputRules",
} as const

type StringGroup = (typeof STRING_GROUPS)[keyof typeof STRING_GROUPS]

const rest = (parts: string[], from: number) => parts.slice(from).join(".")

const typeProperty = (yaml: string) =>
  TYPE_PROPERTIES.find((property) => property.yaml === yaml)

/** The value at a design path, as text: hex for a colour, a font stack for a font, undefined when there is none. */
export function readPath(design: Design, path: string): string | undefined {
  const parts = path.split(".")
  const [head] = parts
  if (head === "name" || head === "description" || head === "version") {
    return design[head]
  }
  if (head === "colors") return design.colors[rest(parts, 1)]?.hex
  if (head === "roles") {
    return (design.roles as Record<string, DesignRole | undefined>)[
      rest(parts, 1)
    ]?.value
  }
  if (head === "fonts") {
    const font = design.fonts[parts[1]!]
    if (!font) return undefined
    if (parts.length === 2) return fontStack(font)
    if (parts[2] === "weights") {
      const weight = font.weights[parts[3]!]
      return weight === undefined ? undefined : String(weight)
    }
    const value = font[parts[2] as "family" | "fallback"]
    return typeof value === "string" ? value : undefined
  }
  if (head === "typography") {
    const property = typeProperty(parts.at(-1)!)
    const level = design.typography[parts.slice(1, -1).join(".")]
    const value = property && level?.[property.key]
    return value === undefined ? undefined : String(value)
  }
  if (head === "lines") {
    const field = parts.at(-1) as "width" | "color"
    return design.lines[parts.slice(1, -1).join(".")]?.[field]
  }
  if (head === "components") {
    return design.components[parts[1]!]?.[rest(parts, 2)]
  }
  const group = STRING_GROUPS[head as keyof typeof STRING_GROUPS]
  return group ? design[group][rest(parts, 1)] : undefined
}

/** A role's value from a referenced value: hex for a colour, a stack for a font family. */
function roleValue(
  design: Design,
  role: string,
  value: string,
): string | undefined {
  if (isColourRole(role)) return formatHex(value) ?? undefined
  if (role === "font-sans" && !value.includes(",")) {
    const font = Object.values(design.fonts).find(
      (entry) => entry.family.toLowerCase() === familyName(value).toLowerCase(),
    )
    return fontStack(
      font ?? { family: value, fallback: "system-ui, sans-serif" },
    )
  }
  return value
}

function setLevel(level: TypeLevel, yaml: string, value: string): boolean {
  const property = typeProperty(yaml)
  if (!property) return false
  if (property.key === "weight") {
    const weight = Number(value)
    if (!Number.isFinite(weight)) return false
    level.weight = weight
  } else if (property.key === "fontFamily") {
    level.fontFamily = familyName(value.split(",")[0]!)
  } else {
    level[property.key] = value
  }
  return true
}

/**
 * Writes a value at a design path. An edit (`refresh` false) changes what the file says: a colour's
 * written value becomes its hex, a role loses its reference. A refresh only follows a referenced value.
 * Returns false for a path the design cannot hold or a value it cannot take.
 */
function writePath(
  design: Design,
  path: string,
  value: string,
  refresh: boolean,
): boolean {
  const parts = path.split(".")
  const [head] = parts
  if (head === "name" || head === "description" || head === "version") {
    design[head] = value
    return true
  }
  if (head === "colors") {
    const hex = formatHex(value)
    const name = rest(parts, 1)
    if (!hex || !name) return false
    const raw = refresh ? (design.colors[name]?.raw ?? hex) : hex
    design.colors[name] = { raw, hex }
    return true
  }
  if (head === "roles") {
    const role = rest(parts, 1)
    if (!isRole(role)) return false
    const ref = refresh ? undefined : referenceOf(value)
    const resolved = ref === undefined ? value : readPath(design, ref)
    const text =
      resolved === undefined ? undefined : roleValue(design, role, resolved)
    if (text === undefined) return false
    if (refresh) {
      design.roles[role].value = text
      return true
    }
    design.roles[role] =
      ref === undefined ? { value: text } : { ref, value: text }
    if (ref !== undefined) design.refs[path] = ref
    return true
  }
  if (head === "fonts") {
    const font = design.fonts[parts[1]!]
    if (!font || parts.length < 3) return false
    if (parts[2] === "weights") {
      const weight = Number(value)
      if (parts.length !== 4 || !Number.isInteger(weight)) return false
      font.weights[parts[3]!] = weight
    } else if (parts[2] === "family" || parts[2] === "fallback") {
      font[parts[2]] = parts[2] === "family" ? familyName(value) : value
    } else return false
    if (!refresh) delete font.inferred
    return true
  }
  if (head === "typography") {
    const name = parts.slice(1, -1).join(".")
    if (!name) return false
    const level = design.typography[name] ?? {}
    if (!setLevel(level, parts.at(-1)!, value)) return false
    design.typography[name] = level
    return true
  }
  if (head === "lines") {
    const field = parts.at(-1)
    const line = design.lines[parts.slice(1, -1).join(".")]
    if (!line || (field !== "width" && field !== "color")) return false
    const text = field === "color" ? formatHex(value) : value
    if (!text) return false
    line[field] = text
    return true
  }
  if (head === "components") {
    const component = design.components[parts[1]!]
    if (!refresh || !component) return false
    component[rest(parts, 2)] = value
    return true
  }
  const group = STRING_GROUPS[head as keyof typeof STRING_GROUPS] as
    StringGroup | undefined
  const key = rest(parts, 1)
  if (!group || !key) return false
  design[group][key] = value
  return true
}

const METADATA = new Set(["name", "description", "version"])

const related = (a: string, b: string) =>
  a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`)

/**
 * The design with the overrides applied. A key with a dot is a design path (`colors.accent-coral`,
 * `fonts.sans.family`, `typography.button.fontSize`), as are `name`, `description` and `version`; any
 * other key is a contract token (`primary`,
 * `type-button-size`, `control-md`), written to the path `tokenPath` gives. Every path that references
 * an edited one follows it, so editing `colors.neutral-100` moves `muted` and every role bound to either.
 * Overrides the design cannot take are left out.
 */
export function applyOverrides(
  design: Design,
  overrides: Record<string, string>,
): Design {
  const next = structuredClone(design)
  const touched = new Set<string>()
  for (const [key, value] of Object.entries(overrides)) {
    const path =
      key.includes(".") || METADATA.has(key) ? key : tokenPath(next, key)
    if (path === undefined) continue
    const previous = next.refs[path]
    delete next.refs[path]
    if (writePath(next, path, value, false)) touched.add(path)
    else if (previous !== undefined) next.refs[path] = previous
  }
  let changed = touched.size > 0
  while (changed) {
    changed = false
    for (const [path, target] of Object.entries(next.refs)) {
      if (
        touched.has(path) ||
        ![...touched].some((edited) => related(target, edited))
      )
        continue
      touched.add(path)
      changed = true
      const value = readPath(next, target)
      if (value !== undefined) writePath(next, path, value, true)
    }
  }
  return next
}
