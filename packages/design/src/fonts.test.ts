import { describe, expect, test } from "bun:test"
import {
  categoryFallback,
  familyName,
  findFont,
  fontStack,
  googleFontsHref,
  nearestWeight,
  type GoogleFont,
} from "./fonts"

describe("googleFontsHref", () => {
  test("builds the CSS2 URL with sorted, unique weights and display=swap", () => {
    expect(
      googleFontsHref([
        { family: "Public Sans", weights: [900, 400, 700, 400] },
      ]),
    ).toBe(
      "https://fonts.googleapis.com/css2?family=Public+Sans:wght@400;700;900&display=swap",
    )
  })

  test("joins several families and encodes names", () => {
    expect(
      googleFontsHref([
        { family: "Space Grotesk", weights: [500] },
        { family: "M PLUS 1p", weights: [] },
        { family: "Noto Sans & Co", weights: [0, 1.5, 400] },
      ]),
    ).toBe(
      "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500&family=M+PLUS+1p&family=Noto+Sans+%26+Co:wght@400&display=swap",
    )
  })

  test("asks for italics with the ital axis", () => {
    expect(
      googleFontsHref([{ family: "Inter", weights: [700, 400], italic: true }]),
    ).toBe(
      "https://fonts.googleapis.com/css2?family=Inter:ital,wght@0,400;0,700;1,400;1,700&display=swap",
    )
    expect(
      googleFontsHref([{ family: "Inter", weights: [], italic: true }]),
    ).toBe(
      "https://fonts.googleapis.com/css2?family=Inter:ital@0;1&display=swap",
    )
  })

  test("is empty for no families", () => {
    expect(googleFontsHref([])).toBe("")
  })
})

const catalogue: GoogleFont[] = [
  {
    family: "Public Sans",
    category: "Sans Serif",
    weights: [400, 700],
    italic: true,
    axes: [],
  },
]

describe("families", () => {
  test("findFont matches case-insensitively, without quotes", () => {
    expect(findFont("public sans", catalogue)).toBe(catalogue[0])
    expect(findFont(` "Public Sans" `, catalogue)).toBe(catalogue[0])
    expect(findFont("Lobster", catalogue)).toBeUndefined()
  })

  test("familyName strips quotes and spaces", () => {
    expect(familyName(" 'Inter' ")).toBe("Inter")
    expect(familyName("Inter")).toBe("Inter")
  })

  test("fontStack quotes the family before the fallback", () => {
    expect(
      fontStack({ family: "Public Sans", fallback: "system-ui, sans-serif" }),
    ).toBe(`"Public Sans", system-ui, sans-serif`)
    expect(fontStack({ family: "Inter", fallback: "" })).toBe(`"Inter"`)
  })

  test.each([
    ["Serif", "Georgia, serif"],
    ["Monospace", "ui-monospace, monospace"],
    ["Handwriting", "cursive"],
    ["Display", "system-ui, sans-serif"],
    [undefined, "system-ui, sans-serif"],
  ])("categoryFallback(%p)", (category, fallback) => {
    expect(categoryFallback(category)).toBe(fallback)
  })

  test("nearestWeight takes the closest, the heavier on a tie, the wanted one with no offer", () => {
    expect(nearestWeight(900, [200, 400, 800])).toBe(800)
    expect(nearestWeight(500, [400, 600])).toBe(600)
    expect(nearestWeight(500, [600, 400])).toBe(600)
    expect(nearestWeight(700, [])).toBe(700)
  })
})
