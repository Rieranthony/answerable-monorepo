import { asMarkdown } from "fumadocs-core/server"
import type { ReactNode } from "react"

import { Inline } from "@/components/docs/inline"
import { markdownTable } from "@/lib/docs/markdown"

/**
 * A table whose cells are inline Markdown (code spans and links), as HTML on the page and as a Markdown table in its
 * `.md` twin: the same rows, so both forms carry the same words. A plain function, not a component: `asMarkdown()`
 * opts in the component that calls it, so the block that renders the table calls this in its own render.
 */
export function dataTable({
  headers,
  rows,
}: {
  headers: string[]
  rows: string[][]
}): ReactNode {
  if (asMarkdown()) return `${markdownTable(headers, rows)}\n\n`

  return (
    <div className="prose-no-margin relative my-6 overflow-auto">
      <table>
        <thead>
          <tr>
            {headers.map((header) => (
              <th key={header}>
                <Inline text={header} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row[0]}>
              {row.map((text, index) => (
                <td key={index}>
                  <Inline text={text} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
