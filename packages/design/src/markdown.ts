// Writes a design back into its DESIGN.md: only the values that changed, everything else byte for byte.
import {
  isMap,
  isScalar,
  parseDocument,
  stringify,
  type Document,
  type YAMLMap,
} from "yaml"
import { TYPE_PROPERTIES } from "./contract"
import { formatHex } from "./color"
import { defaultFont } from "./emit"
import { familyName } from "./fonts"
import { readPath } from "./overrides"
import {
  isTree,
  locate,
  referenceOf,
  resolveTree,
  valueOf,
  type Tree,
} from "./resolve"
import type { Design } from "./types"
import { extractYamlBlocks } from "./yaml-blocks"

type Scalar = string | number | boolean

interface Change {
  keys: string[]
  value: Scalar
  /** Colours are always written double-quoted. */
  quote?: boolean
}

interface Edit {
  at: number
  remove: number
  text: string
}

const NUMBER = /^-?(\d+\.?\d*|\.\d+)$/

/** A model string as the YAML type the file would hold: numbers stay numbers. */
const typed = (value: string): Scalar =>
  NUMBER.test(value) ? Number(value) : value

const family = (value: unknown) =>
  isTree(value) && typeof value.family === "string"
    ? familyName(value.family).toLowerCase()
    : familyName(String(value).split(",")[0]!).toLowerCase()

/** What the original says at a path: the value as written and as resolved. */
interface Original {
  raw: Tree
  resolved: Tree
}

/** The changes that bring the original's tokens to the design's. */
function changes(original: Original, design: Design): Change[] {
  const result: Change[] = []
  const keysOf = (path: string) => locate(original.raw, path) ?? path.split(".")
  const holds = (path: string, current: string | undefined) => {
    const ref = referenceOf(valueOf(original.raw, path))
    return ref !== undefined && current === readPath(design, ref)
  }
  const consider = (
    path: string,
    value: Scalar,
    same: (before: unknown) => boolean,
    quote?: boolean,
  ) => {
    const keys = locate(original.raw, path)
    if (
      keys &&
      (holds(path, String(value)) || same(valueOf(original.resolved, path)))
    )
      return
    result.push({ keys: keys ?? keysOf(path), value, quote })
  }
  const text = (value: string) => (before: unknown) =>
    before !== undefined && String(before) === value

  for (const key of ["name", "description", "version"] as const) {
    if (design[key] || valueOf(original.raw, key) !== undefined)
      consider(key, design[key], text(design[key]))
  }
  for (const [name, colour] of Object.entries(design.colors)) {
    const path = `colors.${name}`
    const written = valueOf(original.raw, path)
    if (written === colour.raw) continue
    const literal =
      typeof written === "string" && referenceOf(written) === undefined
    if (
      literal &&
      formatHex(written) === colour.hex &&
      colour.raw === colour.hex
    )
      continue
    const value =
      referenceOf(colour.raw) === undefined ? colour.hex : colour.raw
    result.push({ keys: keysOf(path), value, quote: true })
  }
  const fallback = defaultFont(design)
  for (const [level, type] of Object.entries(design.typography)) {
    for (const property of TYPE_PROPERTIES) {
      const value = type[property.key]
      if (value === undefined) continue
      const path = `typography.${level}.${property.yaml}`
      if (property.key === "fontFamily") {
        const font = design.refs[path]?.match(/^fonts\.([^.]+)\.family$/)?.[1]
        const bound = font !== undefined && !design.fonts[font]?.inferred
        const written = valueOf(original.raw, path)
        const ref = referenceOf(written)
        if (
          written === undefined &&
          (bound || (fallback && family(value) === family(fallback.family)))
        )
          continue
        if (
          ref !== undefined &&
          family(readPath(design, ref)) === family(value)
        )
          continue
        consider(
          path,
          String(value),
          (before) => before !== undefined && family(before) === family(value),
        )
        continue
      }
      consider(
        path,
        typeof value === "number" ? value : typed(value),
        text(String(value)),
      )
    }
  }
  for (const [key, font] of Object.entries(design.fonts)) {
    if (font.inferred) continue
    const base = `fonts.${key}`
    const exists = locate(original.raw, base) !== undefined
    consider(`${base}.family`, font.family, text(font.family))
    if (!exists) {
      result.push({ keys: keysOf(`${base}.provider`), value: font.provider })
    }
    for (const [role, weight] of Object.entries(font.weights)) {
      consider(`${base}.weights.${role}`, weight!, text(String(weight)))
    }
    if (!exists || locate(original.raw, `${base}.fallback`))
      consider(`${base}.fallback`, font.fallback, text(font.fallback))
  }
  const groups = [
    ["rounded", design.rounded],
    ["spacing", design.spacing],
    ["sizes", design.sizes],
    ["elevation", design.elevation],
    ["focus", design.focus],
    ["motion", design.motion],
    ["output-rules", design.outputRules],
  ] as const
  for (const [group, values] of groups) {
    for (const [key, value] of Object.entries(values))
      consider(`${group}.${key}`, typed(value), text(value))
  }
  for (const [name, line] of Object.entries(design.lines)) {
    consider(`lines.${name}.width`, line.width, text(line.width))
    consider(
      `lines.${name}.color`,
      line.color,
      (before) =>
        typeof before === "string" && formatHex(before) === line.color,
      true,
    )
  }
  for (const [role, entry] of Object.entries(design.roles)) {
    if (entry.inferred) continue
    const path = `roles.${role}`
    const written = entry.ref === undefined ? entry.value : `{${entry.ref}}`
    const before = valueOf(original.raw, path)
    if (before !== undefined && String(before) === written) continue
    if (
      entry.ref === undefined &&
      typeof before === "string" &&
      referenceOf(before) === undefined &&
      formatHex(before) !== null &&
      formatHex(before) === formatHex(entry.value)
    )
      continue
    result.push({ keys: keysOf(path), value: typed(written), quote: true })
  }
  return result
}

function render(
  value: Scalar,
  type: string | undefined,
  quote: boolean | undefined,
): string {
  if (typeof value !== "string") return String(value)
  if (type === "QUOTE_SINGLE") return `'${value.replace(/'/g, "''")}'`
  if (quote || type === "QUOTE_DOUBLE" || type?.startsWith("BLOCK"))
    return JSON.stringify(value)
  return stringify(value).trimEnd()
}

/** The subtree of the missing keys, as YAML lines. */
function block(subtree: Tree): string[] {
  return stringify(subtree, {
    defaultStringType: "QUOTE_DOUBLE",
    defaultKeyType: "PLAIN",
  })
    .trimEnd()
    .split("\n")
}

const indentOf = (text: string, offset: number) =>
  offset - text.lastIndexOf("\n", offset - 1) - 1

function insertion(text: string, map: YAMLMap | null, missing: Tree): Edit {
  if (!map) return { at: 0, remove: 0, text: `${block(missing).join("\n")}\n` }
  const items = map.items
  if (map.flow) {
    const pairs = Object.entries(missing).map(
      ([key, value]) => `${key}: ${render(value as Scalar, "PLAIN", false)}`,
    )
    const last = items.at(-1)?.value as
      { range: [number, number, number] } | undefined
    return last
      ? { at: last.range[1], remove: 0, text: `, ${pairs.join(", ")}` }
      : { at: map.range![0] + 1, remove: 0, text: ` ${pairs.join(", ")} ` }
  }
  const first = items[0]?.key as { range: [number, number, number] } | undefined
  const indent = first ? indentOf(text, first.range[0]) : 0
  const at = map.range![1]
  const lines = block(missing)
    .map((line) => `${" ".repeat(indent)}${line}`)
    .join("\n")
  return text[at - 1] === "\n"
    ? { at, remove: 0, text: `${lines}\n` }
    : { at, remove: 0, text: `\n${lines}` }
}

function nest(keys: string[], value: Scalar): Tree {
  return keys.reduceRight<unknown>(
    (inner, key) => ({ [key]: inner }),
    value,
  ) as Tree
}

function merge(into: Tree, from: Tree): void {
  for (const [key, value] of Object.entries(from)) {
    if (isTree(value) && isTree(into[key])) merge(into[key], value)
    else into[key] = value
  }
}

/**
 * The original DESIGN.md with the design's tokens written back: only the values that differ from what the
 * file says are rewritten, through the YAML Document API, so comments, order, spacing and prose survive.
 * A reference that still holds stays a reference; colours are written as lowercase hex; inferred roles and
 * fonts are not written. Returns the original unchanged when its YAML does not parse.
 */
export function designToMarkdown(original: string, design: Design): string {
  const blocks = extractYamlBlocks(original)
  const documents = blocks.map((entry) => parseDocument(entry.text))
  if (documents.some((document) => document.errors.length > 0)) return original
  const raw: Tree = {}
  const owner = new Map<string, number>()
  documents.forEach((document, index) => {
    const value: unknown = document.toJS()
    if (!isTree(value)) return
    for (const [key, entry] of Object.entries(value)) {
      if (owner.has(key)) continue
      owner.set(key, index)
      raw[key] = entry
    }
  })
  const list = changes({ raw, resolved: resolveTree(raw).resolved }, design)
  if (list.length === 0) return original

  const home = blocks.findIndex((entry) => entry.kind === "frontmatter")
  const edits: Edit[] = []
  const pending = new Map<
    string,
    { index: number; map: YAMLMap | null; missing: Tree }
  >()
  const created: Tree = {}
  for (const change of list) {
    const index = owner.get(change.keys[0]!) ?? (home === -1 ? 0 : home)
    const document = documents[index] as Document | undefined
    const node = document?.getIn(change.keys, true)
    if (isScalar(node)) {
      const [start, end] = node.range!
      const breaks = /\n*$/.exec(blocks[index]!.text.slice(start, end))![0]
      edits.push({
        at: blocks[index]!.start + start,
        remove: end - start,
        text: render(change.value, node.type, change.quote) + breaks,
      })
      continue
    }
    if (!document) {
      merge(created, nest(change.keys, change.value))
      continue
    }
    let depth = change.keys.length - 1
    while (
      depth > 0 &&
      !isMap(document.getIn(change.keys.slice(0, depth), true))
    )
      depth--
    const map = (
      depth === 0
        ? document.contents
        : document.getIn(change.keys.slice(0, depth), true)
    ) as unknown
    const empty = depth === 0 && map === null
    if (!empty && (!isMap(map) || map.has(change.keys[depth]))) continue
    const id = `${index}:${change.keys.slice(0, depth).join("\u0000")}`
    const entry = pending.get(id) ?? {
      index,
      map: empty ? null : (map as YAMLMap),
      missing: {},
    }
    merge(entry.missing, nest(change.keys.slice(depth), change.value))
    pending.set(id, entry)
  }
  for (const { index, map, missing } of pending.values()) {
    const edit = insertion(blocks[index]!.text, map, missing)
    edits.push({ ...edit, at: blocks[index]!.start + edit.at })
  }
  let result = original
  for (const edit of edits.sort((a, b) => b.at - a.at)) {
    result =
      result.slice(0, edit.at) + edit.text + result.slice(edit.at + edit.remove)
  }
  if (Object.keys(created).length > 0) {
    result = `---\n${block(created).join("\n")}\n---\n\n${result}`
  }
  return result
}
