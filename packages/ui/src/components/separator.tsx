"use client"

import { Separator as SeparatorPrimitive } from "@base-ui/react/separator"
import { cn } from "@answerable/ui/lib/utils"

/** The interface separator: a 1px neutral line between rows or groups, never around anything. */
function Separator({
  className,
  orientation = "horizontal",
  ...props
}: SeparatorPrimitive.Props) {
  return (
    <SeparatorPrimitive
      data-slot="separator"
      orientation={orientation}
      className={cn(
        "shrink-0 bg-(--line-separator-color) data-horizontal:h-(--line-separator-width) data-horizontal:w-full data-vertical:w-(--line-separator-width) data-vertical:self-stretch",
        className,
      )}
      {...props}
    />
  )
}

export { Separator }
