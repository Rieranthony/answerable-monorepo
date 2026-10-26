import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { renderToMarkdown } from "fumadocs-core/server"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

import {
  CliErrors,
  CliExitCodes,
  CliReference,
  CliSteps,
  flagRows,
} from "@/components/docs/cli"
import { definitions, exitCodes } from "../../../../scripts/mcp/definitions"
import { errors } from "../../../../scripts/mcp/errors"

const entities: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  "#x27": "'",
}
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, "")
    .replace(/&(amp|lt|gt|quot|#x27);/g, (_, name: string) => entities[name]!)

// The body rows of each form, as plain text: the page's HTML tables, and the `.md` twin's Markdown tables.
const htmlRows = (html: string) =>
  [...html.matchAll(/<tbody>([\s\S]*?)<\/tbody>/g)]
    .flatMap(([, body]) => body!.split("</tr>").slice(0, -1))
    .map((row) =>
      [...row.matchAll(/<td>([\s\S]*?)<\/td>/g)].map(([, cell]) => text(cell!)),
    )
const markdownRows = (markdown: string) =>
  markdown
    .split("\n")
    .filter((line) => line.startsWith("| ") && !line.startsWith("| ---"))
    .map((line) =>
      line
        .slice(2, -2)
        .split(/ (?<!\\)\| /)
        .map((cell) => cell.replace(/\\\|/g, "|").replace(/`/g, "")),
    )
// Every table of the Markdown form begins with its header row, which the HTML form keeps in <thead>.
const bodyOnly = (rows: string[][]) =>
  rows.filter(
    (row) => !["Flag", "Step", "Exit code", "You see"].includes(row[0]!),
  )

const names = Object.keys(definitions) as (keyof typeof definitions)[]

const plain = (rows: string[][]) =>
  rows.map((row) => row.map((cell) => cell.replace(/`/g, "")))

// The page's usage and example are code blocks, which Next renders on the server: the build resolves them. Here, the Markdown
// form carries them, and every table is checked against the definitions in both forms where a table can render without one.
test.each(names)(
  "bun mcp %s renders its usage, summary, flags, steps and example in its Markdown form",
  async (name) => {
    const markdown = await renderToMarkdown(
      createElement(CliReference, { command: name }),
    )
    const command = definitions[name]
    const steps = plain(
      command.steps.map((step) => [step.name, `${step.does}.`]),
    )

    expect(markdown).toContain(command.usage)
    expect(markdown).toContain(command.example)
    expect(markdown.replaceAll("`", "")).toContain(`${command.summary}.`)
    expect(bodyOnly(markdownRows(markdown))).toEqual([
      ...plain(flagRows(command)),
      ...steps,
    ])
    expect(flagRows(command).map((row) => row[0])).toEqual([
      ...Object.keys(command.flags).map((flag) => `\`--${flag}\``),
      "`--help`",
    ])
  },
)

test("a command that does not exist, or a flag or step without a description, fails the page's build", () => {
  const { new: made } = definitions

  expect(() => CliReference({ command: "deploy" as "new" })).toThrow(
    'bun mcp has no command "deploy"; it has new, add tool, list, check, db, setup, dev, help',
  )
  expect(() =>
    flagRows({
      ...made,
      flags: { ...made.flags, extra: { description: " " } },
    }),
  ).toThrow("bun mcp's definitions give new --extra no description")
  expect(() =>
    renderToStaticMarkup(createElement(CliSteps, { command: "new" })),
  ).not.toThrow()
})

test("the steps of a command are one row each, with what each does", async () => {
  const element = createElement(CliSteps, { command: "check" })
  const rows = htmlRows(renderToStaticMarkup(element))

  expect(rows.map((row) => row[0])).toEqual(
    definitions.check.steps.map((step) => step.name),
  )
  expect(bodyOnly(markdownRows(await renderToMarkdown(element)))).toEqual(rows)
})

test("the exit codes are the CLI's, the same in both forms", async () => {
  const element = createElement(CliExitCodes)
  const rows = htmlRows(renderToStaticMarkup(element))

  expect(rows.map((row) => row[0])).toEqual(
    exitCodes.map(({ code }) => String(code)),
  )
  expect(bodyOnly(markdownRows(await renderToMarkdown(element)))).toEqual(rows)
})

test("the errors named by a page are those rows, the same in both forms; without ids every error is listed with its commands", async () => {
  const some = createElement(CliErrors, {
    ids: ["name-taken", "database-down"],
  })
  const rows = htmlRows(renderToStaticMarkup(some))

  expect(rows.map((row) => [row[0], row[1]])).toEqual([
    ["acme is taken by mcps/acme; choose another name", "name-taken"],
    [
      "database failed: the development Postgres does not answer on localhost:47432; start it with bun run env:up from the main checkout",
      "database-failed",
    ],
  ])
  expect(bodyOnly(markdownRows(await renderToMarkdown(some)))).toEqual(rows)

  const all = htmlRows(renderToStaticMarkup(createElement(CliErrors, {})))

  expect(all).toHaveLength(errors.length)
  expect(all.map((row) => row[2])).toContain("Every command")
  expect(() =>
    renderToStaticMarkup(
      createElement(CliErrors, { ids: ["name-taken", "nope"] }),
    ),
  ).toThrow('scripts/mcp/errors.ts has no error "nope"')
})

test("every page names only errors that exist", () => {
  const content = join(import.meta.dir, "../../content/docs")
  const found: string[] = []

  for (const file of new Bun.Glob("**/*.mdx").scanSync({ cwd: content })) {
    const source = readFileSync(join(content, file), "utf8")

    for (const [, list] of source.matchAll(
      /<CliErrors ids=\{\[([^\]]*)\]\}/g,
    )) {
      for (const [, id] of list!.matchAll(/"([^"]+)"/g)) {
        if (!errors.some((row) => row.id === id)) found.push(`${file}: ${id}`)
      }
    }
  }

  expect(found).toEqual([])
})
