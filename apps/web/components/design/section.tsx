import type { ReactNode } from "react"
import { ChevronDownIcon } from "lucide-react"
import { buttonVariants } from "@answerable/ui/lib/button"
import { cn } from "@answerable/ui/lib/utils"

import { ACCENT_FILL, type Accent } from "./lib"
import { Prose } from "./prose"

/**
 * One section of the showcase: an eyebrow with its number and the section's accent, the heading, the
 * file's prose one click away, then the layout that shows it working.
 */
export function ShowcaseSection({
  id,
  number,
  title,
  accent,
  prose,
  proseLabel = "Read the rule",
  children,
}: {
  id: string
  number: number
  title: string
  accent?: Accent
  prose?: string
  proseLabel?: string
  children?: ReactNode
}) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-heading`}
      className="flex scroll-mt-8 flex-col gap-8 py-16"
    >
      <header className="flex flex-col gap-2">
        <p className="type-eyebrow text-muted-foreground flex items-center gap-2">
          {accent && (
            <span
              aria-hidden="true"
              className={cn("size-2 shrink-0", ACCENT_FILL[accent])}
            />
          )}
          <span className="type-numeric">
            {String(number).padStart(2, "0")}
          </span>
        </p>
        <h2 id={`${id}-heading`} className="type-heading-h2">
          {title}
        </h2>
        {prose && (
          <details className="group/prose mt-2">
            <summary
              className={cn(
                buttonVariants({ variant: "secondary", size: "sm" }),
                "w-fit cursor-default list-none [&::-webkit-details-marker]:hidden",
              )}
            >
              {proseLabel}
              <ChevronDownIcon
                aria-hidden="true"
                className="duration-fast transition-transform group-open/prose:rotate-180 motion-reduce:transition-none"
              />
            </summary>
            <Prose markdown={prose} className="mt-6" />
          </details>
        )}
      </header>
      {children}
    </section>
  )
}

/** A titled group inside a section: an h3 and the pieces it shows. */
export function ShowcaseGroup({
  title,
  caption,
  children,
  className,
}: {
  title: string
  caption?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <div className={cn("flex flex-col gap-4", className)}>
      <div className="flex flex-col gap-1">
        <h3 className="type-heading-h4">{title}</h3>
        {caption && (
          <p className="type-caption text-muted-foreground max-w-(--prose-max)">
            {caption}
          </p>
        )}
      </div>
      {children}
    </div>
  )
}
