import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { ROLES } from "./contract"
import { designToTokens } from "./emit"
import { applyOverrides } from "./overrides"
import { parseDesign } from "./parse"
import { designHooks, fontRequests } from "./runtime"
import type { Design } from "./types"

const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8")
const repository = parseDesign(read("../../../DESIGN.md"))
const totality = parseDesign(read("./fixtures/google/totality-festival.md"))
const selfHosted = { "public sans": "'Public Sans', 'Public Sans Fallback'" }

const values = (design: Design) =>
  Object.fromEntries(
    designToTokens(design).map((token) => [token.name, token.value]),
  )

const hooks = (
  overrides: Record<string, string>,
  fonts: Record<string, string> = {},
  design = repository,
) => {
  const current = applyOverrides(design, overrides)
  return designHooks(current, designToTokens(current), fonts)
}

describe("designHooks", () => {
  test("declares every contract token of the design", () => {
    expect(hooks({})).toEqual(values(repository))
    expect(Object.keys(hooks({}))).toHaveLength(176)
  })

  test("declares another design's own values, not Answerable's defaults", () => {
    const declared = hooks({}, {}, totality)
    expect(declared).toEqual(values(totality))
    expect(declared).toMatchObject({
      background: "#121318",
      foreground: "#e3e1e9",
      primary: "#fff6df",
      "font-sans": `"Inter", system-ui, sans-serif`,
      radius: "0.25rem",
    })
    for (const role of ROLES) expect(declared[role]).toBeDefined()
  })

  test("carries the self-hosted default font with its fallback", () => {
    expect(hooks({}, selfHosted)).toEqual({
      ...values(repository),
      "font-sans":
        "'Public Sans', 'Public Sans Fallback', system-ui, sans-serif",
    })
    expect(hooks({ "fonts.sans.fallback": "" }, selfHosted)["font-sans"]).toBe(
      "'Public Sans', 'Public Sans Fallback'",
    )
  })

  test("carries every token an override changes, derived ones included, among the rest", () => {
    const declared = hooks({ "colors.accent-coral": "#ff0000" })
    expect(declared).toEqual({
      ...values(repository),
      destructive: "#ff0000",
      "highlight-4": "#ff0000",
      "chart-5": "#ff0000",
    })
  })

  test("a font the provider does not self-host, or a font role set by hand, is declared as it is", () => {
    expect(
      hooks({ "fonts.sans.family": "Inter" }, selfHosted)["font-sans"],
    ).toBe(`"Inter", system-ui, sans-serif`)
    expect(
      hooks({ "font-sans": "Georgia, serif" }, selfHosted)["font-sans"],
    ).toBe("Georgia, serif")
  })
})

describe("fontRequests", () => {
  test("asks for nothing the provider self-hosts", () => {
    expect(fontRequests(repository, selfHosted)).toEqual([])
  })

  test("asks for every family with the weights the design uses", () => {
    expect(fontRequests(repository, {})).toEqual([
      { family: "Public Sans", weights: [400, 700, 900] },
    ])
    expect(fontRequests(totality, {})).toEqual([
      { family: "Space Grotesk", weights: [500, 600, 700] },
      { family: "Inter", weights: [400, 700, 900] },
    ])
  })

  test("follows a family the overrides name", () => {
    const current = applyOverrides(repository, {
      "font-sans": `"Lobster", cursive`,
    })
    expect(fontRequests(current, selfHosted)).toEqual([
      { family: "Lobster", weights: [400, 700, 900] },
    ])
    const bare = parseDesign("---\nname: A\n---\n")
    expect(fontRequests(bare, {})).toEqual([])
  })
})
