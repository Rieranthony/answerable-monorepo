import { BulletSquare } from "@/components/bullet-square"
import { CommaMark, Logo, SquareMark } from "@/components/logo"
import { Mosaic } from "@/components/mosaic"
import { ThemeToggle } from "@/components/theme-toggle"
import { WaitlistForm } from "@/components/waitlist-form"

const VALUES = [
  "We hold ourselves answerable for our work.",
  "We use AI only where we are competent to do so.",
  "We are honest about how we use AI.",
  "We respect the intellectual and creative work of others.",
  "We protect the information entrusted to us.",
  "We use AI to strengthen our professions, not to diminish them.",
]

export default function Page() {
  return (
    <div className="flex flex-col">
      {/* First screenful: content column left, mosaic on the right; the
          tagline sits below the fold. */}
      <div className="relative flex min-h-svh flex-col lg:flex-row">
        <div className="flex w-full max-w-lg flex-col px-6">
          {/* The logotype spans the column, so it sets the width the text
              below is measured against. Its corner marks sit flush to the
              SVG edges, giving it the same 24px gutter as everything else. */}
          <header className="shrink-0 pt-6">
            <Logo className="h-auto w-full" />
          </header>

          <main className="grow pt-12">
            <h1 className="text-xl/6 font-bold text-balance">
              AI can do the work. It can&apos;t answer for it.
            </h1>
            <p className="text-muted-foreground mt-2 text-sm/6">
              Answerable is a public declaration for professional practices: six
              plain commitments for using AI with care, competence, and
              accountability.
            </p>

            <section aria-labelledby="values-heading" className="mt-10">
              <h2 id="values-heading" className="text-sm/6 font-bold">
                The six values
              </h2>
              <ul className="mt-4 flex flex-col gap-2">
                {VALUES.map((value) => (
                  <li key={value} className="flex gap-2">
                    <BulletSquare />
                    <p className="text-foreground/75 text-sm/6">{value}</p>
                  </li>
                ))}
              </ul>
            </section>

            <section aria-labelledby="waitlist-heading" className="mt-10">
              <h2 id="waitlist-heading" className="text-sm/6 font-bold">
                Commit your practice.
              </h2>
              <p className="text-muted-foreground mt-2 text-sm/6">
                Leave your email. Be first to sign when the declaration opens.
              </p>
              <div className="mt-4">
                <WaitlistForm />
              </div>
            </section>
          </main>
        </div>

        {/* Same 24px gutter as the content column, on every side. On lg the
            wrapper is absolutely positioned so the band height is definite
            and aspect-ratio derives the width; max-w then crops the sparse
            left side first on narrow viewports (the svg covers via xMax
            slice). Below lg it flows after the content, full-bleed. */}
        <div className="mt-10 mb-6 aspect-[17/18] w-full lg:absolute lg:inset-y-6 lg:right-6 lg:m-0 lg:w-auto lg:max-w-[calc(100vw-36rem)]">
          <Mosaic className="h-full w-full" />
        </div>
      </div>

      {/* Tagline stretched to the full width of the page gutter. */}
      <div aria-hidden="true" className="mt-32 w-full px-6 pb-6">
        <svg
          viewBox="0 2 1000 66"
          className="text-primary/[0.05] dark:text-primary/[0.10] block w-full"
          xmlns="http://www.w3.org/2000/svg"
        >
          <text
            x="0"
            y="66"
            textLength="1000"
            lengthAdjust="spacingAndGlyphs"
            fontSize="86"
            fontWeight="700"
            fill="currentColor"
          >
            AI FOR PROFESSIONALS
          </text>
        </svg>
      </div>

      <footer className="flex items-center gap-4 px-6 pb-6">
        <p className="text-muted-foreground text-xs/4">
          © 2026 Answerable · answerable.org
        </p>
        {/* The toggle sits between a square and a comma, as in the logo,
            framed like the waitlist field. */}
        <div className="border-border focus-within:border-ring flex items-center gap-2 border px-2 py-1 transition-colors">
          <SquareMark className="size-2" />
          <ThemeToggle />
          <CommaMark className="h-3 w-2" />
        </div>
      </footer>
    </div>
  )
}
