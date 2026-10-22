import { describe, expect, test } from "bun:test"
import {
  contrast,
  formatHex,
  formatOklch,
  luminance,
  mix,
  parseColor,
  wcagLevel,
} from "./color"

describe("parseColor", () => {
  test.each([
    ["#E9895E", "#e9895e"],
    ["#fff", "#ffffff"],
    ["rgba(0, 0, 0, 0.5)", "#00000080"],
    ["rgb(255 0 0)", "#ff0000"],
    ["hsl(20 70% 60%)", "#e08152"],
    ["hwb(20 30% 10%)", "#e67f4c"],
    ["lab(60 30 40)", "#cd7a4b"],
    ["lch(60 50 50)", "#d0794e"],
    ["oklab(0.7 0.1 0.1)", "#e57f4e"],
    ["oklch(0.7 0.12 45)", "#dc855d"],
    ["color(display-p3 1 0 0)", "#ff0000"],
    ["rebeccapurple", "#663399"],
    ["transparent", "#00000000"],
    ["  #000000  ", "#000000"],
  ])("reads %s", (input, hex) => {
    expect(parseColor(input)?.hex).toBe(hex)
  })

  test("returns the alpha and the oklch readout, hue 0 for greys", () => {
    expect(parseColor("rgba(0, 0, 0, 0.5)")).toEqual({
      hex: "#00000080",
      alpha: 0.5,
      oklch: { l: 0, c: 0, h: 0 },
    })
    const coral = parseColor("#E9895E")!
    expect(coral.alpha).toBe(1)
    expect(coral.oklch.l).toBeCloseTo(0.7238, 4)
    expect(coral.oklch.h).toBeCloseTo(44.33, 2)
  })

  test.each(["color-mix(in srgb, red 50%, blue)", "nonsense", "", "#ggg"])(
    "returns null for %p, never throwing",
    (input) => {
      expect(parseColor(input)).toBeNull()
    },
  )
})

describe("formatting", () => {
  test("formatHex lowercases and keeps alpha", () => {
    expect(formatHex("#E4E4E7")).toBe("#e4e4e7")
    expect(formatHex("hsl(0 0% 0% / 0.25)")).toBe("#00000040")
    expect(formatHex("color-mix(in srgb, red, blue)")).toBeNull()
  })

  test("formatOklch rounds and writes the alpha below 1", () => {
    expect(formatOklch("#E9895E")).toBe("oklch(0.7238 0.131 44.33)")
    expect(formatOklch("rgba(0, 0, 0, 0.5)")).toBe("oklch(0 0 0 / 0.5)")
    expect(formatOklch("nope")).toBeNull()
  })
})

describe("contrast", () => {
  test("is the WCAG ratio, null when a colour does not parse", () => {
    expect(contrast("#000000", "#E9895E")).toBeCloseTo(8.2, 2)
    expect(contrast("#ffffff", "#E9895E")).toBeCloseTo(2.56, 2)
    expect(contrast("#52525B", "#ffffff")).toBeCloseTo(7.73, 2)
    expect(contrast("nope", "#ffffff")).toBeNull()
    expect(contrast("#ffffff", "nope")).toBeNull()
  })

  test.each([
    [7, false, "AAA"],
    [4.5, false, "AA"],
    [4.49, false, "fail"],
    [4.5, true, "AAA"],
    [3, true, "AA"],
    [2.9, true, "fail"],
  ] as const)("wcagLevel(%p, large %p) is %p", (ratio, large, level) => {
    expect(wcagLevel(ratio, large)).toBe(level)
  })

  test("wcagLevel reads normal text by default", () => {
    expect(wcagLevel(5)).toBe("AA")
  })
})

describe("luminance and mix", () => {
  test("luminance is 0 for what does not parse", () => {
    expect(luminance("#ffffff")).toBe(1)
    expect(luminance("nope")).toBe(0)
  })

  test("mix is CSS color-mix in sRGB", () => {
    expect(mix("#000000", "#ffffff", 0.04)).toBe("#f5f5f5")
    expect(mix("#000000", "#ffffff", 0.6)).toBe("#666666")
    expect(mix("rgba(0, 0, 0, 0)", "#ffffff", 0.5)).toBe("#80808080")
    expect(mix("nope", "nope", 0.5)).toBe("#000000")
  })
})
