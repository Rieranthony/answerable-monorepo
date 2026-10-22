// Pure helpers the showcase and the pane share: colour groups, contrast pairs, accents and weight names.
import { contrast, wcagLevel, type Design } from "@answerable/design"

/** The id a section of the showcase takes from its heading: `Lines, separators and focus` → `lines-separators-and-focus`. */
export const sectionId = (heading: string) =>
  heading
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")

/** An accent in rotation order: 1 is Sky, 2 Yellow, 3 Green, 4 Coral in this design. */
export type Accent = 1 | 2 | 3 | 4

/** The accent of the nth section that has one: the rotation, never two in a row. */
export const accentAt = (index: number) => ((index % 4) + 1) as Accent

/** Static class names, so Tailwind sees every one. */
export const ACCENT_FILL: Record<Accent, string> = {
  1: "bg-highlight-1",
  2: "bg-highlight-2",
  3: "bg-highlight-3",
  4: "bg-highlight-4",
}

/** The colour role each role's text or fill is read against. */
const PARTNERS: Record<string, string> = {
  background: "foreground",
  foreground: "background",
  "muted-foreground": "background",
  border: "background",
  ring: "background",
  overlay: "background",
  input: "foreground",
  "surface-dark": "on-dark",
  "on-dark": "surface-dark",
  "on-accent": "highlight-1",
  success: "on-accent",
  warning: "on-accent",
  info: "on-accent",
  "highlight-1": "on-accent",
  "highlight-2": "on-accent",
  "highlight-3": "on-accent",
  "highlight-4": "on-accent",
}

/** The role a colour role is set against: a fill's foreground, a foreground's fill, the page otherwise. */
export function partnerOf(role: string): string {
  if (PARTNERS[role]) return PARTNERS[role]
  if (role.endsWith("-foreground")) return role.slice(0, -"-foreground".length)
  if (role.startsWith("chart-")) return "background"
  return `${role}-foreground`
}

/** The text-on-fill pairs a reader meets, as [text role, fill role]. */
export const TEXT_PAIRS: readonly (readonly [string, string])[] = [
  ["foreground", "background"],
  ["muted-foreground", "background"],
  ["muted-foreground", "muted"],
  ["card-foreground", "card"],
  ["popover-foreground", "popover"],
  ["primary-foreground", "primary"],
  ["secondary-foreground", "secondary"],
  ["accent-foreground", "accent"],
  ["foreground", "input"],
  ["destructive-foreground", "destructive"],
  ["sidebar-foreground", "sidebar"],
  ["sidebar-primary-foreground", "sidebar-primary"],
  ["sidebar-accent-foreground", "sidebar-accent"],
  ["on-dark", "surface-dark"],
  ["on-accent", "highlight-1"],
  ["on-accent", "highlight-2"],
  ["on-accent", "highlight-3"],
  ["on-accent", "highlight-4"],
]

/** The contrast of two colours with its WCAG level for normal text, or null when either does not parse. */
export function verdict(text: string, fill: string) {
  const ratio = contrast(text, fill)
  if (ratio === null) return null
  return { ratio, level: wcagLevel(ratio), large: wcagLevel(ratio, true) }
}

export const formatRatio = (ratio: number) => `${ratio.toFixed(2)}:1`

export type ColourGroup = { title: string; names: string[] }

const NEUTRAL = /^(neutral|gray|grey|slate|zinc|stone)(-|$)/

/**
 * The file's colours in four groups: accents (in rotation order when the highlight roles name them),
 * the neutral scale, the core colours written as values, and the semantic colours that reference another.
 */
export function colourGroups(design: Design): ColourGroup[] {
  const names = Object.keys(design.colors)
  const rotation = ([1, 2, 3, 4] as const)
    .map((n) => design.roles[`highlight-${n}`].ref?.replace(/^colors\./, ""))
    .filter((name): name is string => !!name && name in design.colors)
  const accents = [
    ...new Set([...rotation, ...names.filter((n) => n.startsWith("accent"))]),
  ]
  const neutrals = names.filter((n) => NEUTRAL.test(n))
  const rest = names.filter(
    (n) => !accents.includes(n) && !neutrals.includes(n),
  )
  const referencing = (n: string) => `colors.${n}` in design.refs
  return [
    { title: "Core", names: rest.filter((n) => !referencing(n)) },
    { title: "Neutral", names: neutrals },
    { title: "Accent", names: accents },
    { title: "Semantic", names: rest.filter(referencing) },
  ].filter((group) => group.names.length > 0)
}

const WEIGHT_NAMES: Record<number, string> = {
  100: "Thin",
  200: "Extra Light",
  300: "Light",
  400: "Regular",
  500: "Medium",
  600: "Semibold",
  700: "Bold",
  800: "Extra Bold",
  900: "Black",
}

/** `Regular 400`, `Black 900`; a weight between the named ones keeps its number only. */
export const weightName = (weight: number | string) => {
  const name = WEIGHT_NAMES[Number(weight)]
  return name ? `${name} ${weight}` : String(weight)
}

/** The design path a role is written to: the path it references, so edits land where the file says them. */
export function rolePath(design: Design, role: keyof Design["roles"]): string {
  return design.roles[role].ref ?? role
}
