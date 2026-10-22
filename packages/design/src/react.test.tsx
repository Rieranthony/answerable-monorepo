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
const fonts = { "Public Sans": "'Public Sans', 'Public Sans Fallback'" }

describe("on the server", () => {
  test("DesignVars declares the self-hosted font at :root", () => {
    const html = renderToStaticMarkup(
      <DesignProvider design={design} fonts={fonts}>
        <DesignVars />
      </DesignProvider>,
    )
    expect(html).toBe(
      `<style data-design-vars="root">:root {\n  --design-font-sans: 'Public Sans', 'Public Sans Fallback', system-ui, sans-serif;\n}\n</style>`,
    )
  })

  test("DesignVars with a scope declares under the scope; with nothing to declare it is empty", () => {
    const html = renderToStaticMarkup(
      <DesignProvider design={design}>
        <DesignVars scope="pane one" />
      </DesignProvider>,
    )
    expect(html).toBe(`<style data-design-vars="pane-one"></style>`)
    const scoped = renderToStaticMarkup(
      <DesignProvider design={design} fonts={fonts}>
        <DesignVars scope="pane" />
      </DesignProvider>,
    )
    expect(scoped).toContain(`[data-design-scope="pane"] {`)
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
    expect(style()).toBe(
      `:root {\n  --design-primary: #ff0000;\n  --design-font-sans: "Inter", system-ui, sans-serif;\n}\n`,
    )
    expect(state!.css).toBe(style()!)
    expect(
      document.head.querySelector('link[href*="family=Inter"]'),
    ).not.toBeNull()
    const markdown = state!.markdown
    expect(markdown).toContain(`  primary: "#ff0000"`)
    expect(state!.markdown).toBe(markdown)

    await act(async () => state!.reset("primary"))
    expect(state!.overrides).toEqual({ "fonts.sans.family": "Inter" })
    expect(style()).not.toContain("--design-primary")

    await act(async () => state!.reset())
    expect(state!.overrides).toEqual({})
    expect(style()).toContain("'Public Sans Fallback'")
    expect(state!.design).toBe(design)
    await act(async () => root.unmount())
  })
})
