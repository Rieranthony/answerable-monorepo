import * as React from "react"
import { cn } from "@answerable/ui/lib/utils"

/**
 * A statement moment: a Black headline over a Regular lead, optionally one
 * accent button (`<Button variant="accent">` in `HeroStatementActions`).
 * Flat, on the page colour, with 96px above and below. One per screen.
 */
function HeroStatement({
  className,
  ...props
}: React.ComponentProps<"section">) {
  return (
    <section
      data-slot="hero-statement"
      className={cn(
        "flex flex-col items-start gap-6 bg-background py-24 text-foreground",
        className,
      )}
      {...props}
    />
  )
}

function HeroStatementHeadline({
  className,
  level = 1,
  ...props
}: React.ComponentProps<"h1"> & { level?: 1 | 2 }) {
  const Heading = level === 1 ? "h1" : "h2"

  return (
    <Heading
      data-slot="hero-statement-headline"
      className={cn("type-statement-xl text-balance", className)}
      {...props}
    />
  )
}

function HeroStatementLead({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="hero-statement-lead"
      className={cn("max-w-(--prose-max) type-lead-lg", className)}
      {...props}
    />
  )
}

function HeroStatementActions({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="hero-statement-actions"
      className={cn("mt-4 flex flex-wrap items-center gap-3", className)}
      {...props}
    />
  )
}

export {
  HeroStatement,
  HeroStatementHeadline,
  HeroStatementLead,
  HeroStatementActions,
}
