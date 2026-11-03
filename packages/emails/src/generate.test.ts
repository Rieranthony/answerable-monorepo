import { expect, test } from "bun:test"
import { holeNames } from "./holes"
import { generateModule } from "./react"
import { templates } from "./generated/templates.generated"

test("the committed generated file is what the generator writes now", async () => {
  const committed = await Bun.file(
    new URL("./generated/templates.generated.ts", import.meta.url),
  ).text()
  expect(
    (await generateModule()) === committed,
    "src/generated/templates.generated.ts is out of date with the React templates: run `bun run --filter @answerable/emails generate` and commit the file",
  ).toBe(true)
})

test("each template is generated, with its tag and a hole for every value it takes", () => {
  expect(Object.keys(templates).sort()).toEqual(Object.keys(holeNames).sort())
  expect(
    Object.values(templates)
      .map(({ tag }) => tag)
      .sort(),
  ).toEqual(["access-removed", "mailbox-code", "sign-in"])
  for (const [name, { subject, html, text }] of Object.entries(templates)) {
    const holes = holeNames[name as keyof typeof holeNames] as readonly string[]
    for (const part of [subject, html, text]) {
      // A hole the template does not take would reach a person as the literal "{{word}}".
      for (const [, hole] of part.matchAll(/\{\{(\w+)\}\}/g)) {
        expect(holes, `${name}: {{${hole}}}`).toContain(hole!)
      }
    }
    for (const hole of holes) {
      expect(html, `${name}: {{${hole}}} in the HTML`).toContain(`{{${hole}}}`)
    }
  }
})
