"use client"

import type { CSSProperties } from "react"
import { TYPE_PROPERTIES, type TypeLevel } from "@answerable/design"
import { useDesign } from "@answerable/design/react"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@answerable/ui/components/table"

import { PROGRAMME, SPECIMENS } from "./content"
import { weightName } from "./lib"
import { useTokens } from "./readouts"

const CSS_KEYS: Partial<Record<keyof TypeLevel, keyof CSSProperties>> = {
  fontFamily: "fontFamily",
  size: "fontSize",
  weight: "fontWeight",
  leading: "lineHeight",
  tracking: "letterSpacing",
  transform: "textTransform",
  numeric: "fontVariantNumeric",
  feature: "fontFeatureSettings",
  variation: "fontVariationSettings",
}

const safe = (level: string) => level.replace(/[^A-Za-z0-9_-]/g, "-")

/**
 * A level set through its tokens, as the `type-<level>` utility does: a level the stylesheet was not
 * generated with still renders, since every property reads its variable.
 */
function levelStyle(level: string, type: TypeLevel): CSSProperties {
  const style: Record<string, string> = {}
  for (const property of TYPE_PROPERTIES) {
    const key = CSS_KEYS[property.key]
    if (key && type[property.key] !== undefined) {
      style[key] =
        `var(--type-${safe(level)}-${property.suffix}, var(--design-type-${safe(level)}-${property.suffix}))`
    }
  }
  return style as CSSProperties
}

/** Every level of the scale set in itself, with its size, weight, leading and tracking. */
export function TypeSpecimen() {
  const { current } = useDesign()
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Level</TableHead>
          <TableHead>Specimen</TableHead>
          <TableHead numeric>Size</TableHead>
          <TableHead numeric>Weight</TableHead>
          <TableHead numeric>Leading</TableHead>
          <TableHead numeric>Tracking</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {Object.entries(current.typography).map(([level, type]) => (
          <TableRow key={level}>
            <TableCell className="align-top font-mono text-[0.9em]">
              {level}
            </TableCell>
            <TableCell className="min-w-72 whitespace-normal">
              <span
                className="block max-w-(--prose-max)"
                style={levelStyle(level, type)}
              >
                {SPECIMENS[level] ?? level}
              </span>
            </TableCell>
            <TableCell numeric className="align-top">
              {type.size ?? "none"}
            </TableCell>
            <TableCell numeric className="align-top">
              {type.weight ?? "none"}
            </TableCell>
            <TableCell numeric className="align-top">
              {type.leading ?? "none"}
            </TableCell>
            <TableCell numeric className="align-top">
              {type.tracking ?? "none"}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

const WEIGHTS = [
  ["weight-body", "Body text: paragraphs, captions, table cells, inputs"],
  ["weight-label", "Subheadings, labels, buttons, badges"],
  ["weight-statement", "Main headings, statements, big numbers"],
] as const

/** The three weight roles, each set in its weight. */
export function TypeWeights() {
  const tokens = useTokens()
  return (
    <ul className="grid gap-6 md:grid-cols-3">
      {WEIGHTS.map(([token, use]) => (
        <li key={token} className="bg-muted flex flex-col gap-2 p-6">
          <span
            className="type-heading-h1"
            style={{ fontWeight: `var(--${token})` }}
          >
            {weightName(tokens.get(token) ?? "")}
          </span>
          <span className="type-body-sm text-muted-foreground">{use}</span>
        </li>
      ))}
    </ul>
  )
}

/** Running text at the reading width. */
export function ProseMeasure() {
  return (
    <div className="type-body-md flex max-w-(--prose-max) flex-col gap-4">
      {PROGRAMME.role.map((paragraph) => (
        <p key={paragraph}>{paragraph}</p>
      ))}
    </div>
  )
}
