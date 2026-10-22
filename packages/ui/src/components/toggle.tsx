"use client"

import { Toggle as TogglePrimitive } from "@base-ui/react/toggle"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@answerable/ui/lib/utils"

/** A ghost button that holds a state: the accent fill on hover, the separator fill while pressed. */
const toggleVariants = cva(
  "group/toggle inline-flex items-center justify-center gap-2 rounded-lg type-button whitespace-nowrap text-foreground transition-[color,background-color] duration-fast outline-none hover:bg-accent hover:text-accent-foreground focus-visible:focus-ring disabled:pointer-events-none disabled:opacity-50 data-pressed:bg-border data-pressed:text-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      size: {
        sm: "h-(--control-sm) min-w-(--control-sm) px-2",
        default: "h-(--control-md) min-w-(--control-md) px-3",
        lg: "h-(--control-lg) min-w-(--control-lg) px-4",
      },
    },
    defaultVariants: {
      size: "default",
    },
  },
)

function Toggle({
  className,
  size = "default",
  ...props
}: TogglePrimitive.Props & VariantProps<typeof toggleVariants>) {
  return (
    <TogglePrimitive
      data-slot="toggle"
      className={cn(toggleVariants({ size, className }))}
      {...props}
    />
  )
}

export { Toggle, toggleVariants }
