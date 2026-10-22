import { describe, expect, test } from "bun:test"
import catalogue from "./google-fonts.json"
import { serializeGoogleFonts, toGoogleFonts } from "./google-fonts-metadata"

const metadata = {
  familyMetadataList: [
    {
      family: "Lobster",
      category: "Display",
      popularity: 149,
      fonts: { "400": {} },
    },
    {
      family: "Public Sans",
      category: "Sans Serif",
      popularity: 82,
      fonts: { "700": {}, "400": {}, "400i": {} },
      axes: [{ tag: "wght", min: 100, max: 900, defaultValue: 400 }],
    },
    {
      family: "Abel",
      category: "Sans Serif",
      popularity: 149,
      fonts: { "400": {} },
    },
  ],
}

describe("toGoogleFonts", () => {
  test("reads the response, with or without the )]}' prefix, by popularity then family", () => {
    const expected = [
      {
        family: "Public Sans",
        category: "Sans Serif",
        weights: [400, 700],
        italic: true,
        axes: [{ tag: "wght", min: 100, max: 900 }],
      },
      {
        family: "Abel",
        category: "Sans Serif",
        weights: [400],
        italic: false,
        axes: [],
      },
      {
        family: "Lobster",
        category: "Display",
        weights: [400],
        italic: false,
        axes: [],
      },
    ]
    expect(toGoogleFonts(JSON.stringify(metadata))).toEqual(expected)
    expect(toGoogleFonts(`)]}'${JSON.stringify(metadata)}`)).toEqual(expected)
  })

  test("serialises one family per line", () => {
    const fonts = toGoogleFonts(JSON.stringify(metadata))
    const text = serializeGoogleFonts(fonts)
    expect(text.split("\n")).toHaveLength(fonts.length + 3)
    expect(JSON.parse(text)).toEqual(fonts)
  })
})

describe("the committed catalogue", () => {
  test("lists Google's families with their weights", () => {
    expect(catalogue.length).toBeGreaterThan(1900)
    expect(
      catalogue.find((font) => font.family === "Public Sans"),
    ).toMatchObject({
      category: "Sans Serif",
      weights: [100, 200, 300, 400, 500, 600, 700, 800, 900],
      italic: true,
    })
  })
})
