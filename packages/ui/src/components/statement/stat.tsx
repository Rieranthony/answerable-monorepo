import * as React from "react"
import { cn } from "@answerable/ui/lib/utils"

const highlights = {
  1: "bg-highlight-1",
  2: "bg-highlight-2",
  3: "bg-highlight-3",
  4: "bg-highlight-4",
} as const

/**
 * A headline metric: a 48px Black number over a muted body-sm label. Use one
 * to four in a row; give them one shared highlight or none.
 */
function Stat({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="stat"
      className={cn("flex flex-col items-start gap-2", className)}
      {...props}
    />
  )
}

/** The number, in tabular figures; `highlight` (rotation order, 1 to 4) sets a square accent block behind it. */
function StatValue({
  className,
  highlight,
  ...props
}: React.ComponentProps<"div"> & { highlight?: keyof typeof highlights }) {
  return (
    <div
      data-slot="stat-value"
      data-highlight={highlight}
      className={cn(
        "type-number-stat type-numeric",
        highlight && [
          "rounded-lg px-2 py-1 text-on-accent",
          highlights[highlight],
        ],
        className,
      )}
      {...props}
    />
  )
}

function StatLabel({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="stat-label"
      className={cn("type-body-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

export { Stat, StatValue, StatLabel }
