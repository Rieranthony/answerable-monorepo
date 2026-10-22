"use client"

import { formatOklch } from "@answerable/design"
import { useDesign } from "@answerable/design/react"
import { Badge } from "@answerable/ui/components/badge"
import {
  Stat,
  StatLabel,
  StatValue,
} from "@answerable/ui/components/statement/stat"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@answerable/ui/components/table"

import {
  TEXT_PAIRS,
  colourGroups,
  formatRatio,
  verdict,
  type Accent,
} from "./lib"
import { useTokens } from "./readouts"
import { ShowcaseGroup } from "./section"

/** The file's colours as swatches, grouped, with hex and oklch; they follow every edit. */
export function ColourSwatches() {
  const { current } = useDesign()
  return (
    <div className="flex flex-col gap-10">
      {colourGroups(current).map((group) => (
        <ShowcaseGroup key={group.title} title={group.title}>
          <ul className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-4 lg:grid-cols-6">
            {group.names.map((name) => {
              const { hex } = current.colors[name]!
              const reference = current.refs[`colors.${name}`]
              return (
                <li key={name} className="flex flex-col gap-2">
                  <span
                    aria-hidden="true"
                    className="h-12 shadow-xs"
                    style={{ background: hex }}
                  />
                  <span className="flex flex-col">
                    <span className="type-label">{name}</span>
                    <span className="type-ui-text type-numeric">{hex}</span>
                    <span className="type-caption text-muted-foreground type-numeric">
                      {formatOklch(hex)}
                    </span>
                    {reference && (
                      <span className="type-caption text-muted-foreground">
                        = {reference.replace(/^colors\./, "")}
                      </span>
                    )}
                  </span>
                </li>
              )
            })}
          </ul>
        </ShowcaseGroup>
      ))}
    </div>
  )
}

/** Every text-on-fill pair of the roles, with its contrast and WCAG verdict. */
export function ContrastTable() {
  const tokens = useTokens()
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Text on fill</TableHead>
          <TableHead>Sample</TableHead>
          <TableHead numeric>Contrast</TableHead>
          <TableHead>Normal text</TableHead>
          <TableHead>Large text</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {TEXT_PAIRS.map(([text, fill]) => {
          const result = verdict(tokens.get(text) ?? "", tokens.get(fill) ?? "")
          return (
            <TableRow key={`${text}/${fill}`}>
              <TableCell>
                {text} <span className="text-muted-foreground">on</span> {fill}
              </TableCell>
              <TableCell>
                <span
                  className="type-label inline-flex h-(--control-sm) items-center px-3"
                  style={{
                    background: `var(--${fill})`,
                    color: `var(--${text})`,
                  }}
                >
                  Aa
                </span>
              </TableCell>
              <TableCell numeric>
                {result ? formatRatio(result.ratio) : "unreadable"}
              </TableCell>
              <TableCell>{result?.level ?? "none"}</TableCell>
              <TableCell>{result?.large ?? "none"}</TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}

/** The rotation in four stats, from the file's own rules, sharing the section's accent. */
export function RotationStats({ accent }: { accent: Accent }) {
  const tokens = useTokens()
  const weakest = ([1, 2, 3, 4] as const)
    .map((n) =>
      verdict(
        tokens.get("on-accent") ?? "",
        tokens.get(`highlight-${n}`) ?? "",
      ),
    )
    .reduce<number | null>(
      (lowest, result) =>
        result && (lowest === null || result.ratio < lowest)
          ? result.ratio
          : lowest,
      null,
    )
  const stats = [
    ["4", "accents of equal status; none is the default"],
    ["1", "accent per section or slide, charts excepted"],
    ["3", "sections in a row with one accent is a mistake"],
    [
      weakest === null ? "none" : `${weakest.toFixed(1)}:1`,
      "the lowest contrast of accent text on an accent fill",
    ],
  ] as const
  return (
    <div className="flex flex-col gap-6">
      <ol className="flex flex-wrap gap-2" aria-label="Rotation order">
        {([1, 2, 3, 4] as const).map((n) => (
          <li key={n}>
            <Badge highlight={n}>
              {n}. <RoleName role={`highlight-${n}`} />
            </Badge>
          </li>
        ))}
      </ol>
      <div className="grid grid-cols-2 gap-8 md:grid-cols-4">
        {stats.map(([value, label]) => (
          <Stat key={label}>
            <StatValue highlight={accent}>{value}</StatValue>
            <StatLabel>{label}</StatLabel>
          </Stat>
        ))}
      </div>
    </div>
  )
}

/** The colour a role is bound to, by its name in the file: `accent-sky` for `highlight-1`. */
function RoleName({ role }: { role: `highlight-${1 | 2 | 3 | 4}` }) {
  const { current } = useDesign()
  return <>{current.roles[role].ref?.replace(/^colors\./, "") ?? role}</>
}
