import {
  converter,
  formatHex as culoriHex,
  formatHex8,
  modeHsl,
  modeHwb,
  modeLab,
  modeLch,
  modeLrgb,
  modeOklab,
  modeOklch,
  modeP3,
  modeRgb,
  modeXyz50,
  modeXyz65,
  parse,
  useMode as registerMode,
  wcagContrast,
  wcagLuminance,
  type Color,
} from "culori/fn"

// culori's tree-shakeable build parses and converts only the modes it is given.
registerMode(modeRgb)
registerMode(modeLrgb)
registerMode(modeHsl)
registerMode(modeHwb)
registerMode(modeLab)
registerMode(modeLch)
registerMode(modeOklab)
registerMode(modeOklch)
registerMode(modeXyz50)
registerMode(modeXyz65)
registerMode(modeP3)

const toRgb = converter("rgb")
const toOklch = converter("oklch")

/** A colour read from any CSS notation culori understands. */
export interface ParsedColor {
  /** Lowercase hex: six digits, or eight when alpha is below 1. Out-of-gamut colours are clamped. */
  hex: string
  /** From 0 to 1. */
  alpha: number
  /** The colour in oklch: lightness 0 to 1, chroma, hue in degrees (0 for greys). */
  oklch: { l: number; c: number; h: number }
}

function read(input: string): Color | undefined {
  return parse(input.trim())
}

function hexOf(color: Color): string {
  const alpha = color.alpha ?? 1
  return alpha < 1 ? formatHex8(color) : culoriHex(color)
}

/**
 * Reads a CSS colour: hex, `rgb()`, `hsl()`, `hwb()`, `lab()`, `lch()`, `oklab()`, `oklch()`,
 * `color(display-p3 …)`, a named colour or `transparent`. Returns null for anything else,
 * `color-mix()` included; it never throws.
 */
export function parseColor(input: string): ParsedColor | null {
  const color = read(input)
  if (!color) return null
  const { l, c, h } = toOklch(color)
  return {
    hex: hexOf(color),
    alpha: color.alpha ?? 1,
    oklch: { l, c, h: h ?? 0 },
  }
}

/** The colour as lowercase hex (eight digits when it has an alpha below 1), or null when it does not parse. */
export function formatHex(input: string): string | null {
  return parseColor(input)?.hex ?? null
}

const round = (value: number, digits: number) => Number(value.toFixed(digits))

/** The colour as `oklch(l c h)` (with `/ alpha` below 1), rounded for display, or null when it does not parse. */
export function formatOklch(input: string): string | null {
  const parsed = parseColor(input)
  if (!parsed) return null
  const { l, c, h } = parsed.oklch
  const alpha = parsed.alpha < 1 ? ` / ${round(parsed.alpha, 3)}` : ""
  return `oklch(${round(l, 4)} ${round(c, 4)} ${round(h, 2)}${alpha})`
}

/** The WCAG 2 contrast ratio between two colours (1 to 21), or null when either does not parse. Alpha is ignored. */
export function contrast(a: string, b: string): number | null {
  const first = read(a)
  const second = read(b)
  if (!first || !second) return null
  return wcagContrast(first, second)
}

/** The WCAG 2 level a contrast ratio reaches for normal text, or for large text (18pt, or 14pt bold). */
export function wcagLevel(ratio: number, large = false): "AAA" | "AA" | "fail" {
  if (ratio >= (large ? 4.5 : 7)) return "AAA"
  if (ratio >= (large ? 3 : 4.5)) return "AA"
  return "fail"
}

/** The WCAG relative luminance of a colour that parses (0 for one that does not). */
export function luminance(input: string): number {
  const color = read(input)
  return color ? wcagLuminance(color) : 0
}

/** `amount` of `a` mixed into `b` in sRGB, as CSS `color-mix(in srgb, a amount, b)` does; lowercase hex. */
export function mix(a: string, b: string, amount: number): string {
  const black: Color = { mode: "rgb", r: 0, g: 0, b: 0 }
  const from = toRgb(read(a) ?? black)
  const to = toRgb(read(b) ?? black)
  const channel = (x: number, y: number) => x * amount + y * (1 - amount)
  return hexOf({
    mode: "rgb",
    r: channel(from.r, to.r),
    g: channel(from.g, to.g),
    b: channel(from.b, to.b),
    alpha: channel(from.alpha ?? 1, to.alpha ?? 1),
  })
}
