import Link from "next/link"
import { ArrowRightIcon } from "lucide-react"
import {
  HeroStatement,
  HeroStatementActions,
  HeroStatementHeadline,
  HeroStatementLead,
} from "@answerable/ui/components/statement/hero-statement"
import { buttonVariants } from "@answerable/ui/lib/button"

import { PROGRAMME } from "./content"
import type { Accent } from "./lib"

/** The statement moment: a Black headline over a Regular lead and one accent button, the section's accent. */
export function Overview({ accent }: { accent: Accent }) {
  return (
    <HeroStatement className="py-0">
      <HeroStatementHeadline
        level={2}
        // A 72px word is wider than a phone: below sm the headline steps down to statement-md.
        className="max-sm:type-statement-md"
      >
        {PROGRAMME.headline}
      </HeroStatementHeadline>
      <HeroStatementLead>{PROGRAMME.lead}</HeroStatementLead>
      <HeroStatementActions>
        {/* A link styled as the accent button: a link keeps its own semantics. */}
        <Link
          href="/"
          className={buttonVariants({
            variant: "accent",
            size: "xl",
            highlight: accent,
          })}
        >
          {PROGRAMME.join}
          <ArrowRightIcon aria-hidden="true" />
        </Link>
      </HeroStatementActions>
    </HeroStatement>
  )
}
