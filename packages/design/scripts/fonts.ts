// Refreshes src/google-fonts.json from Google's public metadata endpoint. Run by hand: bun run fonts.
import { writeFileSync } from "node:fs"
import {
  serializeGoogleFonts,
  toGoogleFonts,
} from "../src/google-fonts-metadata"

const response = await fetch("https://fonts.google.com/metadata/fonts")
if (!response.ok)
  throw new Error(`Google Fonts metadata: HTTP ${response.status}`)
const fonts = toGoogleFonts(await response.text())
writeFileSync(
  new URL("../src/google-fonts.json", import.meta.url),
  serializeGoogleFonts(fonts),
)
console.log(`Wrote ${fonts.length} families to src/google-fonts.json`)
