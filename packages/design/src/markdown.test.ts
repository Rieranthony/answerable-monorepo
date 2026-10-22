import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { designToTokens } from "./emit"
import { designToMarkdown } from "./markdown"
import { applyOverrides } from "./overrides"
import { parseDesign } from "./parse"

const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8")
const source = read("../../../DESIGN.md")
const repository = parseDesign(source)

/** The markdown with the overrides written in. */
const write = (markdown: string, overrides: Record<string, string>) =>
  designToMarkdown(markdown, applyOverrides(parseDesign(markdown), overrides))

/** The original with each `[from, to]` replaced once. */
const edited = (markdown: string, ...replacements: [string, string][]) =>
  replacements.reduce((text, [from, to]) => {
    expect(text).toContain(from)
    return text.replace(from, to)
  }, markdown)

describe("without edits", () => {
  for (const [name, markdown] of [
    ["the repository's DESIGN.md", source],
    ["atmospheric-glass", read("./fixtures/google/atmospheric-glass.md")],
    ["paws-and-paths", read("./fixtures/google/paws-and-paths.md")],
    ["totality-festival", read("./fixtures/google/totality-festival.md")],
    ["a bare file", "---\nname: A\n---\n"],
    [
      "literal lines",
      '---\nname: A\nlines:\n  a: { width: 1px, color: "#FF0000" }\n---\n',
    ],
    [
      "interleaved blocks",
      "---\nname: A\n---\n\n## Colors\n\n```yaml\ncolors:\n  primary: '#000000'\n```\n",
    ],
  ] as const) {
    test(`${name} comes back byte for byte`, () => {
      expect(designToMarkdown(markdown, parseDesign(markdown))).toBe(markdown)
    })
  }
})

describe("edits on the repository's DESIGN.md", () => {
  test("rewrite only the values that changed, keeping comments, alignment and references that hold", () => {
    const result = write(source, {
      "colors.neutral-100": "oklch(0.9 0.02 250)",
      primary: "#ff0000",
      "fonts.sans.family": "Inter",
      "type-button-size": "15px",
      "control-md": "40px",
      "line-separator-width": "2px",
      "weight-body": "500",
      "rounded.none": "2px",
    })
    expect(result).toBe(
      edited(
        source,
        [
          `  neutral-100: "#F4F4F5"      # Input`,
          `  neutral-100: "#d4dfeb"      # Input`,
        ],
        [`    family: "Public Sans"`, `    family: "Inter"`],
        [
          "  button:         { fontSize: 14px, fontWeight: 700",
          "  button:         { fontSize: 15px, fontWeight: 700",
        ],
        ["  none: 0px", "  none: 2px"],
        ["  control-md: 36px", "  control-md: 40px"],
        [
          "interface-separator: { width: 1px,",
          "interface-separator: { width: 2px,",
        ],
        [`  primary: "{colors.primary}"`, `  primary: "#ff0000"`],
        [`  weight-body: "{fonts.sans.weights.body}"`, "  weight-body: 500"],
      ),
    )
    const again = parseDesign(result)
    expect(
      designToTokens(again).find((token) => token.name === "radius")?.value,
    ).toBe("2px")
    expect(
      again.findings.profile.filter((finding) => finding.severity === "error"),
    ).toEqual([])
  })

  test("a colour set to the value it has, in another case, stays as written", () => {
    expect(write(source, { "colors.accent-coral": "#e9895e" })).toBe(source)
    expect(write(source, { primary: "#000000" })).toBe(
      edited(source, [`  primary: "{colors.primary}"`, `  primary: "#000000"`]),
    )
  })

  test("adds keys the file lacks, in the style of their mapping", () => {
    const result = write(source, {
      "typography.heading-h1.textTransform": "uppercase",
      "typography.button.fontFamily": "Roboto",
      "typography.new.fontSize": "10px",
      "colors.brand": "#123456",
      "fonts.sans.weights.caption": "500",
    })
    expect(result).toBe(
      edited(
        source,
        [
          "heading-h1:     { fontSize: 36px, fontWeight: 900, lineHeight: 1.1,  letterSpacing: -0.8px }",
          "heading-h1:     { fontSize: 36px, fontWeight: 900, lineHeight: 1.1,  letterSpacing: -0.8px, textTransform: uppercase }",
        ],
        [
          "button:         { fontSize: 14px, fontWeight: 700, lineHeight: 1.0,  letterSpacing: 0 }",
          "button:         { fontSize: 14px, fontWeight: 700, lineHeight: 1.0,  letterSpacing: 0, fontFamily: Roboto }",
        ],
        [
          `  numeric:        { fontVariantNumeric: "tabular-nums" }\n`,
          `  numeric:        { fontVariantNumeric: "tabular-nums" }\n  new:\n    fontSize: "10px"\n`,
        ],
        [
          `  destructive: "{colors.accent-coral}"\n`,
          `  destructive: "{colors.accent-coral}"\n  brand: "#123456"\n`,
        ],
        [
          "      statement: 900   # Main headings, statements, big numbers\n",
          "      statement: 900   # Main headings, statements, big numbers\n      caption: 500\n",
        ],
      ),
    )
  })

  test("writes a role reference as a reference", () => {
    expect(write(source, { accent: "{colors.accent-sky}" })).toBe(
      edited(source, [
        `  accent: "{colors.neutral-100}"`,
        `  accent: "{colors.accent-sky}"`,
      ]),
    )
  })
})

describe("edits on files without the profile", () => {
  const paws = read("./fixtures/google/paws-and-paths.md")

  test("a role the file lacks starts a roles group at the end of the front matter", () => {
    const result = write(paws, { primary: "#ff0000" })
    expect(result).toBe(
      edited(paws, [
        `    padding: "{spacing.xs}"\n---`,
        `    padding: "{spacing.xs}"\nroles:\n  primary: "#ff0000"\n---`,
      ]),
    )
    expect(parseDesign(result).roles.primary).toEqual({ value: "#ff0000" })
  })

  test("an inferred font, once edited, is written with the levels that name it", () => {
    const result = write(paws, {
      "fonts.plus-jakarta-sans.family": "Inter",
      "typography.body-md.textTransform": "none",
    })
    const tokens = result.slice(0, result.indexOf("\n---\n", 4))
    expect(tokens).not.toContain("Plus Jakarta Sans")
    expect(tokens).toContain(
      `    lineHeight: 24px\n    textTransform: "none"\n`,
    )
    expect(result).toContain(
      `fonts:\n  plus-jakarta-sans:\n    family: "Inter"\n    provider: "google"\n    fallback: "system-ui, sans-serif"\n---`,
    )
    const again = parseDesign(result)
    expect(again.fonts["plus-jakarta-sans"]).toMatchObject({
      family: "Inter",
      default: true,
    })
    expect(again.typography["body-md"]).toMatchObject({
      fontFamily: "Inter",
      transform: "none",
    })
  })
})

describe("YAML styles and edge cases", () => {
  test("keeps each scalar's quoting", () => {
    const markdown = [
      "---",
      "name: A",
      "description: >",
      "  Folded",
      "  text.",
      "sizes:",
      "  a: '10px'",
      "  b: 10px",
      '  c: "10px"',
      "spacing:",
      "  '0.5': 2px",
      "---",
      "",
    ].join("\n")
    const result = write(markdown, {
      description: "New text.",
      "sizes.a": "it's 12px",
      "sizes.b": "12px",
      "sizes.c": "12px",
      "spacing.0.5": "3px",
    })
    expect(result).toBe(
      [
        "---",
        "name: A",
        `description: "New text."`,
        "sizes:",
        "  a: 'it''s 12px'",
        "  b: 12px",
        `  c: "12px"`,
        "spacing:",
        "  '0.5': 3px",
        "---",
        "",
      ].join("\n"),
    )
  })

  test("a reference to a font stays while it holds; a level family edit replaces it", () => {
    const markdown =
      '---\nname: A\nfonts:\n  sans: { family: Inter }\ntypography:\n  a: { fontFamily: "{fonts.sans}" }\n---\n'
    expect(write(markdown, { "fonts.sans.family": "Roboto" })).toBe(
      markdown.replace("family: Inter", "family: Roboto"),
    )
    expect(write(markdown, { "typography.a.fontFamily": "Lobster" })).toBe(
      markdown.replace(`"{fonts.sans}"`, `"Lobster"`),
    )
  })

  test("inserts into an empty flow mapping, an empty block and a fence's mapping", () => {
    expect(
      write("---\nname: A\ntypography:\n  x: {}\n---\n", {
        "typography.x.fontSize": "1px",
      }),
    ).toBe("---\nname: A\ntypography:\n  x: { fontSize: 1px }\n---\n")
    const empty = "---\n---\n# Title\n"
    const design = applyOverrides(parseDesign(empty), {
      name: "A",
      "sizes.a": "1px",
    })
    expect(designToMarkdown(empty, design)).toBe(
      `---\nname: "A"\nsizes:\n  a: "1px"\n---\n# Title\n`,
    )
    const fence = "## Colors\n\n```yaml\nname: A\n```\n"
    expect(write(fence, { "sizes.a": "1px" })).toBe(
      `## Colors\n\n\`\`\`yaml\nname: A\nsizes:\n  a: "1px"\n\`\`\`\n`,
    )
  })

  test("adds front matter to a file without YAML", () => {
    const design = applyOverrides(parseDesign("# Title\n"), { name: "A" })
    expect(designToMarkdown("# Title\n", design)).toBe(
      `---\nname: "A"\n---\n\n# Title\n`,
    )
  })

  test("leaves a file whose YAML does not parse, and keys it cannot hold", () => {
    const broken = "---\na: [\n---\n"
    expect(
      designToMarkdown(
        broken,
        applyOverrides(repository, { primary: "#ff0000" }),
      ),
    ).toBe(broken)
    const nested =
      "---\nname: A\nsizes:\n  x: { a: 1 }\ntypography:\n  fontFamily: Inter\n---\n"
    const design = applyOverrides(parseDesign(nested), {
      "sizes.x": "1px",
      "typography.fontFamily.fontSize": "1px",
    })
    expect(designToMarkdown(nested, design)).toBe(nested)
  })
})
