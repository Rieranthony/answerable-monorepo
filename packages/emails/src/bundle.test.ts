// What a service that sends mail bundles: the runtime, not React. Answerable ID builds one file with `bun build`, so this
// builds the package's entry the same way and looks inside.
import { expect, test } from "bun:test"

const built = await Bun.build({
  entrypoints: [new URL("./index.ts", import.meta.url).pathname],
  target: "bun",
})
const bundle = await built.outputs[0]!.text()

test("the entry bundles, and holds no React, no renderer and no HTML-to-text converter", () => {
  expect(built.success).toBe(true)
  expect(built.outputs).toHaveLength(1)
  for (const marker of [
    "react.transitional.element",
    "react-dom",
    "@react-email",
    "createElement",
    "renderToStaticMarkup",
    "html-to-text",
    "prettier",
  ]) {
    expect(bundle, marker).not.toContain(marker)
  }
})

test("it stays small: the emails' strings, the fill and the transport", () => {
  // Measured with three templates: 28,292 bytes unminified (25,921 minified), nearly all of it their strings, whose invisible
  // preheader padding is written as \u escapes. With React, react-dom, Prettier and html-to-text the probe measured 1.36 MB.
  expect(Buffer.byteLength(bundle)).toBeLessThan(40_000)
})
