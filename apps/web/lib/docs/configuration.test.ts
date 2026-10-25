import { expect, test } from "bun:test"
import { renderToMarkdown } from "fumadocs-core/server"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

import { Configuration } from "@/components/docs/generated"
import inventory from "../../../../packages/config/inventory.json"
import { configurationRow, configurationRows } from "./configuration"

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

// The body rows of each form, as plain text: the page's HTML table, and the `.md` twin's Markdown table.
const htmlRows = (html: string) =>
  [...html.matchAll(/<tbody>([\s\S]*)<\/tbody>/g)]
    .flatMap(([, body]) => body!.split("</tr>").slice(0, -1))
    .map((row) =>
      [...row.matchAll(/<td>(.*?)<\/td>/g)].map(([, cell]) => text(cell!)),
    )
const markdownRows = (markdown: string) =>
  markdown
    .split("\n")
    .filter((line) => line.startsWith("| "))
    .slice(2)
    .map((line) =>
      line
        .slice(2, -2)
        .split(/ (?<!\\)\| /)
        .map((cell) => cell.replace(/\\\|/g, "|").replace(/`/g, "")),
    )

test("every inventory group renders one row per variable, the same in the page and its Markdown form", async () => {
  for (const { name, fields } of inventory) {
    const element = createElement(Configuration, { group: name })
    const page = htmlRows(renderToStaticMarkup(element))
    const markdown = markdownRows(await renderToMarkdown(element))

    expect(
      page.map((row) => row[0]),
      name,
    ).toEqual(fields.map((field) => field.name))
    expect(markdown, name).toEqual(page)
  }
})

test("several groups make one table, each variable once under the first group that reads it", () => {
  const rows = configurationRows([
    "Toolbox",
    "Toolbox migration",
    "Toolbox test database",
  ])
  const names = rows.map((row) => row[0])

  expect(names.filter((name) => name === "`NODE_ENV`")).toHaveLength(1)
  expect(names.slice(-3)).toEqual([
    "`TOOLBOX_DATABASE_MIGRATION_URL`",
    "`TOOLBOX_DATABASE_RUNTIME_ROLE`",
    "`TOOLBOX_TEST_DATABASE_URL`",
  ])
})

test("an unknown group fails the page's build, naming the groups there are", () => {
  expect(() => configurationRows("toolbox")).toThrow(
    'packages/config/inventory.json has no group "toolbox"; it has "ID", ',
  )
})

test("a row says what the variable defaults to and where a deployment's value comes from", () => {
  const field = {
    name: "ACME_URL",
    secret: false,
    doc: "The URL",
    optional: false,
  }

  expect(configurationRow({ ...field, fallback: "47600" })).toEqual([
    "`ACME_URL`",
    "No",
    "`47600`",
    "Not set",
    "The URL",
  ])
  expect(configurationRow({ ...field, fallback: "", optional: true })[2]).toBe(
    "Empty",
  )
  expect(
    configurationRow({ ...field, secret: true, source: "deploy" }).slice(1, 4),
  ).toEqual(["Yes", "Required", "The deploy step, from the GitHub environment"])
  expect(configurationRow({ ...field, optional: true })[2]).toBe("Optional")
  expect(
    configurationRow({
      ...field,
      defaults: { development: "a", test: "a" },
    })[2],
  ).toBe("`a` locally; required in production")
  expect(
    configurationRow({
      ...field,
      optional: true,
      defaults: { development: "a", test: "b" },
    })[2],
  ).toBe("`a` in development, `b` in test; optional in production")
})
