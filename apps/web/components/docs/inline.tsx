import Link from "fumadocs-core/link"
import type { ReactNode } from "react"

const token = /`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)/g

/** Render inline Markdown (code spans and links, nothing else) written in TypeScript data for a generated table. */
export function Inline({ text }: { text: string }) {
  const parts: ReactNode[] = []
  let last = 0

  for (const match of text.matchAll(token)) {
    parts.push(text.slice(last, match.index))
    parts.push(
      match[1] !== undefined ? (
        <code key={match.index}>{match[1]}</code>
      ) : (
        <Link key={match.index} href={match[3]}>
          {match[2]}
        </Link>
      ),
    )
    last = match.index + match[0].length
  }
  parts.push(text.slice(last))

  return <>{parts}</>
}
