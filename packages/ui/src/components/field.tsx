"use client"

import { Field as FieldPrimitive } from "@base-ui/react/field"
import { cn } from "@answerable/ui/lib/utils"

function Field({ className, ...props }: FieldPrimitive.Root.Props) {
  return (
    <FieldPrimitive.Root
      data-slot="field"
      className={cn(
        "group/field flex w-full flex-col gap-2 data-invalid:text-destructive",
        className,
      )}
      {...props}
    />
  )
}

function FieldLabel({
  className,
  nativeLabel,
  render,
  ...props
}: FieldPrimitive.Label.Props) {
  return (
    <FieldPrimitive.Label
      data-slot="field-label"
      nativeLabel={nativeLabel}
      // Base UI expects a non-<label> element when the control is a button.
      render={render ?? (nativeLabel === false ? <span /> : undefined)}
      className={cn(
        "flex w-fit items-center gap-2 text-sm leading-none font-medium select-none group-data-disabled/field:opacity-50",
        className,
      )}
      {...props}
    />
  )
}

function FieldDescription({
  className,
  ...props
}: FieldPrimitive.Description.Props) {
  return (
    <FieldPrimitive.Description
      data-slot="field-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

function FieldError({ className, ...props }: FieldPrimitive.Error.Props) {
  return (
    <FieldPrimitive.Error
      data-slot="field-error"
      className={cn("text-sm font-medium text-destructive", className)}
      {...props}
    />
  )
}

export { Field, FieldLabel, FieldDescription, FieldError }
