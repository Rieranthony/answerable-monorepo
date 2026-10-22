import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import {
  defaultFont,
  designToTokens,
  groupTokenValues,
  levelName,
  serializeHooks,
  serializeTokensCss,
} from "./emit"
import { applyOverrides } from "./overrides"
import { parseDesign } from "./parse"

const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8")
const repository = parseDesign(read("../../../DESIGN.md"))

describe("tokens.css", () => {
  test("the committed file is the generator's output for the repository's DESIGN.md, byte for byte", () => {
    expect(serializeTokensCss(repository)).toBe(
      read("../../ui/src/styles/tokens.css"),
    )
  })

  test("declares the contract in order: colour roles, fonts, type levels, shape, spacing, groups", () => {
    const tokens = designToTokens(repository)
    expect(tokens).toHaveLength(176)
    expect(tokens[0]).toEqual({
      name: "background",
      hook: "--design-background",
      value: "#ffffff",
      group: "Colour roles",
    })
    expect([...new Set(tokens.map((token) => token.group))]).toEqual([
      "Colour roles",
      "Fonts and weights",
      "Type levels",
      "Shape",
      "Spacing",
      "Sizes",
      "Elevation",
      "Lines",
      "Focus",
      "Motion",
    ])
    expect(
      tokens.find((token) => token.name === "type-eyebrow-transform")?.value,
    ).toBe("uppercase")
    expect(
      tokens.find((token) => token.name === "type-numeric-numeric")?.value,
    ).toBe("tabular-nums")
  })

  test("a level whose family is not the default font's carries its own family", () => {
    const design = applyOverrides(repository, {
      "typography.badge.fontFamily": "Roboto Mono",
      "typography.label.fontFeature": '"ss01"',
      "typography.label.fontVariation": '"wdth" 90',
      "typography.a level.fontSize": "10px",
    })
    const tokens = new Map(
      designToTokens(design).map((token) => [token.name, token.value]),
    )
    expect(tokens.get("type-badge-family")).toBe(
      `"Roboto Mono", system-ui, sans-serif`,
    )
    expect(tokens.get("type-label-feature")).toBe('"ss01"')
    expect(tokens.get("type-a-level-size")).toBe("10px")
    const css = serializeTokensCss(design)
    expect(css).toContain(
      "@utility type-badge {\n  font-family: var(--type-badge-family);\n  font-size:",
    )
    expect(css).toContain(
      "  font-variation-settings: var(--type-label-variation);\n}",
    )
  })

  test("a design without fonts gives every family its own token", () => {
    const design = parseDesign("---\nname: A\n---\n")
    design.typography.body = { fontFamily: "Inter", size: "16px" }
    expect(defaultFont(design)).toBeUndefined()
    expect(
      designToTokens(design).find((token) => token.name === "type-body-family")
        ?.value,
    ).toBe(`"Inter", system-ui, sans-serif`)
  })
})

describe("helpers", () => {
  test("defaultFont takes the one marked default, else the first", () => {
    const design = parseDesign(
      "---\nname: A\nfonts:\n  a: { family: Inter }\n  b: { family: Roboto }\n---\n",
    )
    design.fonts.a!.default = false
    expect(defaultFont(design)?.family).toBe("Inter")
    design.fonts.b!.default = true
    expect(defaultFont(design)?.family).toBe("Roboto")
  })

  test("levelName keeps CSS identifiers", () => {
    expect(levelName("heading-h1")).toBe("heading-h1")
    expect(levelName("label.sm caps")).toBe("label-sm-caps")
  })

  test("groupTokenValues reads the file, or fills the fallback with the roles", () => {
    const values = groupTokenValues(repository)
    expect(
      values.find(({ spec }) => spec.name === "line-separator-color"),
    ).toMatchObject({
      path: "lines.interface-separator.color",
      value: "#e4e4e7",
    })
    expect(values.find(({ spec }) => spec.name === "ease")).toMatchObject({
      path: "motion.easing",
    })
    const bare = groupTokenValues(parseDesign("---\nname: A\n---\n"))
    const ring = bare.find(({ spec }) => spec.name === "focus-ring")
    expect(ring?.path).toBeUndefined()
    expect(ring?.value).toBe("0 0 0 2px #ffffff, 0 0 0 4px #000000")
  })
})

describe("serializeHooks", () => {
  test("declares each override under the selector", () => {
    expect(serializeHooks({ primary: "#ff0000", "control-md": " 40px " })).toBe(
      ":root {\n  --design-primary: #ff0000;\n  --design-control-md: 40px;\n}\n",
    )
    expect(
      serializeHooks({ primary: "#ff0000" }, '[data-design-scope="pane"]'),
    ).toBe('[data-design-scope="pane"] {\n  --design-primary: #ff0000;\n}\n')
  })

  test("leaves out names and values that could break the block, and is empty when nothing is left", () => {
    expect(
      serializeHooks({
        "bad name": "1px",
        primary: "red; } body { color: red",
        ring: "</style>",
        muted: "  ",
      }),
    ).toBe("")
  })
})
