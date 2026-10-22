import * as React from "react"
import { cn } from "@answerable/ui/lib/utils"

/**
 * A statement list: an `<ol>` without native markers, each item numbered by a
 * CSS counter in the list-marker level (one marker per item, all one size),
 * beside a Bold H3 title and Regular body, 24px apart. The numerals share one
 * column across items, so titles align from 1 to 10.
 */
function NumberedSteps({ className, ...props }: React.ComponentProps<"ol">) {
  return (
    <ol
      data-slot="numbered-steps"
      // `list-style: none` drops list semantics in Safari; the role restores them.
      role="list"
      className={cn(
        "grid list-none grid-cols-[auto_1fr] gap-x-6 gap-y-6 [counter-reset:numbered-step]",
        className,
      )}
      {...props}
    />
  )
}

function NumberedStep({ className, ...props }: React.ComponentProps<"li">) {
  return (
    <li
      data-slot="numbered-step"
      className={cn(
        "col-span-2 grid grid-cols-subgrid content-start gap-y-2 [counter-increment:numbered-step] before:row-span-2 before:type-list-marker before:type-numeric before:content-[counter(numbered-step)]",
        className,
      )}
      {...props}
    />
  )
}

function NumberedStepTitle({
  className,
  level = 3,
  ...props
}: React.ComponentProps<"h3"> & { level?: 2 | 3 | 4 }) {
  const Heading = level === 2 ? "h2" : level === 3 ? "h3" : "h4"

  return (
    <Heading
      data-slot="numbered-step-title"
      className={cn("col-start-2 type-heading-h3", className)}
      {...props}
    />
  )
}

function NumberedStepBody({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="numbered-step-body"
      className={cn("col-start-2 type-body-md", className)}
      {...props}
    />
  )
}

export { NumberedSteps, NumberedStep, NumberedStepTitle, NumberedStepBody }
