import * as React from "react"
import { cn } from "@answerable/ui/lib/utils"

/**
 * A key message, milestone or call to commitment: a statement-md heading and
 * body-md text, on-dark on the dark surface, 40px padding, flat.
 */
function HighlightPanel({
  className,
  ...props
}: React.ComponentProps<"section">) {
  return (
    <section
      data-slot="highlight-panel"
      className={cn(
        "flex flex-col items-start gap-4 rounded-lg bg-surface-dark p-10 text-on-dark",
        className,
      )}
      {...props}
    />
  )
}

function HighlightPanelTitle({
  className,
  level = 2,
  ...props
}: React.ComponentProps<"h2"> & { level?: 2 | 3 }) {
  const Heading = level === 2 ? "h2" : "h3"

  return (
    <Heading
      data-slot="highlight-panel-title"
      className={cn("type-statement-md text-balance", className)}
      {...props}
    />
  )
}

function HighlightPanelBody({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="highlight-panel-body"
      className={cn("max-w-(--prose-max) type-body-md", className)}
      {...props}
    />
  )
}

export { HighlightPanel, HighlightPanelTitle, HighlightPanelBody }
