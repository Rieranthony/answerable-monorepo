import * as React from "react"
import { cn } from "@answerable/ui/lib/utils"

const weights = {
  standard: "h-(--line-statement-width)",
  emphasis: "h-(--line-statement-emphasis-width)",
  heavy: "h-(--line-statement-heavy-width)",
} as const

/**
 * A full-width editorial break for statement pages and slides: 2px
 * (`standard`), 3px (`emphasis`, the default) or 4px (`heavy`), black. Never
 * inside dense interface areas; use `Separator` there.
 */
function StatementDivider({
  className,
  weight = "emphasis",
  ...props
}: React.ComponentProps<"hr"> & { weight?: keyof typeof weights }) {
  return (
    <hr
      data-slot="statement-divider"
      data-weight={weight}
      className={cn(
        "w-full shrink-0 border-0 bg-(--line-statement-color)",
        weights[weight],
        className,
      )}
      {...props}
    />
  )
}

export { StatementDivider }
