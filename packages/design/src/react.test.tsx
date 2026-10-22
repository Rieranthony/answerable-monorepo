import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { renderToStaticMarkup } from "react-dom/server"
import { parseDesign } from "./parse"
import {
  DesignFonts,
  DesignProvider,
  DesignVars,
  useDesign,
  type DesignState,
} from "./react"

const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8")
const design = parseDesign(read("../../../DESIGN.md"))
const totality = parseDesign(read("./fixtures/google/totality-festival.md"))
const fonts = { "Public Sans": "'Public Sans', 'Public Sans Fallback'" }
const declarations = (css: string) => css.match(/--design-[a-z0-9-]+:/g) ?? []

describe("on the server", () => {
  test("DesignVars declares every contract token at :root, the self-hosted font included", () => {
    const html = renderToStaticMarkup(
      <DesignProvider design={design} fonts={fonts}>
        <DesignVars />
      </DesignProvider>,
    )
    expect(html).toStartWith(
      `<style data-design-vars="root">:root {\n  --design-background: #ffffff;\n  --design-foreground: #000000;\n`,
    )
    expect(html).toContain(
      `  --design-font-sans: 'Public Sans', 'Public Sans Fallback', system-ui, sans-serif;\n`,
    )
    expect(html).toEndWith(
      `  --design-ease: cubic-bezier(0.2, 0, 0, 1);\n}\n</style>`,
    )
    expect(declarations(html)).toHaveLength(176)
  })

  test("DesignVars with a scope declares under the scope", () => {
    const html = renderToStaticMarkup(
      <DesignProvider design={design}>
        <DesignVars scope="pane one" />
      </DesignProvider>,
    )
    expect(html).toStartWith(
      `<style data-design-vars="pane-one">[data-design-scope="pane-one"] {\n`,
    )
    expect(declarations(html)).toHaveLength(176)
  })

  test("DesignVars declares another design's own values", () => {
    const html = renderToStaticMarkup(
      <DesignProvider design={totality}>
        <DesignVars />
      </DesignProvider>,
    )
    expect(html).toContain("  --design-background: #121318;\n")
    expect(html).toContain("  --design-primary: #fff6df;\n")
    expect(html).toContain(
      `  --design-font-sans: "Inter", system-ui, sans-serif;\n`,
    )
    expect(html).toContain("  --design-radius: 0.25rem;\n")
  })

  test("DesignFonts links every family the provider does not self-host", () => {
    const html = renderToStaticMarkup(
      <DesignProvider design={design}>
        <DesignFonts />
      </DesignProvider>,
    )
    expect(html).toBe(
      `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Public+Sans:wght@400;700;900&amp;display=swap" data-precedence="design-fonts"/>`,
    )
    expect(
      renderToStaticMarkup(
        <DesignProvider design={design} fonts={fonts}>
          <DesignFonts />
        </DesignProvider>,
      ),
    ).toBe("")
  })

  test("useDesign outside a provider throws", () => {
    function Lost() {
      useDesign()
      return null
    }
    expect(() => renderToStaticMarkup(<Lost />)).toThrow(
      "useDesign() must be called inside a DesignProvider.",
    )
  })
})

describe("in the browser", () => {
  beforeAll(() => {
    GlobalRegistrator.register({
      settings: {
        disableCSSFileLoading: true,
        handleDisabledFileLoadingAsSuccess: true,
      },
    })
    ;(
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true
  })
  afterAll(async () => {
    await GlobalRegistrator.unregister()
  })

  test("set and reset change the tokens, the hooks block, the fonts and the markdown", async () => {
    const { act } = await import("react")
    const { createRoot } = await import("react-dom/client")
    let state: DesignState | undefined
    function Probe() {
      state = useDesign()
      return null
    }
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    await act(async () =>
      root.render(
        <DesignProvider design={design} fonts={fonts}>
          <DesignVars />
          <DesignFonts />
          <Probe />
        </DesignProvider>,
      ),
    )
    const style = () =>
      host.querySelector("style[data-design-vars]")?.textContent
    expect(state!.overrides).toEqual({})
    expect(state!.markdown).toBe(design.source)
    expect(style()).toContain("--design-font-sans:")

    await act(async () => state!.set("primary", "#ff0000"))
    await act(async () => state!.set("fonts.sans.family", "Inter"))
    expect(state!.overrides).toEqual({
      primary: "#ff0000",
      "fonts.sans.family": "Inter",
    })
    expect(state!.tokens.find((token) => token.name === "primary")?.value).toBe(
      "#ff0000",
    )
    expect(state!.current.fonts.sans?.family).toBe("Inter")
    expect(style()).toContain("  --design-primary: #ff0000;\n")
    expect(style()).toContain(
      `  --design-font-sans: "Inter", system-ui, sans-serif;\n`,
    )
    expect(declarations(style()!)).toHaveLength(176)
    expect(state!.css).toBe(style()!)
    expect(
      document.head.querySelector('link[href*="family=Inter"]'),
    ).not.toBeNull()
    const markdown = state!.markdown
    expect(markdown).toContain(`  primary: "#ff0000"`)
    expect(state!.markdown).toBe(markdown)

    await act(async () => state!.reset("primary"))
    expect(state!.overrides).toEqual({ "fonts.sans.family": "Inter" })
    expect(style()).toContain("  --design-primary: #000000;\n")

    await act(async () => state!.reset())
    expect(state!.overrides).toEqual({})
    expect(style()).toContain("'Public Sans Fallback'")
    expect(state!.design).toBe(design)
    await act(async () => root.unmount())
  })
})
