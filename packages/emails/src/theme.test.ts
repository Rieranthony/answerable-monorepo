import { expect, test } from "bun:test"
import { Glob } from "bun"
import { colour, fontFamily, weight } from "./theme"

// The root DESIGN.md's front matter: the tokens the palette and the type must equal.
const designMd = await Bun.file(
  new URL("../../../DESIGN.md", import.meta.url),
).text()
const design = Bun.YAML.parse(
  designMd.match(/^---\n([\s\S]*?)\n---\n/)![1]!,
) as {
  colors: Record<string, string>
  fonts: {
    sans: { family: string; weights: Record<string, number>; fallback: string }
  }
}

// A token may name another: `muted: "{colors.neutral-100}"`.
const token = (name: string): string => {
  const value = design.colors[name]!
  const reference = value.match(/^\{colors\.(.+)\}$/)
  return reference ? token(reference[1]!) : value
}

test("every colour is the DESIGN.md token it names", () => {
  expect<Record<string, string>>(colour).toEqual({
    background: token("background"),
    foreground: token("foreground"),
    onDark: token("on-dark"),
    surface: token("muted"),
    separator: token("separator"),
    mutedForeground: token("muted-foreground"),
  })
})

test("the bold weight is DESIGN.md's", () => {
  expect<number | undefined>(weight.label).toBe(design.fonts.sans.weights.label)
})

test("the font stack starts with DESIGN.md's family, holds its fallback, and has no double quote", () => {
  const { family, fallback } = design.fonts.sans
  expect(fontFamily).toStartWith(`'${family}', `)
  for (const generic of fallback.split(", "))
    expect(fontFamily).toContain(generic)
  expect(fontFamily).toEndWith(fallback.split(", ").at(-1)!)
  expect(fontFamily).not.toContain('"')
})

test("every template file sets its own JSX runtime, whatever the consumer's tsconfig says", async () => {
  const files = [
    ...new Glob("*.tsx").scanSync({ cwd: import.meta.dir }),
  ].filter((file) => !file.endsWith(".test.tsx"))
  expect(files.length).toBeGreaterThan(0)
  for (const file of files) {
    expect(
      await Bun.file(`${import.meta.dir}/${file}`).text(),
      file,
    ).toStartWith("/** @jsxImportSource react */\n")
  }
})
