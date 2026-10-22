// The server entry: parses a DESIGN.md with Google's official linter, then the Answerable profile pass.
import { lint, type LintReport } from "@google/design.md/linter"
import { parseDocument } from "yaml"
import { groupTokenValues } from "./emit"
import type { GoogleFont } from "./fonts"
import catalogue from "./google-fonts.json"
import {
  colors,
  components,
  fonts,
  lines,
  motionCheck,
  report,
  sizeCheck,
  spacingCheck,
  strings,
  typography,
  type Context,
} from "./profile"
import { isTree, locate, resolveTree, type Tree } from "./resolve"
import { roles } from "./roles"
import type { Design, DesignSection, Finding } from "./types"
import { extractYamlBlocks } from "./yaml-blocks"

function readTokens(markdown: string, findings: Finding[]): Tree {
  const blocks = extractYamlBlocks(markdown)
  if (blocks.length === 0) {
    findings.push({
      severity: "error",
      rule: "profile-yaml",
      message:
        "The file has no tokens: start it with YAML front matter (a --- line) or add a ```yaml block.",
    })
  }
  const tree: Tree = {}
  for (const block of blocks) {
    const document = parseDocument(block.text)
    if (document.errors.length > 0) {
      for (const error of document.errors) {
        findings.push({
          severity: "error",
          rule: "profile-yaml",
          message: `The YAML does not parse: ${error.message.split("\n")[0]}`,
        })
      }
      continue
    }
    const value: unknown = document.toJS()
    if (!isTree(value)) continue
    for (const [key, entry] of Object.entries(value)) {
      if (Object.hasOwn(tree, key)) {
        findings.push({
          severity: "error",
          path: key,
          rule: "profile-yaml",
          message: `"${key}" is defined in two YAML blocks; a top-level key may be defined once.`,
        })
        continue
      }
      tree[key] = entry
    }
  }
  return tree
}

const BROKEN = /^Reference \{([^}]+)\} does not resolve/

/** The official findings, less the broken references the profile resolves, which become profile infos. */
function partition(
  official: Finding[],
  raw: Tree,
  profile: Finding[],
): Finding[] {
  const failed = new Set(
    profile
      .filter((finding) => finding.rule === "profile-reference")
      .map((finding) => finding.path),
  )
  return official.filter((finding) => {
    const ref =
      finding.severity === "error" && finding.rule === "broken-ref"
        ? BROKEN.exec(finding.message)?.[1]
        : undefined
    const keys = ref === undefined ? undefined : locate(raw, ref)
    if (!keys || failed.has(keys.join("."))) return true
    profile.push({
      severity: "info",
      path: finding.path,
      rule: "profile-resolved-reference",
      message: `Reference {${ref}} resolves through the profile; the official linter reports it as broken-ref.`,
    })
    return false
  })
}

function sections(lintReport: LintReport): DesignSection[] {
  return lintReport.documentSections.flatMap(({ heading, content }) => {
    const markdown = heading
      ? content
      : content.replace(/^---\r?\n[\s\S]*?\r?\n---(\r?\n|$)/, "")
    return heading || markdown.trim() ? [{ heading, markdown }] : []
  })
}

const text = (value: unknown) => (typeof value === "string" ? value : "")

/**
 * Parses a DESIGN.md: Google's official linter for the base format, then the Answerable profile pass
 * (the typed extension groups, references anywhere in the YAML tree, fonts, and roles completed by
 * inference). Server only: the official linter reads its configuration from disk. Problems are findings;
 * it throws only if the official linter does, which it documents for an unrecoverable parse failure.
 */
export function parseDesign(markdown: string): Design {
  const profile: Finding[] = []
  const lintReport = lint(markdown)
  const raw = readTokens(markdown, profile)
  const { resolved, refs, findings } = resolveTree(raw)
  profile.push(...findings)

  const context: Context = {
    raw,
    resolved,
    refs,
    findings: profile,
    catalogue: catalogue as GoogleFont[],
    officialColors: lintReport.designSystem.colors,
  }
  const notes: Record<string, Record<string, string>> = {}
  const note = (key: string) => (notes[key] = {})

  const colorTokens = colors(context)
  const fontTokens = fonts(context)
  const typographyTokens = typography(context, fontTokens)
  const rounded = strings(context, "rounded")
  const spacing = strings(context, "spacing", spacingCheck)
  for (const key of Object.keys(spacing)) {
    if (key.includes(".")) {
      report(
        context,
        "warning",
        `spacing.${key}`,
        `"spacing.${key}" has a dot in its name; use a CSS identifier such as half, as Tailwind rejects dotted names.`,
      )
    }
  }
  const elevationNotes = note("elevation")
  const elevation = strings(context, "elevation", undefined, elevationNotes)
  const linesNotes = note("lines")
  const lineTokens = lines(context, linesNotes)
  const focus = strings(context, "focus", undefined, note("focus"))
  const roleTokens = roles(context, {
    colors: colorTokens,
    fonts: fontTokens,
    rounded,
    spacing,
  })

  for (const [key, value] of Object.entries(notes))
    if (Object.keys(value).length === 0) delete notes[key]

  const design: Design = {
    name: text(resolved.name),
    description: text(resolved.description),
    version: text(resolved.version),
    colors: colorTokens,
    typography: typographyTokens,
    fonts: fontTokens,
    rounded,
    spacing,
    sizes: strings(context, "sizes", sizeCheck),
    elevation,
    lines: lineTokens,
    focus,
    motion: strings(context, "motion", motionCheck),
    outputRules: strings(context, "output-rules"),
    notes,
    roles: roleTokens,
    components: components(context),
    refs,
    sections: sections(lintReport),
    findings: { official: [], profile },
    source: markdown,
  }
  if (!design.name) report(context, "warning", "name", "The file has no name.")
  for (const { spec, path, value } of groupTokenValues(design)) {
    if (path === undefined) {
      const at = `${spec.source}.${spec.keys[0]}${spec.field ? `.${spec.field}` : ""}`
      report(
        context,
        "info",
        at,
        `"${spec.name}" has no value in the ${spec.source} group; the profile's default applies: ${value}.`,
        "profile-default",
      )
    }
  }
  design.findings.official = partition(lintReport.findings, raw, profile)
  return design
}
