import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { GET } from "../app/design.md/route"
import { subsections } from "../components/design/dos-and-donts"
import { verdicts } from "../components/design/findings"
import {
  accentAt,
  colourGroups,
  partnerOf,
  sectionId,
} from "../components/design/lib"
import { sectionBody } from "../components/design/prose"
import { loadDesign, readDesignSource } from "./design"

const file = readFileSync(join(import.meta.dir, "../../../DESIGN.md"), "utf8")

test("/design.md serves the repository's DESIGN.md as it is", async () => {
  const response = GET()
  expect(response.headers.get("content-type")).toBe(
    "text/markdown; charset=utf-8",
  )
  expect(await response.text()).toBe(file)
  expect(readDesignSource()).toBe(file)
})

test("the page parses the file with no profile error", () => {
  const design = loadDesign()
  expect(design.name).toBe("Answerable")
  expect(
    design.findings.profile.filter((finding) => finding.severity === "error"),
  ).toEqual([])
  expect(design.sections.map((section) => section.heading)).toContain(
    "Do's and don'ts",
  )
})

test("the official verdict counts the references the profile resolves as the errors the CLI reports", () => {
  const design = loadDesign()
  const [profile, official] = verdicts(design)
  const resolved = design.findings.profile.filter(
    (finding) => finding.rule === "profile-resolved-reference",
  )
  expect(profile!.findings).toBe(design.findings.profile)
  expect(official!.findings).toHaveLength(
    design.findings.official.length + resolved.length,
  )
  expect(
    official!.findings.filter((finding) => finding.severity === "error"),
  ).toHaveLength(resolved.length)
})

test("sections lose their heading line, and Do's and don'ts splits into its lists", () => {
  expect(sectionBody("## Shape\n\nEverything is square.\n")).toBe(
    "Everything is square.",
  )
  const dos = loadDesign().sections.find(
    (section) => section.heading === "Do's and don'ts",
  )!
  expect(
    subsections(sectionBody(dos.markdown)).map(({ title }) => title),
  ).toEqual(["Do", "Don't"])
})

test("accents rotate one per section, never twice in a row", () => {
  expect([0, 1, 2, 3, 4, 5].map(accentAt)).toEqual([1, 2, 3, 4, 1, 2])
  expect(sectionId("Lines, separators and focus")).toBe(
    "lines-separators-and-focus",
  )
  expect(sectionId("Do's and don'ts")).toBe("dos-and-donts")
})

test("a role is read against its partner: a fill's text, a text's fill", () => {
  expect(partnerOf("primary")).toBe("primary-foreground")
  expect(partnerOf("primary-foreground")).toBe("primary")
  expect(partnerOf("muted-foreground")).toBe("background")
  expect(partnerOf("highlight-3")).toBe("on-accent")
  expect(partnerOf("chart-2")).toBe("background")
})

test("the file's colours fall in four groups, accents in rotation order", () => {
  const groups = Object.fromEntries(
    colourGroups(loadDesign()).map(({ title, names }) => [title, names]),
  )
  expect(groups.Accent).toEqual([
    "accent-sky",
    "accent-yellow",
    "accent-green",
    "accent-coral",
  ])
  expect(groups.Neutral).toContain("neutral-600")
  expect(groups.Semantic).toContain("primary")
  expect(groups.Core).toContain("background")
})
