"use client"

import { contrast, formatOklch } from "@answerable/design"
import { useDesign } from "@answerable/design/react"
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@answerable/ui/components/table"

import { colourGroups, formatRatio } from "./lib"
import { useTokens } from "./readouts"

/** The neutral scale against the page: tabular, right-aligned figures. */
export function NeutralTable() {
  const { current } = useDesign()
  const background = useTokens().get("background") ?? "#ffffff"
  const neutrals =
    colourGroups(current).find((group) => group.title === "Neutral")?.names ??
    []
  return (
    <Table>
      <TableCaption>The neutral scale against the background.</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead>Token</TableHead>
          <TableHead>Hex</TableHead>
          <TableHead>oklch</TableHead>
          <TableHead numeric>Contrast</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {neutrals.map((name, index) => {
          const { hex } = current.colors[name]!
          const ratio = contrast(hex, background)
          return (
            <TableRow key={name} data-selected={index === 1 || undefined}>
              <TableCell>
                <span className="flex items-center gap-2">
                  <span
                    aria-hidden="true"
                    className="size-3 shrink-0 shadow-xs"
                    style={{ background: hex }}
                  />
                  {name}
                </span>
              </TableCell>
              <TableCell className="type-numeric">{hex}</TableCell>
              <TableCell className="type-numeric">{formatOklch(hex)}</TableCell>
              <TableCell numeric>
                {ratio === null ? "unreadable" : formatRatio(ratio)}
              </TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}

const CHART = [
  "number-display",
  "statement-xl",
  "statement-lg",
  "number-stat",
  "statement-md",
]

/**
 * The statement sizes as bars in the five chart colours: square ends, neutral gridlines, caption labels
 * set directly on each bar, so the meaning never rests on colour alone. The bars are SVG at the page's
 * own pixel scale, so the labels keep their size at any width.
 */
export function SizeChart() {
  const { current } = useDesign()
  const bars = CHART.filter((level) => current.typography[level]?.size).map(
    (level, index) => ({
      level,
      size: parseFloat(current.typography[level]!.size!) || 0,
      label: current.typography[level]!.size!,
      fill: `var(--chart-${index + 1})`,
    }),
  )
  const scale =
    Math.ceil((Math.max(...bars.map((bar) => bar.size), 1) * 1.2) / 20) * 20
  const steps = [0, 0.25, 0.5, 0.75, 1]
  const at = (value: number) => `${(value / scale) * 100}%`
  const gridlines = steps.map((step) => (
    <line
      key={step}
      x1={`${step * 100}%`}
      x2={`${step * 100}%`}
      y1={0}
      y2="100%"
      stroke="var(--border)"
      strokeWidth={1}
    />
  ))
  return (
    <figure className="flex max-w-(--prose-max) flex-col gap-3">
      <div
        role="img"
        aria-label={bars.map((bar) => `${bar.level} ${bar.label}`).join(", ")}
        className="grid grid-cols-[auto_1fr] gap-x-4"
      >
        {bars.map((bar) => (
          <div key={bar.level} className="contents">
            <span className="type-caption self-center">{bar.level}</span>
            <svg aria-hidden="true" className="h-10 w-full overflow-visible">
              {gridlines}
              <rect
                x={0}
                y={8}
                width={at(bar.size)}
                height={24}
                fill={bar.fill}
              />
              <text
                x={at(bar.size)}
                dx={8}
                y={25}
                className="fill-foreground type-caption type-numeric"
              >
                {bar.label}
              </text>
            </svg>
          </div>
        ))}
        <span />
        <svg aria-hidden="true" className="h-6 w-full overflow-visible">
          {steps.map((step) => (
            <text
              key={step}
              x={`${step * 100}%`}
              y={18}
              textAnchor={step === 0 ? "start" : step === 1 ? "end" : "middle"}
              className="fill-muted-foreground type-caption type-numeric"
            >
              {Math.round(step * scale)}
            </text>
          ))}
        </svg>
      </div>
      <figcaption className="type-caption text-muted-foreground">
        Font size of the statement levels, in pixels.
      </figcaption>
    </figure>
  )
}
