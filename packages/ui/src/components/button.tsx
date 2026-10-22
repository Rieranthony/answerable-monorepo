import { Button as ButtonPrimitive } from "@base-ui/react/button"
import type { VariantProps } from "class-variance-authority"

import { buttonVariants } from "@answerable/ui/lib/button"
import { cn } from "@answerable/ui/lib/utils"

function Button({
  className,
  variant = "default",
  // The accent button is the statement call to action: 48px unless sized.
  size = variant === "accent" ? "xl" : "default",
  highlight,
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      data-variant={variant}
      className={cn(buttonVariants({ variant, size, highlight, className }))}
      {...props}
    />
  )
}

export { Button }
