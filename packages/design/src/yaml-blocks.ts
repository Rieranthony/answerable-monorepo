// Locates the YAML of a DESIGN.md: the front matter and the ```yaml fences, as the official parser reads them.

/** A YAML block of a document, with the offsets of its text. */
export interface YamlBlock {
  kind: "frontmatter" | "fence"
  /** The offset of the YAML's first character. */
  start: number
  /** The offset after its last character. */
  end: number
  text: string
}

interface Line {
  start: number
  text: string
}

function lines(markdown: string): Line[] {
  const result: Line[] = []
  let start = 0
  for (const text of markdown.split("\n")) {
    result.push({ start, text: text.replace(/\r$/, "") })
    start += text.length + 1
  }
  return result
}

const OPEN = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/

/** The front matter (a `---` line on the first line to the next `---` line) and every ```yaml or ```yml fence, in order. */
export function extractYamlBlocks(markdown: string): YamlBlock[] {
  const all = lines(markdown)
  const blocks: YamlBlock[] = []
  let index = 0
  if (all[0]?.text === "---") {
    const close = all.findIndex((line, at) => at > 0 && line.text === "---")
    if (close > 0) {
      const start = all[1]!.start
      const end = close > 1 ? all[close]!.start - 1 : start
      blocks.push({
        kind: "frontmatter",
        start,
        end,
        text: markdown.slice(start, end),
      })
      index = close + 1
    }
  }
  for (; index < all.length; index++) {
    const open = OPEN.exec(all[index]!.text)
    if (!open) continue
    const fence = open[1]!
    const yaml = /^(yaml|yml)$/i.test(open[2]!)
    const close = all.findIndex(
      (line, at) =>
        at > index &&
        line.text.trim().startsWith(fence[0]!.repeat(fence.length)) &&
        /^ {0,3}(`+|~+)\s*$/.test(line.text) &&
        line.text.trim().length >= fence.length,
    )
    const last = close === -1 ? all.length : close
    if (yaml) {
      const start =
        index + 1 < all.length ? all[index + 1]!.start : markdown.length
      const end =
        last > index + 1
          ? all[last - 1]!.start + all[last - 1]!.text.length
          : start
      blocks.push({
        kind: "fence",
        start,
        end,
        text: markdown.slice(start, end),
      })
    }
    index = last
  }
  return blocks
}
