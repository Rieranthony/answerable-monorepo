import { cn } from "@answerable/ui/lib/utils"

/** A key on the muted fill in the badge level; on the tooltip's dark surface it takes the on-dark colour. */
function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "pointer-events-none inline-flex h-5 w-fit min-w-5 items-center justify-center gap-1 rounded-lg bg-muted px-1 font-sans type-badge text-foreground select-none in-data-[slot=tooltip-content]:bg-on-dark/20 in-data-[slot=tooltip-content]:text-on-dark [&_svg:not([class*='size-'])]:size-3",
        className,
      )}
      {...props}
    />
  )
}

function KbdGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <kbd
      data-slot="kbd-group"
      className={cn("inline-flex items-center gap-1", className)}
      {...props}
    />
  )
}

export { Kbd, KbdGroup }
