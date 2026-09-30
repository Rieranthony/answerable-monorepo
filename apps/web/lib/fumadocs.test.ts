// The Fumadocs packages must share one fumadocs-core. Bun's isolated linker makes a copy of it for each set of optional
// peers it resolves (zod, @mdx-js/mdx, lucide-react…), and two copies break the docs twice: `asMarkdown()` of one copy
// never opts in the components the other renders, so every `.md` page prints JSX, and tsc runs out of memory comparing
// the copies' types. When this fails, declare the differing peer in apps/web/package.json at the version the others use.
import { expect, test } from "bun:test"
import { realpathSync } from "node:fs"
import { dirname } from "node:path"

const web = dirname(import.meta.dir)
const core = (from: string) =>
  realpathSync(
    dirname(require.resolve("fumadocs-core/package.json", { paths: [from] })),
  )

test("fumadocs-mdx, -ui, -openapi and -typescript use the web app's own fumadocs-core", () => {
  const own = core(web)

  for (const name of [
    "fumadocs-mdx",
    "fumadocs-ui",
    "fumadocs-openapi",
    "fumadocs-typescript",
  ]) {
    const location = realpathSync(
      dirname(require.resolve(`${name}/package.json`, { paths: [web] })),
    )
    expect(core(location), name).toBe(own)
  }
})
