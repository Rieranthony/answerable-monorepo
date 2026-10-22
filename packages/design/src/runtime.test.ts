import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { designToTokens } from "./emit"
import { applyOverrides } from "./overrides"
import { parseDesign } from "./parse"
import { designHooks, fontRequests } from "./runtime"

const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8")
const repository = parseDesign(read("../../../DESIGN.md"))
const totality = parseDesign(read("./fixtures/google/totality-festival.md"))
const base = designToTokens(repository)
const selfHosted = { "public sans": "'Public Sans', 'Public Sans Fallback'" }

const hooks = (
  overrides: Record<string, string>,
  fonts: Record<string, string> = {},
) => {
  const current = applyOverrides(repository, overrides)
  return designHooks(base, current, designToTokens(current), fonts)
}

describe("designHooks", () => {
  test("declares nothing for the design as parsed without self-hosted fonts", () => {
    expect(hooks({})).toEqual({})
  })

  test("carries the self-hosted default font with its fallback", () => {
    expect(hooks({}, selfHosted)).toEqual({
      "font-sans":
        "'Public Sans', 'Public Sans Fallback', system-ui, sans-serif",
    })
    expect(hooks({ "fonts.sans.fallback": "" }, selfHosted)).toEqual({
      "font-sans": "'Public Sans', 'Public Sans Fallback'",
    })
  })

  test("declares every token an override changes, derived ones included", () => {
    expect(hooks({ "colors.accent-coral": "#ff0000" })).toEqual({
      destructive: "#ff0000",
      "highlight-4": "#ff0000",
      "chart-5": "#ff0000",
    })
  })

  test("a font the provider does not self-host, or a font role set by hand, is declared as it is", () => {
    expect(hooks({ "fonts.sans.family": "Inter" }, selfHosted)).toEqual({
      "font-sans": `"Inter", system-ui, sans-serif`,
    })
    expect(hooks({ "font-sans": "Georgia, serif" }, selfHosted)).toEqual({
      "font-sans": "Georgia, serif",
    })
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
