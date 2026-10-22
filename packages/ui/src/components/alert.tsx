import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@answerable/ui/lib/utils"

/*
 * The muted fill with an 8px square marker beside the bold title: the
 * semantic colour carries the type, the title and text carry the meaning.
 */
const alertVariants = cva(
  "group/alert relative grid w-full gap-1 rounded-lg bg-muted p-4 text-left type-ui-text text-foreground has-data-[slot=alert-action]:pr-16",
  {
    variants: {
      variant: {
        default: "[--alert-marker:var(--foreground)]",
        success: "[--alert-marker:var(--success)]",
        warning: "[--alert-marker:var(--warning)]",
        info: "[--alert-marker:var(--info)]",
        destructive: "[--alert-marker:var(--destructive)]",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
)

function Alert({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  return (
    <div
      data-slot="alert"
      data-variant={variant}
      role="alert"
      className={cn(alertVariants({ variant }), className)}
      {...props}
    />
  )
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-title"
      className={cn(
        "flex items-start gap-3 type-label before:mt-[calc(0.5lh---spacing(1))] before:size-2 before:shrink-0 before:bg-(--alert-marker) before:content-[''] [&_a]:underline [&_a]:decoration-2 [&_a]:underline-offset-4",
        className,
      )}
      {...props}
    />
  )
}

function AlertDescription({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-description"
      className={cn(
        "pl-5 type-ui-text text-balance text-foreground md:text-pretty [&_a]:underline [&_a]:decoration-2 [&_a]:underline-offset-4 [&_p:not(:last-child)]:mb-4",
        className,
      )}
      {...props}
    />
  )
}

function AlertAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-action"
      className={cn("absolute top-3 right-3", className)}
      {...props}
    />
  )
}

export { Alert, AlertTitle, AlertDescription, AlertAction }
