// Writes packages/ui/src/styles/tokens.css from the repository's DESIGN.md: bun run generate.
import { readFileSync, writeFileSync } from "node:fs"
import { serializeTokensCss } from "../src/emit"
import { parseDesign } from "../src/parse"

const source = new URL("../../../DESIGN.md", import.meta.url)
const target = new URL("../../ui/src/styles/tokens.css", import.meta.url)

const design = parseDesign(readFileSync(source, "utf8"))
const errors = [...design.findings.official, ...design.findings.profile].filter(
  (finding) => finding.severity === "error",
)
if (errors.length > 0) {
  for (const { path, message } of errors)
    console.error(`${path ?? "DESIGN.md"}: ${message}`)
  process.exit(1)
}
writeFileSync(target, serializeTokensCss(design))
console.log("Wrote packages/ui/src/styles/tokens.css")
