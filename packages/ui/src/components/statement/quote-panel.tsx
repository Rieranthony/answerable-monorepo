import * as React from "react"
import { cn } from "@answerable/ui/lib/utils"

/**
 * A statement quote: on the dark surface with on-dark text (`tone="black"`,
 * 40px padding), or on the page colour (`tone="white"`, 40px above and below).
 * Flat, never accent-coloured, never framed.
 */
function QuotePanel({
  className,
  tone = "black",
  ...props
}: React.ComponentProps<"figure"> & { tone?: "black" | "white" }) {
  return (
    <figure
      data-slot="quote-panel"
      data-tone={tone}
      className={cn(
        "flex flex-col gap-6 rounded-lg",
        tone === "black"
          ? "bg-surface-dark p-10 text-on-dark"
          : "bg-background py-10 text-foreground",
        className,
      )}
      {...props}
    />
  )
}

function QuotePanelQuote({
  className,
  ...props
}: React.ComponentProps<"blockquote">) {
  return (
    <blockquote
      data-slot="quote-panel-quote"
      className={cn("type-statement-quote text-balance", className)}
      {...props}
    />
  )
}

function QuotePanelAttribution({
  className,
  ...props
}: React.ComponentProps<"figcaption">) {
  return (
    <figcaption
      data-slot="quote-panel-attribution"
      className={cn("type-body-sm", className)}
      {...props}
    />
  )
}

export { QuotePanel, QuotePanelQuote, QuotePanelAttribution }
