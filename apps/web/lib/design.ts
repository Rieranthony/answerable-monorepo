// The repository's DESIGN.md, read and parsed at build: the /design page renders it and /design.md serves it.
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { cache } from "react"
import { parseDesign } from "@answerable/design/parse"

// `next build` and `bun test` run from apps/web, so the file is two levels up.
const path = join(process.cwd(), "../../DESIGN.md")

export const readDesignSource = cache(() => readFileSync(path, "utf8"))

export const loadDesign = cache(() => parseDesign(readDesignSource()))
