"use client"

import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@answerable/ui/lib/utils"

const badgeVariants = cva(
  "group/badge inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-lg bg-secondary px-2 py-1 type-badge whitespace-nowrap text-secondary-foreground transition-[color,background-color,opacity] duration-fast outline-none focus-visible:focus-ring [&>svg]:pointer-events-none [&>svg]:size-3!",
  {
    variants: {
      /** An accent fill, in rotation order (Sky, Yellow, Green, Coral by default), with on-accent text. */
      highlight: {
        1: "bg-highlight-1 text-on-accent",
        2: "bg-highlight-2 text-on-accent",
        3: "bg-highlight-3 text-on-accent",
        4: "bg-highlight-4 text-on-accent",
      },
    },
  },
)

function Badge({
  className,
  highlight,
  render,
  ...props
}: useRender.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(
      {
        className: cn(badgeVariants({ highlight }), className),
      },
      props,
    ),
    render,
    state: {
      slot: "badge",
      highlight,
    },
  })
}

export { Badge, badgeVariants }
