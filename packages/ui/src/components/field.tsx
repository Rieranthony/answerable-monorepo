"use client"

import { Field as FieldPrimitive } from "@base-ui/react/field"
import { cn } from "@answerable/ui/lib/utils"

function Field({ className, ...props }: FieldPrimitive.Root.Props) {
  return (
    <FieldPrimitive.Root
      data-slot="field"
      className={cn("group/field flex w-full flex-col gap-2", className)}
      {...props}
    />
  )
}

/** The label, with a 4px square destructive marker beside it while the field is invalid. */
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
        "flex w-fit items-center gap-2 type-label text-foreground select-none group-data-disabled/field:opacity-50 after:hidden after:size-1 after:shrink-0 after:bg-destructive after:content-[''] group-data-invalid/field:after:block",
        className,
      )}
      {...props}
    />
  )
}

/** Helper text beneath the control. */
function FieldDescription({
  className,
  ...props
}: FieldPrimitive.Description.Props) {
  return (
    <FieldPrimitive.Description
      data-slot="field-description"
      className={cn("-mt-0.5 type-caption text-muted-foreground", className)}
      {...props}
    />
  )
}

/** The error message: helper text in the foreground colour, never coloured. */
function FieldError({ className, ...props }: FieldPrimitive.Error.Props) {
  return (
    <FieldPrimitive.Error
      data-slot="field-error"
      className={cn("-mt-0.5 type-caption text-foreground", className)}
      {...props}
    />
  )
}

export { Field, FieldLabel, FieldDescription, FieldError }
