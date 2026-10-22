import { describe, expect, test } from "bun:test"
import { designToTokens } from "./emit"
import { parseDesign } from "./parse"
import type { Design, Finding } from "./types"

const parse = (yaml: string, prose = "\n## Overview\n\nText.\n") =>
  parseDesign(`---\n${yaml}\n---\n${prose}`)

const finding = (
  design: Design,
  path: string,
  severity?: Finding["severity"],
) =>
  design.findings.profile.find(
    (entry) =>
      entry.path === path &&
      (severity === undefined || entry.severity === severity),
  )

const tokens = (design: Design) =>
  new Map(designToTokens(design).map((token) => [token.name, token.value]))

describe("reading the tokens", () => {
  test("a file without YAML is an error", () => {
    const design = parseDesign("# Nothing\n\n## Overview\n")
    expect(design.findings.profile[0]).toMatchObject({
      severity: "error",
      rule: "profile-yaml",
    })
    expect(design.sections.map((section) => section.heading)).toEqual([
      "",
      "Overview",
    ])
  })

  test("YAML that does not parse is an error per problem", () => {
    const design = parseDesign("---\na:{ b: 1 }\nc: [\n---\n")
    expect(
      design.findings.profile.filter((entry) => entry.rule === "profile-yaml")
        .length,
    ).toBeGreaterThan(0)
    expect(design.findings.profile[0]?.message).toStartWith(
      "The YAML does not parse:",
    )
  })

  test("a key defined in two blocks is an error; a block that is not a mapping is skipped", () => {
    const design = parseDesign(
      "---\nname: A\ncolors:\n  primary: '#000000'\n---\n\n## Colors\n\n```yaml\ncolors:\n  primary: '#ffffff'\n```\n\n```yaml\n- a\n```\n",
    )
    expect(finding(design, "colors", "error")).toMatchObject({
      rule: "profile-yaml",
    })
    expect(design.colors.primary?.hex).toBe("#000000")
  })

  test("a file without a name is reported, and only front matter makes no preamble section", () => {
    const design = parseDesign(
      "---\ncolors:\n  primary: '#123456'\n---\n## Overview\n",
    )
    expect(finding(design, "name", "warning")).toBeDefined()
    expect(design.name).toBe("")
    expect(design.sections.map((section) => section.heading)).toEqual([
      "Overview",
    ])
    expect(design.notes).toEqual({})
  })
})

describe("the profile groups", () => {
  test("a group that is not a mapping is ignored", () => {
    const design = parse("name: A\nsizes: 5\nfonts: [a]")
    expect(finding(design, "sizes", "warning")).toBeDefined()
    expect(finding(design, "fonts", "warning")).toBeDefined()
    expect(design.sizes).toEqual({})
  })

  test("string groups keep prose aside and report wrong shapes", () => {
    const design = parse(
      [
        "name: A",
        "sizes:",
        "  control-md: 40px",
        "  bad: tall",
        "  nested: { a: 1 }",
        "  ref: '{nope.value}'",
        "elevation:",
        "  xs: 0 1px 2px black",
        "  rule: Blur always.",
        "focus:",
        "  ring: 0 0 0 2px red",
        "  usage: On focus.",
        "motion:",
        "  duration-fast: 100ms",
        "  duration-slow: slow",
        "  duration-base: 0.2s",
        "  easing: linear",
        "spacing:",
        "  unit: wide",
        "  '0.5': 2px",
        "  gap: 3",
        "output-rules:",
        "  logos: Never.",
      ].join("\n"),
    )
    expect(design.sizes).toEqual({ "control-md": "40px" })
    expect(finding(design, "sizes.bad", "warning")).toBeDefined()
    expect(finding(design, "sizes.nested", "warning")).toBeDefined()
    expect(finding(design, "sizes.ref", "error")).toMatchObject({
      rule: "profile-reference",
    })
    expect(design.elevation).toEqual({ xs: "0 1px 2px black" })
    expect(design.notes).toEqual({
      elevation: { rule: "Blur always." },
      focus: { usage: "On focus." },
    })
    expect(design.motion).toEqual({
      "duration-fast": "100ms",
      "duration-base": "0.2s",
      easing: "linear",
    })
    expect(finding(design, "motion.duration-slow", "warning")).toBeDefined()
    expect(design.spacing).toEqual({ "0.5": "2px", gap: "3" })
    expect(finding(design, "spacing.unit", "warning")).toBeDefined()
    expect(finding(design, "spacing.0.5", "warning")?.message).toContain("dot")
    expect(design.outputRules).toEqual({ logos: "Never." })
    const values = tokens(design)
    expect(values.get("ease")).toBe("linear")
    expect(values.get("control-md")).toBe("40px")
    expect(values.get("control-sm")).toBe("32px")
    expect(finding(design, "sizes.control-sm", "info")).toMatchObject({
      rule: "profile-default",
    })
    expect(values.get("focus-ring")).toBe("0 0 0 2px red")
  })

  test("lines are width and colour, with prose kept aside", () => {
    const design = parse(
      [
        "name: A",
        "colors:",
        "  rule: '#111111'",
        "lines:",
        "  separator: { width: 2px, color: '{colors.rule}' }",
        "  statement: { width: 5px, color: red }",
        "  flat: 1px",
        "  thin: { width: hair, color: red }",
        "  odd: { width: 1px, color: nope }",
        "  usage: Between rows.",
      ].join("\n"),
    )
    expect(design.lines).toEqual({
      separator: { width: "2px", color: "#111111" },
      statement: { width: "5px", color: "#ff0000" },
    })
    expect(design.notes.lines).toEqual({ usage: "Between rows." })
    for (const path of ["lines.flat", "lines.thin", "lines.odd"]) {
      expect(finding(design, path, "warning")).toBeDefined()
    }
    const values = tokens(design)
    expect(values.get("line-separator-width")).toBe("2px")
    expect(values.get("line-statement-color")).toBe("#ff0000")
    expect(values.get("line-statement-emphasis-width")).toBe("3px")
  })

  test("colours: nested groups, references to groups, notations only the official linter reads", () => {
    const design = parse(
      [
        "name: A",
        "colors:",
        "  brand:",
        "    blue: '#0000ff'",
        "  count: 5",
        "  group: '{colors.brand}'",
        "  mixed: 'color-mix(in srgb, #ff0000 50%, #0000ff)'",
        "  wrong: nonsense",
        "  missing: '{colors.none}'",
      ].join("\n"),
    )
    expect(design.colors["brand.blue"]).toEqual({
      raw: "#0000ff",
      hex: "#0000ff",
    })
    expect(design.colors.count).toBeUndefined()
    expect(finding(design, "colors.group", "error")).toBeDefined()
    expect(design.colors.mixed?.hex).toMatch(/^#[0-9a-f]{6}$/)
    expect(finding(design, "colors.mixed", "info")).toMatchObject({
      rule: "profile-color",
    })
    expect(design.colors.wrong).toBeUndefined()
    expect(design.colors.missing).toBeUndefined()
  })

  test("components keep references to groups as written and join lists", () => {
    const design = parse(
      [
        "name: A",
        "typography:",
        "  body: { fontSize: 16px }",
        "components:",
        "  card:",
        "    typography: '{typography.body}'",
        "    variants: [a, b]",
        "    empty: null",
        "    size: 4",
        "  broken: 5",
      ].join("\n"),
    )
    expect(design.components).toEqual({
      card: { typography: "{typography.body}", variants: "a, b", size: "4" },
    })
  })

  test("the official broken references the profile cannot resolve stay official", () => {
    const design = parse(
      [
        "name: A",
        "sizes:",
        "  bad: '{nope}'",
        "components:",
        "  a:",
        "    height: '{sizes.bad}'",
        "    width: '{sizes.none}'",
      ].join("\n"),
    )
    const broken = design.findings.official.filter(
      (entry) => entry.rule === "broken-ref" && entry.severity === "error",
    )
    expect(broken.map((entry) => entry.message)).toEqual([
      "Reference {sizes.bad} does not resolve to any defined token.",
      "Reference {sizes.none} does not resolve to any defined token.",
    ])
  })
})

describe("fonts and typography", () => {
  test("a font is checked for its shape and against the catalogue", () => {
    const design = parse(
      [
        "name: A",
        "fonts:",
        "  sans:",
        "    family: '\"Public Sans\"'",
        "    provider: adobe",
        "    weights: { body: 400, bold: 1200, label: 750 }",
        "    fallback: 5",
        "    default: yes please",
        "    colour: red",
        "  odd: { family: Not A Real Font, weights: 400 }",
        "  empty: { provider: google }",
        "  serif: { family: Merriweather }",
      ].join("\n"),
    )
    expect(design.fonts.sans).toEqual({
      family: "Public Sans",
      provider: "google",
      weights: { body: 400, label: 750 },
      fallback: "system-ui, sans-serif",
      default: true,
    })
    expect(design.fonts.serif?.fallback).toBe("Georgia, serif")
    expect(design.fonts.empty).toBeUndefined()
    for (const path of [
      "fonts.sans.provider",
      "fonts.sans.weights.bold",
      "fonts.sans.weights.label",
      "fonts.sans.fallback",
      "fonts.sans.default",
      "fonts.sans.colour",
      "fonts.odd",
      "fonts.odd.weights",
      "fonts.empty",
    ]) {
      expect(finding(design, path, "warning")).toBeDefined()
    }
    expect(finding(design, "fonts.sans", "info")?.message).toContain(
      "No font is marked default",
    )
  })

  test("a font outside the catalogue keeps the profile's weights", () => {
    const design = parse("name: A\nfonts:\n  sans: { family: House Grotesk }")
    expect(design.roles["weight-statement"]).toEqual({
      value: "900",
      inferred: true,
    })
    expect(finding(design, "roles.weight-statement", "info")?.message).toBe(
      `"weight-statement" is inferred from the profile's default: 900.`,
    )
  })

  test("several default fonts keep the first", () => {
    const design = parse(
      "name: A\nfonts:\n  a: { family: Inter, default: true }\n  b: { family: Roboto, default: true }",
    )
    expect(design.fonts.a?.default).toBe(true)
    expect(design.fonts.b?.default).toBe(false)
    expect(finding(design, "fonts", "warning")).toBeDefined()
  })

  test("levels inherit the default font, or bind to the font their family names", () => {
    const design = parse(
      [
        "name: A",
        "fonts:",
        "  sans: { family: Inter, weights: { body: 400 }, default: true }",
        "  display: { family: Lobster }",
        "typography:",
        "  body: { fontSize: 16px, fontWeight: '400' }",
        "  title: { fontFamily: '{fonts.display}', fontSize: 32px, fontWeight: bold }",
        "  label: { fontFamily: Inter, letterSpacing: { a: 1 } }",
        "  code: { fontFamily: 'Fira Code, ui-monospace, monospace' }",
        "  broken: { fontFamily: 5, lineHeight: '{nope}' }",
        "  rules: [a, b]",
      ].join("\n"),
    )
    expect(design.typography.body).toEqual({
      fontFamily: "Inter",
      size: "16px",
      weight: 400,
    })
    expect(design.typography.title).toEqual({
      fontFamily: "Lobster",
      size: "32px",
    })
    expect(design.typography.label).toEqual({ fontFamily: "Inter" })
    expect(design.typography.code).toEqual({ fontFamily: "Fira Code" })
    expect(design.typography.broken).toEqual({})
    expect(design.typography.rules).toBeUndefined()
    expect(finding(design, "typography.rules", "warning")).toBeDefined()
    expect(
      finding(design, "typography.label.letterSpacing", "warning"),
    ).toBeDefined()
    expect(design.fonts["fira-code"]).toMatchObject({
      fallback: "ui-monospace, monospace",
      inferred: true,
    })
    expect(design.refs["typography.title.fontFamily"]).toBe(
      "fonts.display.family",
    )
    expect(design.refs["typography.body.fontFamily"]).toBe("fonts.sans.family")
    const values = tokens(design)
    expect(values.get("type-title-family")).toBe(
      `"Lobster", system-ui, sans-serif`,
    )
    expect(values.has("type-body-family")).toBe(false)
    expect(values.get("weight-body")).toBe("400")
    expect(values.get("weight-label")).toBe("700")
  })

  test("without a fonts group, the most used family is the default when no level is body", () => {
    const design = parse(
      [
        "name: A",
        "typography:",
        "  h1: { fontFamily: Lobster, fontSize: 40px }",
        "  h2: { fontFamily: Inter, fontSize: 30px }",
        "  h3: { fontFamily: Inter, fontSize: 20px }",
        "  x: { fontFamily: '???' }",
        "  y: { fontFamily: '!!!' }",
      ].join("\n"),
    )
    expect(design.fonts.inter?.default).toBe(true)
    expect(design.fonts.font?.family).toBe("???")
    expect(design.fonts["font-font"]?.family).toBe("!!!")
    expect(finding(design, "fonts.font", "warning")?.message).toContain(
      "not in the Google Fonts catalogue",
    )
    expect(tokens(design).get("weight-statement")).toBe("900")
  })

  test("without any font, levels name no family and the weights take the profile's", () => {
    const design = parse(
      "name: A\ntypography:\n  body: { fontSize: 16px }\n  empty: {}",
    )
    expect(design.fonts).toEqual({})
    expect(design.typography.body).toEqual({ size: "16px" })
    const values = tokens(design)
    expect(values.get("font-sans")).toBe("system-ui, sans-serif")
    expect(values.get("weight-label")).toBe("700")
    expect(
      [...values.keys()].filter((name) => name.startsWith("type-empty")),
    ).toEqual([])
  })
})

describe("roles from the file", () => {
  test("a role is checked for the value it takes", () => {
    const design = parse(
      [
        "name: A",
        "colors:",
        "  ink: '#101010'",
        "fonts:",
        "  sans: { family: Inter }",
        "roles:",
        "  foreground: '{colors.ink}'",
        "  background: white",
        "  primary: not a colour",
        "  font-sans: Inter",
        "  weight-body: 450",
        "  weight-label: heavy",
        "  radius: 0",
        "  radius-full: round",
        "  spacing-unit: '{spacing.none}'",
        "  primary-colour: '#000000'",
      ].join("\n"),
    )
    expect(design.roles.foreground).toEqual({
      ref: "colors.ink",
      value: "#101010",
    })
    expect(design.roles.background).toEqual({ value: "#ffffff" })
    expect(design.roles.primary).toMatchObject({
      inferred: true,
      ref: "colors.ink",
    })
    expect(design.roles["font-sans"]).toEqual({
      value: `"Inter", system-ui, sans-serif`,
    })
    expect(design.roles["weight-body"]).toEqual({ value: "450" })
    expect(design.roles.radius).toEqual({ value: "0" })
    expect(design.roles["weight-label"]?.inferred).toBe(true)
    expect(design.roles["radius-full"]?.inferred).toBe(true)
    for (const path of [
      "roles.primary",
      "roles.weight-label",
      "roles.radius-full",
      "roles.spacing-unit",
    ]) {
      expect(finding(design, path, "error")).toBeDefined()
    }
    expect(finding(design, "roles.primary-colour", "warning")).toBeDefined()
  })

  test("font-sans takes a font, a family or a stack", () => {
    const font = parse(
      "name: A\nfonts:\n  sans: { family: Inter, fallback: 'Arial, sans-serif' }\n  bare: { family: Roboto }\nroles:\n  font-sans: '{fonts.sans}'",
    )
    expect(font.roles["font-sans"]).toEqual({
      ref: "fonts.sans",
      value: `"Inter", Arial, sans-serif`,
    })
    const stack = parse("name: A\nroles:\n  font-sans: 'Georgia, serif'")
    expect(stack.roles["font-sans"]).toEqual({ value: "Georgia, serif" })
    const tree = parse(
      "name: A\nthing: { family: Roboto }\nroles:\n  font-sans: '{thing}'",
    )
    expect(tree.roles["font-sans"]).toEqual({
      ref: "thing",
      value: `"Roboto", system-ui, sans-serif`,
    })
    const wrong = parse("name: A\nroles:\n  font-sans: 5")
    expect(finding(wrong, "roles.font-sans", "error")).toBeDefined()
  })
})

describe("roles inferred", () => {
  test("a bare file takes the profile's defaults", () => {
    const design = parse("name: A")
    const values = tokens(design)
    expect(values.get("background")).toBe("#ffffff")
    expect(values.get("foreground")).toBe("#000000")
    expect(values.get("primary")).toBe("#000000")
    expect(values.get("primary-foreground")).toBe("#ffffff")
    expect(values.get("muted")).toBe("#f5f5f5")
    expect(values.get("muted-foreground")).toBe("#666666")
    expect(values.get("border")).toBe("#e6e6e6")
    expect(values.get("secondary-foreground")).toBe("#000000")
    expect(values.get("highlight-1")).toBe("#000000")
    expect(values.get("on-accent")).toBe("#ffffff")
    expect(values.get("overlay")).toBe("#00000080")
    expect(values.get("success")).toBe("#16a34a")
    expect(values.get("radius")).toBe("0px")
    expect(values.get("radius-full")).toBe("9999px")
    expect(values.get("spacing-unit")).toBe("4px")
    expect(values.get("focus-ring")).toBe(
      "0 0 0 2px #ffffff, 0 0 0 4px #000000",
    )
    expect(finding(design, "roles.muted", "info")?.message).toBe(
      `"muted" is inferred from a 4% mix of the foreground into the background (no muted colour): #f5f5f5.`,
    )
  })

  test("the neutral nearest the background is the muted fill; surfaces and on- colours pair", () => {
    const design = parse(
      [
        "name: A",
        "colors:",
        "  surface: '#ffffff'",
        "  on-surface: '#111111'",
        "  neutral-50: '#fafafa'",
        "  neutral-900: '#18181b'",
        "  grey: '#ffffff'",
        "  accent-a: '#ff0000'",
        "  accent-b: '#00ff00'",
        "  inverse-surface: '#222222'",
        "  inverse-on-surface: '#eeeeee'",
        "  surface-container-low: '#f0f0f0'",
        "  accent: '#eeeeee'",
        "rounded:",
        "  sm: 2px",
        "  full: 50%",
      ].join("\n"),
    )
    const values = tokens(design)
    expect(values.get("background")).toBe("#ffffff")
    expect(values.get("foreground")).toBe("#111111")
    expect(values.get("muted")).toBe("#fafafa")
    expect(values.get("card")).toBe("#ffffff")
    expect(values.get("card-foreground")).toBe("#111111")
    expect(values.get("sidebar")).toBe("#f0f0f0")
    expect(values.get("sidebar-foreground")).toBe("#111111")
    expect(values.get("surface-dark")).toBe("#222222")
    expect(values.get("on-dark")).toBe("#eeeeee")
    expect(values.get("highlight-1")).toBe("#ff0000")
    expect(values.get("highlight-3")).toBe("#ff0000")
    expect(values.get("chart-3")).toBe("#00ff00")
    expect(values.get("accent-foreground")).toBe("#111111")
    expect(values.get("sidebar-accent-foreground")).toBe("#111111")
    expect(values.get("radius")).toBe("2px")
    expect(values.get("radius-full")).toBe("50%")
    expect(design.refs["roles.sidebar-accent"]).toBe("colors.accent")
  })

  test("a dark file pairs with the lighter text", () => {
    const design = parse(
      "name: A\ncolors:\n  background: '#000000'\n  on-background: '#f0f0f0'\n  primary: '#f0f0f0'\n  secondary: '#333333'",
    )
    const values = tokens(design)
    expect(values.get("foreground")).toBe("#f0f0f0")
    expect(values.get("primary-foreground")).toBe("#000000")
    expect(values.get("secondary-foreground")).toBe("#f0f0f0")
  })
})
