"use client"

import { Toggle as TogglePrimitive } from "@base-ui/react/toggle"
import { ToggleGroup as ToggleGroupPrimitive } from "@base-ui/react/toggle-group"
import { cn } from "@answerable/ui/lib/utils"

/**
 * A segmented control in the tabs' look: the group on the muted fill, the
 * pressed item lifted to the page colour at xs elevation.
 */
function ToggleGroup({
  className,
  orientation = "horizontal",
  ...props
}: ToggleGroupPrimitive.Props) {
  return (
    <ToggleGroupPrimitive
      data-slot="toggle-group"
      data-orientation={orientation}
      orientation={orientation}
      className={cn(
        "group/toggle-group flex w-fit items-center gap-1 rounded-lg bg-muted p-1 data-vertical:flex-col data-vertical:items-stretch",
        className,
      )}
      {...props}
    />
  )
}

function ToggleGroupItem({ className, ...props }: TogglePrimitive.Props) {
  return (
    <TogglePrimitive
      data-slot="toggle-group-item"
      className={cn(
        "inline-flex h-(--control-sm) min-w-(--control-sm) shrink-0 items-center justify-center gap-2 rounded-lg px-3 type-nav-link whitespace-nowrap text-muted-foreground transition-[color,background-color,box-shadow] duration-fast outline-none hover:text-foreground focus-visible:z-10 focus-visible:focus-ring disabled:pointer-events-none disabled:opacity-50 data-pressed:bg-background data-pressed:type-nav-link-active data-pressed:text-foreground data-pressed:shadow-xs [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    />
  )
}

export { ToggleGroup, ToggleGroupItem }
