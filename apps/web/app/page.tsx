import { BulletSquare } from "@/components/bullet-square"
import { CommaMark, Logo } from "@/components/logo"
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
    <div className="flex min-h-svh flex-col">
      {/* Left column; the right side is reserved for a future illustration. */}
      <div className="flex w-full max-w-lg grow flex-col px-6">
        <header className="flex h-16 shrink-0 items-center">
          <Logo className="h-8 w-auto" />
        </header>

        <main className="grow pt-8">
          <h1 className="text-xl/6 font-bold text-balance">
            AI can do the work. It can&apos;t answer for it.
          </h1>
          <p className="mt-2 text-sm/6 text-muted-foreground">
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
                  <p className="text-sm/6 text-foreground/75">{value}</p>
                </li>
              ))}
            </ul>
          </section>

          <section aria-labelledby="waitlist-heading" className="mt-10">
            <h2 id="waitlist-heading" className="text-sm/6 font-bold">
              Commit your practice.
            </h2>
            <p className="mt-2 text-sm/6 text-muted-foreground">
              Leave your email. Be first to sign when the declaration opens.
            </p>
            <div className="mt-4">
              <WaitlistForm />
            </div>
          </section>
        </main>

        <footer className="mt-12 flex h-16 shrink-0 items-center gap-6">
          <p className="text-xs/4 text-muted-foreground">
            © 2026 Answerable · answerable.org
          </p>
          <ThemeToggle />
          <CommaMark className="h-3 w-2" />
        </footer>
      </div>

      {/* Full-bleed tagline, sized to the viewport and cropped at the bottom. */}
      <div aria-hidden="true" className="w-full overflow-hidden">
        <svg
          viewBox="0 0 1000 88"
          className="block w-full text-muted"
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
            AI for professionals
          </text>
        </svg>
      </div>
    </div>
  )
}
