import type { RoleName, TokenGroup } from "./contract"

/** A finding of a linter: the official one's shape, which the profile pass shares. */
export interface Finding {
  severity: "error" | "warning" | "info"
  /** The token path the finding is about, such as `colors.primary`. */
  path?: string
  message: string
  /** The rule that reported it; the profile's rules start with `profile-`. */
  rule?: string
}

/** A colour token: the value as written and its sRGB hex. */
export interface DesignColor {
  /** As written in the file: a CSS colour or a reference such as `{colors.neutral-100}`. */
  raw: string
  /** Lowercase hex, six digits, or eight when the colour has an alpha below 1. */
  hex: string
}

/** A typography level, with every reference resolved and dimensions kept as written. */
export interface TypeLevel {
  /** The family name; a level that names none inherits the default font's. */
  fontFamily?: string
  /** `fontSize`, such as `14px`. */
  size?: string
  /** `fontWeight`, as a number. */
  weight?: number
  /** `lineHeight`: a unitless multiplier or a dimension. */
  leading?: string
  /** `letterSpacing`. */
  tracking?: string
  /** `textTransform`, a profile property. */
  transform?: string
  /** `fontVariantNumeric`, a profile property. */
  numeric?: string
  /** `fontFeature`, for `font-feature-settings`. */
  feature?: string
  /** `fontVariation`, for `font-variation-settings`. */
  variation?: string
}

/** The weights a font gives its roles: body, label, statement, or any other role name. */
export interface FontWeights {
  body?: number
  label?: number
  statement?: number
  [role: string]: number | undefined
}

/** A font of the `fonts` group. */
export interface DesignFont {
  /** The family name as Google Fonts lists it. */
  family: string
  /** Where the family loads from; only Google Fonts is supported. */
  provider: "google"
  /** The weights the font gives its roles. */
  weights: FontWeights
  /** The CSS fallback stack after the family, such as `system-ui, sans-serif`. */
  fallback: string
  /** Whether typography levels without a family inherit this font. */
  default: boolean
  /** Set when the file has no such font and the parser inferred it from a typography level. */
  inferred?: true
}

/** A line of the `lines` group. */
export interface DesignLine {
  width: string
  /** Lowercase hex. */
  color: string
}

/** A role: the value the contract token takes, and the token path it was read from, if any. */
export interface DesignRole {
  /** The path the value comes from, such as `colors.foreground`. */
  ref?: string
  /** The CSS value: lowercase hex for a colour, a font stack, a weight or a dimension. */
  value: string
  /** Set when the file's `roles` group does not bind the role and the parser inferred it. */
  inferred?: true
}

/** A section of the prose, in document order. */
export interface DesignSection {
  /** The `##` heading; empty for the text before the first one. */
  heading: string
  /** The section's Markdown, heading included. */
  markdown: string
}

/** A design: what a DESIGN.md says, resolved, JSON-serialisable. */
export interface Design {
  name: string
  description: string
  version: string
  colors: Record<string, DesignColor>
  typography: Record<string, TypeLevel>
  fonts: Record<string, DesignFont>
  rounded: Record<string, string>
  /** The spacing scale; `unit` is the step the profile scales from. */
  spacing: Record<string, string>
  sizes: Record<string, string>
  /** Shadow strings by level. */
  elevation: Record<string, string>
  lines: Record<string, DesignLine>
  focus: Record<string, string>
  /** Durations and the easing curve. */
  motion: Record<string, string>
  /** The `output-rules` group: rules for agents producing documents with the design. */
  outputRules: Record<string, string>
  /** Prose kept beside the tokens of a group: the `rule` and `usage` keys of `elevation`, `lines` and `focus`. */
  notes: Record<string, Record<string, string>>
  /** Every role of the contract, read from the file or inferred. */
  roles: Record<RoleName, DesignRole>
  /** Component properties, with references to values resolved; references to groups stay as written. */
  components: Record<string, Record<string, string>>
  /** Every path that takes its value from another, such as `colors.muted` → `colors.neutral-100`. */
  refs: Record<string, string>
  sections: DesignSection[]
  findings: { official: Finding[]; profile: Finding[] }
  /** The Markdown the design was parsed from. */
  source: string
}

/** A contract token: its name, the hook that overrides it, its value and the group it is declared under. */
export interface DesignToken {
  /** The variable the components read, without the leading dashes: `primary`. */
  name: string
  /** The variable that overrides it: `--design-primary`. */
  hook: string
  value: string
  group: TokenGroup
}
