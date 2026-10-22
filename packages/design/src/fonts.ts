/** A family of the Google Fonts catalogue (`@answerable/design/google-fonts.json`). */
export interface GoogleFont {
  family: string
  /** Sans Serif, Serif, Display, Handwriting or Monospace. */
  category: string
  /** The upright weights the family offers, ascending. */
  weights: number[]
  /** Whether the family has italics. */
  italic: boolean
  /** The variable axes, such as `{ tag: "wght", min: 100, max: 900 }`. */
  axes: { tag: string; min: number; max: number }[]
}

/** A family to load from Google Fonts. */
export interface FontRequest {
  family: string
  weights: number[]
  italic?: boolean
}

const CSS2 = "https://fonts.googleapis.com/css2"

function familyParam({ family, weights, italic }: FontRequest): string {
  const name = encodeURIComponent(family.trim()).replace(/%20/g, "+")
  const sorted = [...new Set(weights)]
    .filter((weight) => Number.isInteger(weight) && weight >= 1)
    .sort((a, b) => a - b)
  if (sorted.length === 0) return `family=${name}${italic ? ":ital@0;1" : ""}`
  if (!italic) return `family=${name}:wght@${sorted.join(";")}`
  const tuples = [0, 1].flatMap((style) =>
    sorted.map((weight) => `${style},${weight}`),
  )
  return `family=${name}:ital,wght@${tuples.join(";")}`
}

/**
 * The Google Fonts CSS2 URL that loads the families with their weights and `display=swap`,
 * such as `https://fonts.googleapis.com/css2?family=Public+Sans:wght@400;700;900&display=swap`.
 * Returns an empty string for no families.
 */
export function googleFontsHref(fonts: readonly FontRequest[]): string {
  if (fonts.length === 0) return ""
  return `${CSS2}?${fonts.map(familyParam).join("&")}&display=swap`
}

/** The bare family name: trimmed, without quotes. */
export function familyName(family: string): string {
  return family.trim().replace(/^(["'])(.*)\1$/, "$2")
}

/**
 * The catalogue entry for a family, matched case-insensitively. The catalogue is a separate import
 * (`@answerable/design/google-fonts.json`), so a client loads it only when it needs it.
 */
export function findFont(
  family: string,
  catalogue: readonly GoogleFont[],
): GoogleFont | undefined {
  const wanted = familyName(family).toLowerCase()
  return catalogue.find((font) => font.family.toLowerCase() === wanted)
}

/** The CSS `font-family` value for a family and its fallback: `"Public Sans", system-ui, sans-serif`. */
export function fontStack(font: { family: string; fallback: string }): string {
  const family = `"${familyName(font.family)}"`
  return font.fallback ? `${family}, ${font.fallback}` : family
}

/** The fallback stack for a catalogue category. */
export function categoryFallback(category: string | undefined): string {
  if (category === "Serif") return "Georgia, serif"
  if (category === "Monospace") return "ui-monospace, monospace"
  if (category === "Handwriting") return "cursive"
  return "system-ui, sans-serif"
}

/** The weight a font offers nearest to the one wanted; the heavier on a tie. */
export function nearestWeight(
  wanted: number,
  offered: readonly number[],
): number {
  let best = wanted
  let distance = Infinity
  for (const weight of offered) {
    const gap = Math.abs(weight - wanted)
    if (gap < distance || (gap === distance && weight > best)) {
      best = weight
      distance = gap
    }
  }
  return best
}
