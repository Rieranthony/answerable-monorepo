// The reference of `bun mcp`, rendered from the CLI's own definitions (scripts/mcp/definitions.ts and errors.ts), so a page
// cannot say what the CLI does not. A command or flag without a description fails the page's build. Each block has a
// Markdown form: `asMarkdown()` is true while a page renders into its `.md` twin.
import { asMarkdown } from "fumadocs-core/server"
import { Fragment, type ReactNode } from "react"

import { codeBlock } from "@/components/docs/generated"
import { Inline } from "@/components/docs/inline"
import { dataTable } from "@/components/docs/table"

import {
  definitions,
  exitCodes,
  helpFlag,
  type Definition,
  type Flag,
} from "../../../../scripts/mcp/definitions"
import { errors, type ErrorRow } from "../../../../scripts/mcp/errors"

type CommandName = keyof typeof definitions

/** A placeholder such as `<name>` outside a code span becomes one, so that neither form reads it as a tag. */
const safe = (text: string) =>
  text
    .split(/(`[^`]*`)/)
    .map((part, index) =>
      index % 2
        ? part
        : part.replace(/[\w./-]*(?:<[^>\s]+>[\w./_-]*)+/g, "`$&`"),
    )
    .join("")

function paragraph(text: string): ReactNode {
  if (asMarkdown()) return `${safe(text)}\n\n`

  return (
    <p>
      <Inline text={safe(text)} />
    </p>
  )
}

function described(text: string | undefined, what: string): string {
  if (!text?.trim())
    throw new Error(`bun mcp's definitions give ${what} no description`)

  return text
}

/** Every flag of a command, with what it takes, what it is left out and what it does; `--help` is every command's. */
export function flagRows(command: Definition): string[][] {
  const flags: Record<string, Flag> = { ...command.flags, ...helpFlag }

  return Object.entries(flags).map(
    ([flag, { value, description, default: fallback }]) => [
      `\`--${flag}\``,
      value ? `\`${value}\`` : "Nothing",
      safe(fallback ?? ""),
      safe(`${described(description, `${command.name} --${flag}`)}.`),
    ],
  )
}

function stepsTable(command: Definition): ReactNode {
  return dataTable({
    headers: ["Step", "What it does"],
    rows: command.steps.map((step) => [
      `\`${step.name}\``,
      safe(`${described(step.does, `${command.name} ${step.name}`)}.`),
    ]),
  })
}

function known(command: string): CommandName {
  if (!(command in definitions)) {
    throw new Error(
      `bun mcp has no command "${command}"; it has ${Object.keys(definitions).join(", ")}`,
    )
  }

  return command as CommandName
}

function section(name: CommandName): ReactNode[] {
  const command: Definition = definitions[name]
  const parts: ReactNode[] = [
    codeBlock({ code: command.usage, lang: "sh", title: "usage" }),
    paragraph(`${described(command.summary, command.name)}.`),
    dataTable({
      headers: ["Flag", "Takes", "Default", "What it does"],
      rows: flagRows(command),
    }),
  ]

  if (command.steps.length) parts.push(stepsTable(command))
  parts.push(
    codeBlock({
      code: described(command.example, command.name),
      lang: "sh",
      title: "example",
    }),
  )

  return parts
}

function compose(parts: ReactNode[]): ReactNode {
  if (asMarkdown()) return parts.join("")

  return parts.map((part, index) => <Fragment key={index}>{part}</Fragment>)
}

/** A command's usage, summary, every flag, every step it prints and an example, from the CLI's definitions. */
export function CliReference({ command }: { command: CommandName }) {
  return compose(section(known(command)))
}

/** The steps a command prints, in order, each with what it does: `ok      <step>  <detail>`. */
export function CliSteps({ command }: { command: CommandName }) {
  return stepsTable(definitions[known(command)])
}

/** What each exit code of `bun mcp` says. */
export function CliExitCodes() {
  return dataTable({
    headers: ["Exit code", "Meaning"],
    rows: exitCodes.map(({ code, meaning }) => [`\`${code}\``, safe(meaning)]),
  })
}

const rowFor = (row: ErrorRow, withCommands: boolean) => [
  `\`${row.see}\``,
  `\`${row.code}\``,
  ...(withCommands
    ? [
        row.commands.length === Object.keys(definitions).length
          ? "Every command"
          : row.commands.map((name) => `\`${name}\``).join(", "),
      ]
    : []),
  safe(row.meaning),
  safe(row.action),
]

/**
 * Errors of `bun mcp`: the rows named by `ids`, as you see, what it means and what to do, or without `ids` every error with
 * its code and the commands that answer it. Each row's text is held to what the real command prints, by scripts/mcp/errors.test.ts.
 */
export function CliErrors({ ids }: { ids?: string[] }) {
  const rows = ids
    ? ids.map((id) => {
        const row = errors.find((candidate) => candidate.id === id)

        if (!row) throw new Error(`scripts/mcp/errors.ts has no error "${id}"`)

        return row
      })
    : errors
  const withCommands = !ids

  return dataTable({
    headers: [
      "You see",
      "Code",
      ...(withCommands ? ["Commands"] : []),
      "What it means",
      "What to do",
    ],
    rows: rows.map((row) => rowFor(row, withCommands)),
  })
}
