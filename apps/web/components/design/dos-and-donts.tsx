import { Card } from "@answerable/ui/components/card"

import { Prose } from "./prose"

/** The `###` subsections of a section's Markdown, each with its own body. */
export function subsections(markdown: string) {
  return markdown
    .split(/^### /m)
    .slice(1)
    .map((part) => {
      const [title = "", ...body] = part.split("\n")
      return { title: title.trim(), body: body.join("\n").trim() }
    })
}

/** The file's own lists, side by side: what to do, and what not to. */
export function DosAndDonts({ markdown }: { markdown: string }) {
  const columns = subsections(markdown)
  if (columns.length === 0) return <Prose markdown={markdown} />
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      {columns.map(({ title, body }) => (
        <Card key={title} variant="muted">
          <h3 className="type-heading-h2">{title}</h3>
          <Prose markdown={body} className="type-body-sm" />
        </Card>
      ))}
    </div>
  )
}
