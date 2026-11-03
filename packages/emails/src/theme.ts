// The email palette and type. The values are the root DESIGN.md's tokens, written out because an email carries inline
// styles only (theme.test.ts fails when one drifts from the file). Light only: the system's default background is white.

/** Colours, by the DESIGN.md token each one is. */
export const colour = {
  /** `colors.background`: the page. */
  background: "#FFFFFF",
  /** `colors.foreground`: text, and the button's fill. */
  foreground: "#000000",
  /** `colors.on-dark`: text on the button. */
  onDark: "#FFFFFF",
  /** `colors.muted` (neutral-100): the box that holds the plain link and the code. */
  surface: "#F4F4F5",
  /** `colors.separator` (neutral-200): the rule above the closing line. */
  separator: "#E4E4E7",
  /** `colors.muted-foreground` (neutral-600): secondary text, about 7:1 on white. */
  mutedForeground: "#52525B",
} as const

/**
 * DESIGN.md names Public Sans, with `system-ui, sans-serif` as the fallback. An email may load no font, so the name only
 * applies where the reader has it installed; Segoe UI, Helvetica and Arial cover Outlook, which ignores `system-ui`.
 * Single quotes: a double quote becomes `&quot;` inside a style attribute, which some clients mis-parse.
 */
export const fontFamily =
  "'Public Sans', 'Segoe UI', system-ui, -apple-system, Helvetica, Arial, sans-serif"

/** Bold, for the heading, the button and the code (`heading-h2`, `button`). Everything else is Regular, the default. */
export const weight = { label: 700 } as const
