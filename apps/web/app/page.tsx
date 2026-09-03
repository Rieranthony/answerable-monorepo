import { BulletSquare } from "@/components/bullet-square"
import {
  ExpandableSection,
  ExpandableSections,
} from "@/components/expandable-sections"
import { CommaMark, Logo, SquareMark } from "@/components/logo"
import { Mosaic } from "@/components/mosaic"
import { ThemeToggle } from "@/components/theme-toggle"
import { WaitlistForm } from "@/components/waitlist-form"

const ACCREDITATION_BENEFITS = [
  "Guided resources and templates to write your firm's AI policy and handbook from scratch",
  "Governance training and support materials, grounded in Answerable's six core values",
  "A formal examination to prove your level of competence in this role",
  "The “Answerable AP” credential: a publicly listed, verifiable mark that demonstrates to clients that you have met the standard",
]

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
              AI is capable of outstanding responses. It is critical that a
              professional answers for them.
            </h1>
            <p className="text-muted-foreground mt-2 text-sm/6">
              All professional teams need someone who can answer for how AI is
              being used for high-stakes work. We train that AI Leader, equip
              them with a full suite of policy documents for their business and
              accredit them to prove that they&apos;ve met the required
              standard.
            </p>

            <div className="mt-10">
              <ExpandableSections>
                <ExpandableSection value="ai-lead" title="Your AI Lead">
                  <p className="text-foreground/75 text-sm/6">
                    An AI Lead is the named professional responsible for how AI
                    is governed in your practice. They set the policy, define
                    the guardrails, decide what to work on and they make sure AI
                    use meets the same standard as every other piece of
                    published documentation.
                  </p>
                  <p className="text-foreground/75 text-sm/6">
                    Most companies don&apos;t have one yet. The ones that do are
                    building the mode of adoption from scratch, because until
                    now there&apos;s been no common framework, no training
                    pathway and no credential.
                  </p>
                  <p className="text-foreground/75 text-sm/6">
                    Answerable&apos;s AI Lead programme fixes that.
                  </p>
                </ExpandableSection>

                <ExpandableSection
                  value="accredited-professional"
                  title="Become an Answerable Accredited Professional"
                >
                  <p className="text-foreground/75 text-sm/6">
                    The first Answerable cohort is a structured programme for
                    professionals stepping into the AI Lead role. You&apos;ll
                    get:
                  </p>
                  <ul className="flex flex-col gap-2">
                    {ACCREDITATION_BENEFITS.map((benefit) => (
                      <li key={benefit} className="flex gap-2">
                        <BulletSquare />
                        <p className="text-foreground/75 text-sm/6">
                          {benefit}
                        </p>
                      </li>
                    ))}
                  </ul>
                  <p className="text-foreground/75 text-sm/6">
                    You&apos;ll leave with a working policy suite for your
                    practice and an accreditation that you&apos;ve earned.
                  </p>
                </ExpandableSection>

                <ExpandableSection
                  value="core-values"
                  title="Built upon six core values"
                >
                  <p className="text-foreground/75 text-sm/6">
                    Everything we do together and accredit against is rooted in
                    six plain commitments.
                  </p>
                  <p className="text-foreground/75 text-sm/6">
                    They reflect what the professions have always stood for and
                    they have been extended deliberately to facilitate
                    high-integrity professional work in an age of ubiquitous AI
                    use where it is difficult to discern good and bad practice.
                  </p>
                  <ol className="flex list-none flex-col gap-2">
                    {VALUES.map((value, index) => (
                      <li key={value} className="flex gap-2">
                        <span
                          aria-hidden="true"
                          className="text-muted-foreground flex h-6 w-4 shrink-0 items-center text-sm/6 tabular-nums"
                        >
                          {index + 1}
                        </span>
                        <p className="text-foreground/75 text-sm/6">{value}</p>
                      </li>
                    ))}
                  </ol>
                </ExpandableSection>

                <ExpandableSection
                  value="what-is-answerable"
                  title="What is Answerable?"
                >
                  <p className="text-foreground/75 text-sm/6">
                    Answerable is a cross-sector professional initiative created
                    by Keir Regan-Alexander (of Arka Works | Omnichat.uk) and
                    Sadie Morgan OBE (dRMM | QoLF | Forefront | Civic). Our
                    commercial interests are declared in full at the outset. The
                    standard will be built in the open with the professionals
                    who join us.
                  </p>
                </ExpandableSection>
              </ExpandableSections>
            </div>

            <section aria-labelledby="accreditation-heading" className="mt-10">
              <h2 id="accreditation-heading" className="text-sm/6 font-bold">
                Get accredited
              </h2>
              <p className="text-muted-foreground mt-2 text-sm/6">
                Submit your email address and we&apos;ll send you the programme
                details and digital access requirements when enrolment opens.
                Places in the founding cohort are limited. We are looking for
                people who can help define the business standards that will
                follow.
              </p>
              <div className="mt-4">
                <WaitlistForm />
              </div>
            </section>
          </main>
        </div>

        {/* Same 24px gutter as the content column, on every side. On lg the
            viewport-sized wrapper is a sticky flex child, so the taller content
            column cannot stretch and re-crop the mosaic while a panel animates.
            Below lg it flows after the content, full-bleed. */}
        <div className="mt-10 mb-6 aspect-[17/18] w-full lg:sticky lg:top-6 lg:my-6 lg:mr-6 lg:ml-auto lg:h-[calc(100svh-3rem)] lg:w-auto lg:max-w-[calc(100vw-36rem)] lg:self-start">
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
            AI, FOR PROFESSIONALS
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
