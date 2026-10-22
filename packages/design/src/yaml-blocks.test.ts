import { describe, expect, test } from "bun:test"
import { extractYamlBlocks } from "./yaml-blocks"

describe("extractYamlBlocks", () => {
  test("reads the front matter", () => {
    const markdown = "---\nname: A\ncolors:\n  a: '#fff'\n---\n\n# Title\n"
    const [block] = extractYamlBlocks(markdown)
    expect(block).toEqual({
      kind: "frontmatter",
      start: 4,
      end: 31,
      text: "name: A\ncolors:\n  a: '#fff'",
    })
    expect(markdown.slice(block!.start, block!.end)).toBe(block!.text)
  })

  test("reads an empty front matter, and none without a closing line", () => {
    expect(extractYamlBlocks("---\n---\n")).toEqual([
      { kind: "frontmatter", start: 4, end: 4, text: "" },
    ])
    expect(extractYamlBlocks("---\nname: A\n")).toEqual([])
    expect(extractYamlBlocks("\n---\nname: A\n---\n")).toEqual([])
  })

  test("reads yaml and yml fences, and skips other languages and fences inside fences", () => {
    const markdown = [
      "# Doc",
      "```yaml",
      "colors:",
      "  a: '#000'",
      "```",
      "````markdown",
      "```yaml",
      "ignored: true",
      "```",
      "````",
      "~~~yml",
      "rounded:",
      "  sm: 4px",
      "~~~",
      "```ts",
      "const x = 1",
      "```",
      "  ```YAML",
      "spacing: {}",
      "  ```",
    ].join("\n")
    expect(extractYamlBlocks(markdown).map((block) => block.text)).toEqual([
      "colors:\n  a: '#000'",
      "rounded:\n  sm: 4px",
      "spacing: {}",
    ])
  })

  test("reads an unclosed fence to the end, and an empty one", () => {
    expect(
      extractYamlBlocks("```yaml\na: 1\nb: 2").map((block) => block.text),
    ).toEqual(["a: 1\nb: 2"])
    expect(extractYamlBlocks("```yaml\n```\n")).toEqual([
      { kind: "fence", start: 8, end: 8, text: "" },
    ])
    expect(extractYamlBlocks("```yaml")).toEqual([
      { kind: "fence", start: 7, end: 7, text: "" },
    ])
  })

  test("reads CRLF documents", () => {
    const [block] = extractYamlBlocks("---\r\nname: A\r\n---\r\n")
    expect(block?.kind).toBe("frontmatter")
    expect(block?.text.trim()).toBe("name: A")
  })
})
