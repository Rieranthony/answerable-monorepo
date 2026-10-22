// Turns Google's public font metadata (https://fonts.google.com/metadata/fonts) into the committed catalogue.
import type { GoogleFont } from "./fonts"

interface Family {
  family: string
  category: string
  popularity: number
  fonts: Record<string, unknown>
  axes?: { tag: string; min: number; max: number }[]
}

/** The catalogue from the metadata endpoint's response: one entry per family, by popularity then family. */
export function toGoogleFonts(response: string): GoogleFont[] {
  const { familyMetadataList } = JSON.parse(
    response.replace(/^\)\]\}'/, ""),
  ) as {
    familyMetadataList: Family[]
  }
  return familyMetadataList
    .toSorted(
      (a, b) => a.popularity - b.popularity || a.family.localeCompare(b.family),
    )
    .map((entry) => {
      const styles = Object.keys(entry.fonts)
      return {
        family: entry.family,
        category: entry.category,
        weights: [
          ...new Set(styles.map((style) => Number.parseInt(style, 10))),
        ].sort((a, b) => a - b),
        italic: styles.some((style) => style.endsWith("i")),
        axes: (entry.axes ?? []).map(({ tag, min, max }) => ({
          tag,
          min,
          max,
        })),
      }
    })
}

/** The catalogue as committed: one family per line, so a refresh reads as a diff of families. */
export function serializeGoogleFonts(fonts: readonly GoogleFont[]): string {
  return `[\n${fonts.map((font) => JSON.stringify(font)).join(",\n")}\n]\n`
}
