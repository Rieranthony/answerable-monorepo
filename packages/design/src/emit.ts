import {
  GROUP_TOKENS,
  ROLES,
  TYPE_PROPERTIES,
  matchKey,
  roleGroup,
  type GroupTokenSpec,
  type RoleName,
} from "./contract"
import { familyName, fontStack } from "./fonts"
import type { Design, DesignFont, DesignToken, TypeLevel } from "./types"

/** A group token as a design reads it: the key it found, or the fallback that applies. */
export interface GroupTokenValue {
  spec: GroupTokenSpec
  /** The design path the value comes from, when the group has the key. */
  path?: string
  value: string
}

function groupKeys(design: Design, spec: GroupTokenSpec): string[] {
  return Object.keys(design[spec.source])
}

function groupValue(design: Design, spec: GroupTokenSpec, key: string): string {
  if (spec.source === "lines") return design.lines[key]![spec.field!]
  return design[spec.source][key]!
}

/** The value of every group token: read from the design's groups, or the profile's fallback. */
export function groupTokenValues(design: Design): GroupTokenValue[] {
  return GROUP_TOKENS.map((spec) => {
    const key = matchKey(spec.keys, groupKeys(design, spec))
    if (key !== undefined) {
      const field = spec.field ? `.${spec.field}` : ""
      return {
        spec,
        path: `${spec.source}.${key}${field}`,
        value: groupValue(design, spec, key),
      }
    }
    const value = spec.fallback.replace(
      /\{([a-z-]+)\}/g,
      (_, role: RoleName) => design.roles[role].value,
    )
    return { spec, value }
  })
}

/** The design's default font, if it has fonts. */
export function defaultFont(design: Design): DesignFont | undefined {
  const fonts = Object.values(design.fonts)
  return fonts.find((font) => font.default) ?? fonts[0]
}

const sameFamily = (a: string, b: string) =>
  familyName(a).toLowerCase() === familyName(b).toLowerCase()

/** The CSS stack for a level's family: its font's, or the family with a system fallback. */
function familyStack(design: Design, family: string): string {
  const font = Object.values(design.fonts).find((entry) =>
    sameFamily(entry.family, family),
  )
  return fontStack(font ?? { family, fallback: "system-ui, sans-serif" })
}

/** A CSS-safe token name for a level. */
export function levelName(level: string): string {
  return level.replace(/[^A-Za-z0-9_-]/g, "-")
}

function levelTokens(design: Design, level: string, type: TypeLevel) {
  const fallback = defaultFont(design)
  return TYPE_PROPERTIES.flatMap((property) => {
    const value = type[property.key]
    if (value === undefined) return []
    if (property.key === "fontFamily") {
      const family = String(value)
      if (fallback && sameFamily(family, fallback.family)) return []
      return [{ property, value: familyStack(design, family) }]
    }
    return [{ property, value: String(value) }]
  })
}

const token = (
  name: string,
  value: string,
  group: DesignToken["group"],
): DesignToken => ({ name, hook: `--design-${name}`, value, group })

/** The contract tokens of a design, in the order tokens.css declares them. */
export function designToTokens(design: Design): DesignToken[] {
  const roles = ROLES.map((role) =>
    token(role, design.roles[role].value, roleGroup(role)),
  )
  const types = Object.entries(design.typography).flatMap(([level, type]) =>
    levelTokens(design, level, type).map(({ property, value }) =>
      token(
        `type-${levelName(level)}-${property.suffix}`,
        value,
        "Type levels",
      ),
    ),
  )
  const fontsEnd = roles.findIndex((entry) => entry.group === "Shape")
  const groups = groupTokenValues(design).map(({ spec, value }) =>
    token(spec.name, value, spec.group),
  )
  return [
    ...roles.slice(0, fontsEnd),
    ...types,
    ...roles.slice(fontsEnd),
    ...groups,
  ]
}

const HEADER = `/*
 * Generated from the repository's DESIGN.md by \`bun run --filter @answerable/design generate\`. Do not edit by hand.
 *
 * Every token the components consume is declared here with our default, behind a hook the library never sets:
 * declare \`--design-<token>\` anywhere (an injected :root block, an inline style, a section) and it wins; \`unset\` restores the default.
 * \`[data-design-scope]\` lets a subtree re-declare the defaults, and \`[data-design-scope="default"]\` resets every hook inside it.
 */
`

function utilities(design: Design): string {
  return Object.entries(design.typography)
    .map(([level, type]) => {
      const name = levelName(level)
      const declarations = levelTokens(design, level, type).map(
        ({ property }) =>
          `  ${property.css}: var(--type-${name}-${property.suffix});\n`,
      )
      if (declarations.length === 0) return ""
      return `@utility type-${name} {\n${declarations.join("")}}\n`
    })
    .join("")
}

/**
 * The whole tokens.css for a design: every contract token with the design's value as the default behind
 * its hook, the block that resets the hooks inside `[data-design-scope="default"]`, and a `type-<level>`
 * Tailwind utility per typography level.
 */
export function serializeTokensCss(design: Design): string {
  const tokens = designToTokens(design)
  let group = ""
  const declarations = tokens
    .map((entry) => {
      const heading = entry.group === group ? "" : `  /* ${entry.group} */\n`
      group = entry.group
      return `${heading}  --${entry.name}: var(${entry.hook}, ${entry.value});\n`
    })
    .join("")
  const resets = tokens.map((entry) => `  ${entry.hook}: initial;\n`).join("")
  return (
    `${HEADER}:where(:root, [data-design-scope]) {\n${declarations}}\n\n` +
    `/* A scope that wears the defaults again, whatever the page injected above it. */\n` +
    `[data-design-scope="default"] {\n${resets}}\n\n${utilities(design)}`
  )
}

const NAME = /^[A-Za-z0-9_-]+$/
const UNSAFE = /[{};<>]/

/**
 * The block that overrides contract tokens: `--design-<name>: value;` for each entry, under `selector`.
 * Names that are not CSS identifiers and values that could close the block are left out. Empty when nothing is left.
 */
export function serializeHooks(
  overrides: Record<string, string>,
  selector = ":root",
): string {
  const declarations = Object.entries(overrides)
    .filter(
      ([name, value]) =>
        NAME.test(name) && !UNSAFE.test(value) && value.trim() !== "",
    )
    .map(([name, value]) => `  --design-${name}: ${value.trim()};\n`)
  return declarations.length === 0
    ? ""
    : `${selector} {\n${declarations.join("")}}\n`
}
