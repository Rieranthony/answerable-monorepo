// Fumadocs UI components for MDX, each with a Markdown form: `asMarkdown()` is true while a page renders into its `.md`
// twin (and llms-full.txt), so agents read a table or a list, not JSX. These are server components on purpose: client
// components cannot opt in.
import { asMarkdown, md } from "fumadocs-core/server"
import { Callout as UiCallout } from "fumadocs-ui/components/callout"
import { Card as UiCard, Cards as UiCards } from "fumadocs-ui/components/card"
import { Step as UiStep, Steps as UiSteps } from "fumadocs-ui/components/steps"
import { Tab as UiTab, Tabs as UiTabs } from "fumadocs-ui/components/tabs"
import { createGenerator } from "fumadocs-typescript"
import type { ReactNode } from "react"

import { dataTable } from "@/components/docs/table"
import {
  numberSteps,
  typeTableHeaders,
  typeTableRows,
} from "@/lib/docs/markdown"

type Children = { children?: ReactNode }

export async function Steps({ children }: Children) {
  if (asMarkdown()) return numberSteps(await md`${children}`)

  return <UiSteps>{children}</UiSteps>
}

export function Step({ children }: Children) {
  if (asMarkdown()) return md`${children}`

  return <UiStep>{children}</UiStep>
}

export function Callout({
  title,
  type,
  children,
}: Children & {
  title?: string
  type?: "info" | "warn" | "error" | "success" | "idea"
}) {
  if (asMarkdown()) {
    return md.linePrefix("> ")`${title ? `**${title}** ` : ""}${children}`
  }

  return (
    <UiCallout title={title} type={type}>
      {children}
    </UiCallout>
  )
}

export function Cards({ children }: Children) {
  if (asMarkdown()) return md`${children}\n`

  return <UiCards>{children}</UiCards>
}

export function Card({
  title,
  href,
  description,
}: {
  title: string
  href: string
  description?: string
}) {
  if (asMarkdown()) {
    return `- [${title}](${href})${description ? `: ${description}` : ""}\n`
  }

  return <UiCard title={title} href={href} description={description} />
}

export function Tabs({ items, children }: Children & { items: string[] }) {
  if (asMarkdown()) return md`${children}`

  return <UiTabs items={items}>{children}</UiTabs>
}

export function Tab({ value, children }: Children & { value: string }) {
  if (asMarkdown()) return md`**${value}**\n\n${children}\n\n`

  return <UiTab value={value}>{children}</UiTab>
}

// One TypeScript project for every table. No file-system cache: its key covers only the named file, so a change to a
// type it imports would be served stale.
const generator = createGenerator()

/**
 * A table of a TypeScript type's fields, read from the source and its doc comments by fumadocs-typescript when the page
 * builds. `path` is relative to apps/web; `type` is a type expression evaluated in that file, named `name`. The page and
 * its `.md` twin render the same rows, every description visible: Fumadocs' own type table hides descriptions until a
 * row is opened, so the two forms would differ.
 */
export async function AutoTypeTable({
  path,
  name,
  type,
}: {
  path: string
  name: string
  type?: string
}) {
  const docs = await generator.generateTypeTable({ path, name, type })

  return dataTable({
    headers: typeTableHeaders,
    rows: typeTableRows(docs.flatMap((doc) => doc.entries)),
  })
}
