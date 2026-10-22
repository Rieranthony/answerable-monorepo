import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { GROUP_TOKENS, ROLES } from "./contract"
import { designToTokens } from "./emit"
import { parseDesign } from "./parse"
import type { Design, Finding } from "./types"

const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8")
const errors = (design: Design): Finding[] =>
  [...design.findings.official, ...design.findings.profile].filter(
    (finding) => finding.severity === "error",
  )

describe("the repository's DESIGN.md", () => {
  const design = parseDesign(read("../../../DESIGN.md"))

  test("has no errors, official or profile", () => {
    expect(errors(design)).toEqual([])
  })

  test("binds every role in its roles group", () => {
    expect(ROLES.filter((role) => design.roles[role].inferred)).toEqual([])
    expect(design.roles.primary).toEqual({
      ref: "colors.primary",
      value: "#000000",
    })
    expect(design.roles["font-sans"]).toEqual({
      ref: "fonts.sans",
      value: `"Public Sans", system-ui, sans-serif`,
    })
    expect(design.roles["highlight-1"]).toEqual({
      ref: "colors.accent-sky",
      value: "#a8dce8",
    })
  })

  test("moves the official linter's broken references into the profile's infos", () => {
    const moved = design.findings.profile.filter(
      (finding) => finding.rule === "profile-resolved-reference",
    )
    expect(moved).toHaveLength(20)
    expect(moved[0]).toEqual({
      severity: "info",
      path: "components.button-default",
      rule: "profile-resolved-reference",
      message:
        "Reference {sizes.control-md} resolves through the profile; the official linter reports it as broken-ref.",
    })
    expect(
      design.findings.official.filter(
        (finding) =>
          finding.rule === "broken-ref" && finding.severity === "error",
      ),
    ).toEqual([])
  })

  test("reads the profile groups and keeps their prose aside", () => {
    expect(design.fonts).toEqual({
      sans: {
        family: "Public Sans",
        provider: "google",
        weights: { body: 400, label: 700, statement: 900 },
        fallback: "system-ui, sans-serif",
        default: true,
      },
    })
    expect(design.typography["heading-h1"]).toEqual({
      fontFamily: "Public Sans",
      size: "36px",
      weight: 900,
      leading: "1.1",
      tracking: "-0.8px",
    })
    expect(design.typography.eyebrow?.transform).toBe("uppercase")
    expect(design.typography.numeric).toEqual({
      fontFamily: "Public Sans",
      numeric: "tabular-nums",
    })
    expect(design.spacing.unit).toBe("4px")
    expect(design.lines["interface-separator"]).toEqual({
      width: "1px",
      color: "#e4e4e7",
    })
    expect(design.motion.easing).toBe("cubic-bezier(0.2, 0, 0, 1)")
    expect(Object.keys(design.notes)).toEqual(["elevation", "lines", "focus"])
    expect(design.elevation.rule).toBeUndefined()
    expect(design.outputRules.logos).toStartWith("Never render a logo")
    expect(design.colors.muted).toEqual({
      raw: "{colors.neutral-100}",
      hex: "#f4f4f5",
    })
    expect(design.colors.overlay).toEqual({
      raw: "rgba(0, 0, 0, 0.5)",
      hex: "#00000080",
    })
    expect(design.components["button-default"]?.height).toBe("36px")
    expect(design.components["button-default"]?.typography).toBe(
      "{typography.button}",
    )
    expect(design.components["badge-accent"]?.variants).toBe(
      "accent-coral, accent-sky, accent-yellow, accent-green",
    )
    expect(design.refs["typography.button.fontFamily"]).toBe(
      "fonts.sans.family",
    )
  })

  test("keeps the sections in order, the front matter out of them", () => {
    expect(
      design.sections.map((section) => section.heading).slice(0, 4),
    ).toEqual(["", "Output rules", "Overview", "Readability"])
    expect(design.sections[0]?.markdown).toBe("\n# Design System\n")
    expect(design.sections.at(-1)?.heading).toBe("Do's and don'ts")
    expect(design.name).toBe("Answerable")
    expect(design.version).toBe("beta")
  })
})

describe("Google's examples, written without the profile", () => {
  for (const name of [
    "atmospheric-glass",
    "paws-and-paths",
    "totality-festival",
  ]) {
    const design = parseDesign(read(`./fixtures/google/${name}.md`))

    test(`${name} parses without errors`, () => {
      expect(errors(design)).toEqual([])
    })

    test(`${name} gets every role inferred, each with an info finding`, () => {
      for (const role of ROLES) {
        expect(design.roles[role].inferred).toBe(true)
        expect(design.findings.profile).toContainEqual(
          expect.objectContaining({
            severity: "info",
            path: `roles.${role}`,
            rule: "profile-role",
          }),
        )
      }
    })

    test(`${name} emits a complete tokens block`, () => {
      const names = designToTokens(design).map((token) => token.name)
      for (const required of [
        ...ROLES,
        ...GROUP_TOKENS.map((token) => token.name),
      ]) {
        expect(names).toContain(required)
      }
      expect(names.some((token) => token.startsWith("type-body-md-"))).toBe(
        true,
      )
      expect(designToTokens(design).every((token) => token.value !== "")).toBe(
        true,
      )
    })
  }

  test("roles follow the files' own names", () => {
    const paws = parseDesign(read("./fixtures/google/paws-and-paths.md"))
    expect(paws.roles.primary).toMatchObject({
      ref: "colors.primary",
      value: "#855300",
    })
    expect(paws.roles["primary-foreground"]).toMatchObject({
      ref: "colors.on-primary",
      value: "#ffffff",
    })
    expect(paws.roles.foreground).toMatchObject({ ref: "colors.on-background" })
    expect(paws.roles.destructive).toMatchObject({
      ref: "colors.error",
      value: "#ba1a1a",
    })
    expect(paws.roles.border).toMatchObject({ ref: "colors.outline-variant" })
    expect(paws.roles["card-foreground"]).toMatchObject({
      ref: "colors.on-background",
    })
    expect(paws.roles["highlight-4"]).toMatchObject({ ref: "colors.error" })
    expect(paws.roles["weight-statement"]).toEqual({
      value: "800",
      inferred: true,
    })
    expect(paws.roles.radius).toMatchObject({
      ref: "rounded.DEFAULT",
      value: "0.5rem",
    })
    expect(paws.roles["spacing-unit"]).toMatchObject({
      ref: "spacing.base",
      value: "8px",
    })
    expect(paws.fonts).toEqual({
      "plus-jakarta-sans": {
        family: "Plus Jakarta Sans",
        provider: "google",
        weights: {},
        fallback: "system-ui, sans-serif",
        default: true,
        inferred: true,
      },
    })
    expect(paws.refs["roles.primary"]).toBe("colors.primary")
  })

  test("a file with two families takes the body's as the default font", () => {
    const totality = parseDesign(read("./fixtures/google/totality-festival.md"))
    expect(totality.fonts.inter?.default).toBe(true)
    expect(totality.fonts["space-grotesk"]?.default).toBe(false)
    const tokens = new Map(
      designToTokens(totality).map((token) => [token.name, token.value]),
    )
    expect(tokens.get("font-sans")).toBe(`"Inter", system-ui, sans-serif`)
    expect(tokens.get("type-headline-xl-family")).toBe(
      `"Space Grotesk", system-ui, sans-serif`,
    )
    expect(tokens.has("type-body-md-family")).toBe(false)
    expect(tokens.get("focus-ring")).toBe(
      "0 0 0 2px #121318, 0 0 0 4px #fff6df",
    )
  })
})
