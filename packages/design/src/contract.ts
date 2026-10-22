// The token contract: the variables `@answerable/ui` consumes, in the order tokens.css declares them.
// Roles bind a design's own names to the library's slots; group tokens read the profile groups.

/** The colour roles of the contract, in the order tokens.css declares them. */
export const COLOUR_ROLES = [
  "background",
  "foreground",
  "card",
  "card-foreground",
  "popover",
  "popover-foreground",
  "primary",
  "primary-foreground",
  "secondary",
  "secondary-foreground",
  "muted",
  "muted-foreground",
  "accent",
  "accent-foreground",
  "destructive",
  "destructive-foreground",
  "border",
  "input",
  "ring",
  "sidebar",
  "sidebar-foreground",
  "sidebar-primary",
  "sidebar-primary-foreground",
  "sidebar-accent",
  "sidebar-accent-foreground",
  "sidebar-border",
  "sidebar-ring",
  "overlay",
  "surface-dark",
  "on-dark",
  "on-accent",
  "success",
  "warning",
  "info",
  "highlight-1",
  "highlight-2",
  "highlight-3",
  "highlight-4",
  "chart-1",
  "chart-2",
  "chart-3",
  "chart-4",
  "chart-5",
] as const

/** The font and weight roles of the contract. */
export const FONT_ROLES = [
  "font-sans",
  "weight-body",
  "weight-label",
  "weight-statement",
] as const

/** Every role of the contract: colours, the font and its weights, the radius pair and the spacing unit. */
export const ROLES = [
  ...COLOUR_ROLES,
  ...FONT_ROLES,
  "radius",
  "radius-full",
  "spacing-unit",
] as const

/** A role of the contract. */
export type RoleName = (typeof ROLES)[number]

/** The comment heading each group of tokens in tokens.css. */
export type TokenGroup =
  | "Colour roles"
  | "Fonts and weights"
  | "Type levels"
  | "Shape"
  | "Spacing"
  | "Sizes"
  | "Elevation"
  | "Lines"
  | "Focus"
  | "Motion"

const colourRoles: ReadonlySet<string> = new Set(COLOUR_ROLES)
const roles: ReadonlySet<string> = new Set(ROLES)

/** Whether a name is a role of the contract. */
export function isRole(name: string): name is RoleName {
  return roles.has(name)
}

/** Whether a role holds a colour. */
export function isColourRole(name: string): boolean {
  return colourRoles.has(name)
}

/** The group each role is declared under. */
export function roleGroup(role: RoleName): TokenGroup {
  if (isColourRole(role)) return "Colour roles"
  if (role === "radius" || role === "radius-full") return "Shape"
  if (role === "spacing-unit") return "Spacing"
  return "Fonts and weights"
}

/** A type level property: the token suffix, the YAML key, the model key and the CSS property. */
export interface TypeProperty {
  suffix: string
  yaml: string
  key:
    | "fontFamily"
    | "size"
    | "weight"
    | "leading"
    | "tracking"
    | "transform"
    | "numeric"
    | "feature"
    | "variation"
  css: string
}

/** The type level properties, in the order tokens.css declares them. */
export const TYPE_PROPERTIES: readonly TypeProperty[] = [
  {
    suffix: "family",
    yaml: "fontFamily",
    key: "fontFamily",
    css: "font-family",
  },
  { suffix: "size", yaml: "fontSize", key: "size", css: "font-size" },
  { suffix: "weight", yaml: "fontWeight", key: "weight", css: "font-weight" },
  { suffix: "leading", yaml: "lineHeight", key: "leading", css: "line-height" },
  {
    suffix: "tracking",
    yaml: "letterSpacing",
    key: "tracking",
    css: "letter-spacing",
  },
  {
    suffix: "transform",
    yaml: "textTransform",
    key: "transform",
    css: "text-transform",
  },
  {
    suffix: "numeric",
    yaml: "fontVariantNumeric",
    key: "numeric",
    css: "font-variant-numeric",
  },
  {
    suffix: "feature",
    yaml: "fontFeature",
    key: "feature",
    css: "font-feature-settings",
  },
  {
    suffix: "variation",
    yaml: "fontVariation",
    key: "variation",
    css: "font-variation-settings",
  },
]

/** A token read from a profile group: where it is read from and what applies when the file has none. */
export interface GroupTokenSpec {
  name: string
  group: TokenGroup
  /** The group it reads, and the keys it accepts there, first match wins. */
  source: "sizes" | "elevation" | "lines" | "focus" | "motion"
  keys: readonly string[]
  /** For lines: the field of the line. */
  field?: "width" | "color"
  /** The value when the file has none; `{role}` reads a resolved role. */
  fallback: string
}

const line = (
  name: string,
  keys: readonly string[],
  field: "width" | "color",
  fallback: string,
): GroupTokenSpec => ({
  name,
  group: "Lines",
  source: "lines",
  keys,
  field,
  fallback,
})

const separator = ["separator", "*-separator"]
const statement = ["statement", "statement-standard"]

/** The tokens read from the profile groups, in the order tokens.css declares them. */
export const GROUP_TOKENS: readonly GroupTokenSpec[] = [
  ...(
    [
      ["control-sm", "32px"],
      ["control-md", "36px"],
      ["control-lg", "40px"],
      ["control-xl", "48px"],
      ["nav-height", "56px"],
      ["sidebar-width", "256px"],
      ["content-max", "1200px"],
      ["prose-max", "680px"],
    ] as const
  ).map(([name, fallback]): GroupTokenSpec => ({
    name,
    group: "Sizes",
    source: "sizes",
    keys: [name],
    fallback,
  })),
  ...(
    [
      ["none", "none"],
      ["xs", "0 1px 2px 0 rgb(0 0 0 / 0.05)"],
      ["sm", "0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)"],
      [
        "md",
        "0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)",
      ],
      [
        "lg",
        "0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)",
      ],
    ] as const
  ).map(([key, fallback]): GroupTokenSpec => ({
    name: `elevation-${key}`,
    group: "Elevation",
    source: "elevation",
    keys: [key],
    fallback,
  })),
  line("line-separator-width", separator, "width", "1px"),
  line("line-separator-color", separator, "color", "{border}"),
  line("line-statement-width", statement, "width", "2px"),
  line("line-statement-emphasis-width", ["statement-emphasis"], "width", "3px"),
  line("line-statement-heavy-width", ["statement-heavy"], "width", "4px"),
  line("line-statement-color", statement, "color", "{foreground}"),
  {
    name: "focus-ring",
    group: "Focus",
    source: "focus",
    keys: ["ring"],
    fallback: "0 0 0 2px {background}, 0 0 0 4px {ring}",
  },
  ...(
    [
      ["duration-fast", "150ms"],
      ["duration-base", "200ms"],
      ["duration-slow", "300ms"],
    ] as const
  ).map(([name, fallback]): GroupTokenSpec => ({
    name,
    group: "Motion",
    source: "motion",
    keys: [name],
    fallback,
  })),
  {
    name: "ease",
    group: "Motion",
    source: "motion",
    keys: ["ease", "easing"],
    fallback: "cubic-bezier(0.4, 0, 0.2, 1)",
  },
]

/** The first key of a group that matches a token's accepted keys; `*-x` matches any key ending in `-x`. */
export function matchKey(
  keys: readonly string[],
  present: readonly string[],
): string | undefined {
  for (const key of keys) {
    if (key.startsWith("*")) {
      const found = present.find((name) => name.endsWith(key.slice(1)))
      if (found !== undefined) return found
    } else if (present.includes(key)) return key
  }
  return undefined
}
