import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { designToTokens } from "./emit"
import { applyOverrides, readPath, tokenPath } from "./overrides"
import { parseDesign } from "./parse"

const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8")
const repository = parseDesign(read("../../../DESIGN.md"))
const paws = parseDesign(read("./fixtures/google/paws-and-paths.md"))
const bare = parseDesign("---\nname: A\n---\n")

const tokens = (design = repository) =>
  new Map(designToTokens(design).map((token) => [token.name, token.value]))

describe("tokenPath", () => {
  test.each([
    ["primary", "roles.primary"],
    ["font-sans", "roles.font-sans"],
    ["type-button-size", "typography.button.fontSize"],
    ["type-eyebrow-transform", "typography.eyebrow.textTransform"],
    ["control-md", "sizes.control-md"],
    ["elevation-xs", "elevation.xs"],
    ["line-separator-width", "lines.interface-separator.width"],
    ["line-statement-color", "lines.statement-standard.color"],
    ["focus-ring", "focus.ring"],
    ["ease", "motion.easing"],
  ])("%s is written to %s", (name, path) => {
    expect(tokenPath(repository, name)).toBe(path)
  })

  test("a design without the group takes the first accepted key", () => {
    expect(tokenPath(bare, "line-separator-color")).toBe(
      "lines.separator.color",
    )
    expect(tokenPath(bare, "ease")).toBe("motion.ease")
  })

  test("is undefined for what is not a token", () => {
    expect(tokenPath(repository, "type-nope-size")).toBeUndefined()
    expect(tokenPath(repository, "nope")).toBeUndefined()
  })
})

describe("readPath", () => {
  test.each([
    ["name", "Answerable"],
    ["version", "beta"],
    ["colors.accent-coral", "#e9895e"],
    ["colors.nope", undefined],
    ["roles.primary", "#000000"],
    ["roles.nope", undefined],
    ["fonts.sans", `"Public Sans", system-ui, sans-serif`],
    ["fonts.nope", undefined],
    ["fonts.sans.family", "Public Sans"],
    ["fonts.sans.fallback", "system-ui, sans-serif"],
    ["fonts.sans.default", undefined],
    ["fonts.sans.weights.body", "400"],
    ["fonts.sans.weights.nope", undefined],
    ["typography.button.fontSize", "14px"],
    ["typography.button.fontWeight", "700"],
    ["typography.button.textTransform", undefined],
    ["typography.button.nope", undefined],
    ["typography.nope.fontSize", undefined],
    ["typography.button", undefined],
    ["lines.interface-separator.color", "#e4e4e7"],
    ["lines.nope.width", undefined],
    ["components.button-default.height", "36px"],
    ["components.nope.height", undefined],
    ["sizes.control-md", "36px"],
    ["output-rules.logos", repository.outputRules.logos],
    ["spacing.unit", "4px"],
    ["nope.value", undefined],
  ])("%s reads %p", (path, value) => {
    expect(readPath(repository, path)).toBe(value as string | undefined)
  })
})

describe("applyOverrides", () => {
  test("returns a copy and leaves the design alone", () => {
    const next = applyOverrides(repository, { primary: "#ff0000" })
    expect(next).not.toBe(repository)
    expect(repository.roles.primary.value).toBe("#000000")
    expect(applyOverrides(repository, {})).toEqual(repository)
  })

  test("a colour edit moves every path that references it, keeping what the file wrote", () => {
    const next = applyOverrides(repository, {
      "colors.neutral-100": "oklch(0.9 0.02 250)",
    })
    expect(next.colors["neutral-100"]).toEqual({
      raw: "#d4dfeb",
      hex: "#d4dfeb",
    })
    expect(next.colors.muted).toEqual({
      raw: "{colors.neutral-100}",
      hex: "#d4dfeb",
    })
    expect(next.roles.muted).toEqual({ ref: "colors.muted", value: "#d4dfeb" })
    expect(next.roles.secondary.value).toBe("#d4dfeb")
    expect(next.components.input?.backgroundColor).toBe("#d4dfeb")
    const changed = designToTokens(next).filter(
      (token) => tokens().get(token.name) !== token.value,
    )
    expect(changed.map((token) => token.name)).toEqual([
      "secondary",
      "muted",
      "accent",
      "input",
      "sidebar-accent",
    ])
  })

  test("a role takes a literal or a reference, in the role's own form", () => {
    const next = applyOverrides(repository, {
      primary: "rgb(255 0 0)",
      accent: "{colors.accent-sky}",
      "font-sans": "Public Sans",
      "weight-body": "500",
      radius: "4px",
    })
    expect(next.roles.primary).toEqual({ value: "#ff0000" })
    expect(next.refs["roles.primary"]).toBeUndefined()
    expect(next.roles.accent).toEqual({
      ref: "colors.accent-sky",
      value: "#a8dce8",
    })
    expect(next.refs["roles.accent"]).toBe("colors.accent-sky")
    expect(next.roles["font-sans"]).toEqual({
      value: `"Public Sans", system-ui, sans-serif`,
    })
    expect(
      applyOverrides(repository, { "font-sans": "Lato" }).roles["font-sans"]
        .value,
    ).toBe(`"Lato", system-ui, sans-serif`)
    expect(next.roles["weight-body"]).toEqual({ value: "500" })
    expect(next.roles.radius).toEqual({ value: "4px" })
  })

  test("a font edit moves the levels that use it and the font role", () => {
    const next = applyOverrides(repository, {
      "fonts.sans.family": "'Inter'",
      "fonts.sans.fallback": "Arial, sans-serif",
      "fonts.sans.weights.label": "600",
    })
    expect(next.fonts.sans).toMatchObject({
      family: "Inter",
      fallback: "Arial, sans-serif",
    })
    expect(next.typography.button?.fontFamily).toBe("Inter")
    expect(next.roles["font-sans"].value).toBe(`"Inter", Arial, sans-serif`)
    expect(next.roles["weight-label"].value).toBe("600")
    expect(tokens(next).has("type-button-family")).toBe(false)
  })

  test("an inferred font becomes the file's once edited", () => {
    const next = applyOverrides(paws, {
      "fonts.plus-jakarta-sans.family": "Inter",
    })
    expect(next.fonts["plus-jakarta-sans"]?.inferred).toBeUndefined()
    expect(next.typography["body-md"]?.fontFamily).toBe("Inter")
  })

  test("type levels, groups, lines and metadata take their values", () => {
    const next = applyOverrides(repository, {
      "type-button-size": "15px",
      "typography.button.fontWeight": "900",
      "typography.button.fontFamily": "Roboto Mono, monospace",
      "typography.new.fontSize": "11px",
      "control-md": "40px",
      "line-separator-width": "2px",
      "lines.statement-standard.color": "red",
      "spacing.unit": "8px",
      name: "Other",
      description: "Text",
      version: "alpha",
    })
    expect(next.typography.button).toMatchObject({
      size: "15px",
      weight: 900,
      fontFamily: "Roboto Mono",
    })
    expect(next.typography.new).toEqual({ size: "11px" })
    expect(next.sizes["control-md"]).toBe("40px")
    expect(next.lines["interface-separator"]?.width).toBe("2px")
    expect(next.lines["statement-standard"]?.color).toBe("#ff0000")
    expect(next.roles["spacing-unit"].value).toBe("8px")
    expect(next).toMatchObject({
      name: "Other",
      description: "Text",
      version: "alpha",
    })
  })

  test("leaves out what the design cannot take, keeping the reference it had", () => {
    const overrides = {
      nope: "1",
      "colors.": "#ffffff",
      "colors.accent-coral": "nonsense",
      "roles.nope": "#ffffff",
      "roles.primary": "not a colour",
      "roles.accent": "{colors.none}",
      "fonts.nope.family": "Inter",
      "fonts.sans": "Inter",
      "fonts.sans.weights": "400",
      "fonts.sans.weights.body": "bold",
      "fonts.sans.default": "false",
      "typography.button": "14px",
      "typography.button.fontWeight": "bold",
      "typography.button.nope": "1",
      "lines.nope.width": "1px",
      "lines.interface-separator.style": "solid",
      "lines.interface-separator.color": "nonsense",
      "components.card.padding": "0",
      "sizes.": "1px",
      "nope.value": "1",
    }
    const next = applyOverrides(repository, overrides)
    expect(next).toEqual(repository)
  })
})
