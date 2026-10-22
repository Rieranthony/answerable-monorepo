"use client"

import { Switch as SwitchPrimitive } from "@base-ui/react/switch"
import { cn } from "@answerable/ui/lib/utils"

/** A square 36×20 track, the separator fill off and the foreground on, with a 16px thumb at xs elevation. */
function Switch({ className, ...props }: SwitchPrimitive.Root.Props) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer group/switch relative inline-flex h-5 w-9 shrink-0 items-center rounded-lg p-0.5 transition-colors duration-fast outline-none after:absolute after:-inset-x-3 after:-inset-y-2 focus-visible:focus-ring data-checked:bg-foreground data-unchecked:bg-border data-disabled:cursor-not-allowed data-disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none block size-4 rounded-lg bg-background shadow-xs transition-transform duration-fast data-checked:translate-x-4 data-unchecked:translate-x-0"
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
