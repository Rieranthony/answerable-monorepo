// The profile pass over the resolved YAML tree: typed groups, fonts and typography.
import { TYPE_PROPERTIES } from "./contract"
import { formatHex, parseColor } from "./color"
import {
  categoryFallback,
  familyName,
  findFont,
  type GoogleFont,
} from "./fonts"
import { isTree, referenceOf, type Tree } from "./resolve"
import type {
  DesignColor,
  DesignFont,
  DesignLine,
  Finding,
  FontWeights,
  TypeLevel,
} from "./types"

/** What the profile pass reads and writes. */
export interface Context {
  raw: Tree
  resolved: Tree
  refs: Record<string, string>
  findings: Finding[]
  catalogue: readonly GoogleFont[]
  /** The official model's colours, for notations culori does not read. */
  officialColors: ReadonlyMap<string, { hex: string }>
}

/** Records a profile finding. */
export function report(
  context: Context,
  severity: Finding["severity"],
  path: string,
  message: string,
  rule = "profile-shape",
): void {
  context.findings.push({ severity, path, message, rule })
}

/** The mapping at a top-level key, or an empty one; a value that is not a mapping is reported. */
export function group(context: Context, key: string): [Tree, Tree] {
  const raw = context.raw[key]
  if (raw === undefined) return [{}, {}]
  if (!isTree(raw)) {
    report(
      context,
      "warning",
      key,
      `"${key}" must be a mapping; it is ignored.`,
    )
    return [{}, {}]
  }
  return [raw, context.resolved[key] as Tree]
}

/** Whether a resolved value is still a reference: one the resolver reported as missing or circular. */
export const unresolved = (value: unknown) => referenceOf(value) !== undefined

const DIMENSION = /^-?(\d*\.)?\d+[a-zA-Z%]+$/
const DURATION = /^(\d*\.)?\d+m?s$/

/** Whether a value is a CSS dimension, or zero. */
export const isDimension = (value: string) =>
  DIMENSION.test(value) || /^-?0$/.test(value)

const PROSE = new Set(["rule", "usage"])

/** A group of strings: each value as text, with its prose keys kept aside and wrong shapes reported. */
export function strings(
  context: Context,
  key: string,
  check: (name: string, value: string) => string | undefined = () => undefined,
  notes?: Record<string, string>,
): Record<string, string> {
  const [raw, resolved] = group(context, key)
  const result: Record<string, string> = {}
  for (const name of Object.keys(raw)) {
    const value = resolved[name]
    if (unresolved(value)) continue
    if (notes && PROSE.has(name) && typeof value === "string") {
      notes[name] = value
      continue
    }
    if (typeof value !== "string" && typeof value !== "number") {
      report(
        context,
        "warning",
        `${key}.${name}`,
        `"${key}.${name}" must be a value, not a group; it is ignored.`,
      )
      continue
    }
    const text = String(value)
    const problem = check(name, text)
    if (problem) {
      report(context, "warning", `${key}.${name}`, problem)
      continue
    }
    result[name] = text
  }
  return result
}

/** The `colors` group: every leaf, nested groups flattened with dots as the official model does. */
export function colors(context: Context): Record<string, DesignColor> {
  const [raw, resolved] = group(context, "colors")
  const result: Record<string, DesignColor> = {}
  const walk = (rawNode: Tree, resolvedNode: Tree, prefix: string) => {
    for (const [key, value] of Object.entries(rawNode)) {
      const name = prefix + key
      const target = resolvedNode[key]
      if (isTree(value)) {
        walk(value, target as Tree, `${name}.`)
        continue
      }
      if (typeof value !== "string" || unresolved(target)) continue
      if (typeof target !== "string") {
        report(
          context,
          "error",
          `colors.${name}`,
          `"colors.${name}" references a group, not a colour.`,
          "profile-reference",
        )
        continue
      }
      const hex = formatHex(target)
      if (hex) {
        result[name] = { raw: value, hex }
        continue
      }
      const official = context.officialColors.get(name)
      if (official) {
        result[name] = { raw: value, hex: formatHex(official.hex)! }
        report(
          context,
          "info",
          `colors.${name}`,
          `"${target}" is read with the official linter's sRGB value; culori does not parse it.`,
          "profile-color",
        )
      }
    }
  }
  walk(raw, resolved, "")
  return result
}

/** The `lines` group: `{ width, color }` per line, its prose keys kept aside. */
export function lines(
  context: Context,
  notes: Record<string, string>,
): Record<string, DesignLine> {
  const [raw, resolved] = group(context, "lines")
  const result: Record<string, DesignLine> = {}
  for (const name of Object.keys(raw)) {
    const value = resolved[name]
    const path = `lines.${name}`
    if (PROSE.has(name) && typeof value === "string") {
      notes[name] = value
      continue
    }
    if (!isTree(value)) {
      report(
        context,
        "warning",
        path,
        `"${path}" must be a mapping of width and color; it is ignored.`,
      )
      continue
    }
    const width = value.width
    const color =
      typeof value.color === "string" ? parseColor(value.color) : null
    if (typeof width !== "string" || !isDimension(width)) {
      report(
        context,
        "warning",
        path,
        `"${path}.width" must be a dimension, such as 1px; the line is ignored.`,
      )
      continue
    }
    if (!color) {
      report(
        context,
        "warning",
        path,
        `"${path}.color" must be a colour; the line is ignored.`,
      )
      continue
    }
    result[name] = { width, color: color.hex }
  }
  return result
}

/** The family a typography value names: a string's first family, or a font's family. */
function namedFamily(value: unknown): string | undefined {
  if (isTree(value) && typeof value.family === "string") return value.family
  if (typeof value === "string" && !unresolved(value)) {
    return familyName(value.split(",")[0]!)
  }
  return undefined
}

/** The rest of a font stack after its first family, if the value is a stack. */
function stackFallback(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.includes(",")) return undefined
  return value.slice(value.indexOf(",") + 1).trim()
}

const slug = (family: string) =>
  familyName(family)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

function checkCatalogue(
  context: Context,
  path: string,
  family: string,
  weights: FontWeights,
) {
  const entry = findFont(family, context.catalogue)
  if (!entry) {
    report(
      context,
      "warning",
      path,
      `"${family}" is not in the Google Fonts catalogue.`,
      "profile-font",
    )
    return
  }
  for (const [role, weight] of Object.entries(weights)) {
    if (!entry.weights.includes(weight!)) {
      report(
        context,
        "warning",
        `${path}.weights.${role}`,
        `"${family}" does not offer weight ${weight}; it offers ${entry.weights.join(", ")}.`,
        "profile-font",
      )
    }
  }
}

function fontWeights(
  context: Context,
  path: string,
  value: unknown,
): FontWeights {
  if (value === undefined) return {}
  if (!isTree(value)) {
    report(
      context,
      "warning",
      `${path}.weights`,
      `"${path}.weights" must map roles to weights, such as body: 400.`,
    )
    return {}
  }
  const weights: FontWeights = {}
  for (const [role, weight] of Object.entries(value)) {
    const number = Number(weight)
    if (Number.isInteger(number) && number >= 1 && number <= 1000)
      weights[role] = number
    else
      report(
        context,
        "warning",
        `${path}.weights.${role}`,
        `"${path}.weights.${role}" must be a weight from 1 to 1000.`,
      )
  }
  return weights
}

const FONT_KEYS = new Set([
  "family",
  "provider",
  "weights",
  "fallback",
  "default",
])

function declaredFont(
  context: Context,
  key: string,
  value: unknown,
): DesignFont | undefined {
  const path = `fonts.${key}`
  if (
    !isTree(value) ||
    typeof value.family !== "string" ||
    !value.family.trim()
  ) {
    report(
      context,
      "warning",
      path,
      `"${path}" must be a mapping with a family; it is ignored.`,
    )
    return undefined
  }
  for (const name of Object.keys(value)) {
    if (!FONT_KEYS.has(name))
      report(
        context,
        "warning",
        `${path}.${name}`,
        `"${name}" is not a font property: family, provider, weights, fallback, default.`,
      )
  }
  if (value.provider !== undefined && value.provider !== "google") {
    report(
      context,
      "warning",
      `${path}.provider`,
      `Only the google provider is supported; "${String(value.provider)}" is read as google.`,
    )
  }
  if (value.fallback !== undefined && typeof value.fallback !== "string") {
    report(
      context,
      "warning",
      `${path}.fallback`,
      `"${path}.fallback" must be a CSS font stack.`,
    )
  }
  if (value.default !== undefined && typeof value.default !== "boolean") {
    report(
      context,
      "warning",
      `${path}.default`,
      `"${path}.default" must be true or false.`,
    )
  }
  const family = familyName(value.family)
  const weights = fontWeights(context, path, value.weights)
  checkCatalogue(context, path, family, weights)
  return {
    family,
    provider: "google",
    weights,
    fallback:
      typeof value.fallback === "string"
        ? value.fallback
        : categoryFallback(findFont(family, context.catalogue)?.category),
    default: value.default === true,
  }
}

/** The `fonts` group, completed with a font per family a typography level names that the group lacks. */
export function fonts(context: Context): Record<string, DesignFont> {
  const [raw, resolved] = group(context, "fonts")
  const result: Record<string, DesignFont> = {}
  for (const key of Object.keys(raw)) {
    const font = declaredFont(context, key, resolved[key])
    if (font) result[key] = font
  }
  const declared = Object.keys(result)
  const marked = declared.filter((key) => result[key]!.default)
  if (marked.length > 1) {
    report(
      context,
      "warning",
      "fonts",
      `Several fonts are marked default; fonts.${marked[0]} is used.`,
      "profile-font",
    )
    for (const key of marked.slice(1)) result[key]!.default = false
  }
  if (marked.length === 0 && declared.length > 0) {
    result[declared[0]!]!.default = true
    report(
      context,
      "info",
      `fonts.${declared[0]}`,
      `No font is marked default; fonts.${declared[0]} is used.`,
      "profile-font",
    )
  }

  const [typography, resolvedTypography] = group(context, "typography")
  const named: { level: string; family: string; fallback?: string }[] = []
  for (const level of Object.keys(typography)) {
    const value = (resolvedTypography[level] as Tree | undefined)?.fontFamily
    const family = namedFamily(value)
    if (family) named.push({ level, family, fallback: stackFallback(value) })
  }
  for (const { level, family, fallback } of named) {
    if (Object.values(result).some((font) => same(font.family, family)))
      continue
    let key = slug(family) || "font"
    while (result[key]) key = `${key}-font`
    const category = findFont(family, context.catalogue)?.category
    result[key] = {
      family,
      provider: "google",
      weights: {},
      fallback: fallback ?? categoryFallback(category),
      default: false,
      inferred: true,
    }
    report(
      context,
      "info",
      `fonts.${key}`,
      `fonts.${key} is inferred from typography.${level}.fontFamily ("${family}").`,
      "profile-font",
    )
    checkCatalogue(context, `fonts.${key}`, family, {})
  }
  if (declared.length === 0 && named.length > 0) {
    const counts = new Map<string, number>()
    for (const { family } of named)
      counts.set(
        family.toLowerCase(),
        (counts.get(family.toLowerCase()) ?? 0) + 1,
      )
    const body = named.find(({ level }) => level.startsWith("body"))
    const most = [...counts.entries()].reduce((best, entry) =>
      entry[1] > best[1] ? entry : best,
    )
    const family = body?.family ?? most[0]
    const key = Object.keys(result).find((name) =>
      same(result[name]!.family, family),
    )!
    result[key]!.default = true
    report(
      context,
      "info",
      `fonts.${key}`,
      `fonts.${key} is the default font: ${body ? `the family of typography.${body.level}` : "the family most levels use"}.`,
      "profile-font",
    )
  }
  return result
}

/** The `typography` group: each level resolved, levels without a family given the default font's. */
export function typography(
  context: Context,
  fontsByKey: Record<string, DesignFont>,
): Record<string, TypeLevel> {
  const [raw, resolved] = group(context, "typography")
  const result: Record<string, TypeLevel> = {}
  const keys = Object.keys(fontsByKey)
  const defaultKey = keys.find((key) => fontsByKey[key]!.default)
  for (const [level, value] of Object.entries(raw)) {
    const path = `typography.${level}`
    if (!isTree(value)) {
      report(
        context,
        "warning",
        path,
        `"${path}" is not a level: a level maps fontSize, fontWeight and the other properties. Fonts belong in the fonts group, rules in the prose.`,
      )
      continue
    }
    const target = resolved[level] as Tree
    const type: TypeLevel = {}
    for (const property of TYPE_PROPERTIES) {
      const text = target[property.yaml]
      if (
        text === undefined ||
        unresolved(text) ||
        property.key === "fontFamily"
      )
        continue
      if (property.key === "weight") {
        const weight = Number(text)
        if (!Number.isNaN(weight)) type.weight = weight
        continue
      }
      if (typeof text !== "string" && typeof text !== "number") {
        report(
          context,
          "warning",
          `${path}.${property.yaml}`,
          `"${path}.${property.yaml}" must be a value, not a group; it is ignored.`,
        )
        continue
      }
      type[property.key] = String(text)
    }
    const family = namedFamily(target.fontFamily)
    const familyPath = `${path}.fontFamily`
    const font = family
      ? keys.find((key) => same(fontsByKey[key]!.family, family))
      : value.fontFamily === undefined
        ? defaultKey
        : undefined
    if (font) {
      type.fontFamily = fontsByKey[font]!.family
      context.refs[familyPath] = `fonts.${font}.family`
    }
    result[level] = type
  }
  return result
}

/** Component properties as strings; a reference to a group stays as written. */
export function components(
  context: Context,
): Record<string, Record<string, string>> {
  const [raw, resolved] = group(context, "components")
  const result: Record<string, Record<string, string>> = {}
  for (const [name, properties] of Object.entries(raw)) {
    if (!isTree(properties)) continue
    const target = resolved[name] as Tree
    const entry: Record<string, string> = {}
    for (const [property, value] of Object.entries(properties)) {
      const text = target[property]
      if (isTree(text)) entry[property] = String(value)
      else if (Array.isArray(text))
        entry[property] = text.map(String).join(", ")
      else if (text !== null && text !== undefined)
        entry[property] = String(text)
    }
    result[name] = entry
  }
  return result
}

/** The check every `sizes` value passes: a dimension. */
export const sizeCheck = (name: string, value: string) =>
  isDimension(value)
    ? undefined
    : `"sizes.${name}" must be a dimension, such as 36px; it is ignored.`

/** The check every `motion` duration passes: a time. */
export const motionCheck = (name: string, value: string) =>
  name.startsWith("duration") && !DURATION.test(value)
    ? `"motion.${name}" must be a time, such as 120ms; it is ignored.`
    : undefined

/** The check `spacing.unit` passes: a dimension. */
export const spacingCheck = (name: string, value: string) =>
  name === "unit" && !isDimension(value)
    ? `"spacing.unit" must be a dimension, such as 4px; it is ignored.`
    : undefined
