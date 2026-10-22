import * as React from "react"
import { cn } from "@answerable/ui/lib/utils"

/** A milestone number for reports: 96px Black over a Regular lead label. */
function StatDisplay({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="stat-display"
      className={cn("flex flex-col items-start gap-4", className)}
      {...props}
    />
  )
}

function StatDisplayValue({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="stat-display-value"
      className={cn("type-number-display type-numeric", className)}
      {...props}
    />
  )
}

function StatDisplayLabel({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="stat-display-label"
      className={cn("max-w-(--prose-max) type-lead", className)}
      {...props}
    />
  )
}

export { StatDisplay, StatDisplayValue, StatDisplayLabel }
