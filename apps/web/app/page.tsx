import { createMetadata, SITE } from "@/lib/metadata"
import { BulletSquare } from "@/components/bullet-square"
import { DitherGradient } from "@/components/dither-kit/gradient"
import {
  ExpandableSection,
  ExpandableSections,
} from "@/components/expandable-sections"
import { Logo } from "@/components/logo"
import { Mosaic } from "@/components/mosaic"
import { WaitlistForm } from "@/components/waitlist-form"

export const metadata = createMetadata({
  pathname: "/",
  title: "Answerable · AI Lead training and accreditation",
  absoluteTitle: true,
  index: true,
})

const structuredData = {
  "@context": "https://schema.org",
  "@graph": ["Organization", "WebSite"].map((type) => ({
    "@type": type,
    name: SITE.name,
    url: `${SITE.origin}/`,
    description: SITE.description,
  })),
}

const ACCREDITATION_BENEFITS = [
  {
    lead: "The skills to lead your practice’s approach to AI.",
    body: "Practical training grounded in Answerable’s six core values, equipping you to guide decisions and help colleagues use AI well.",
  },
  {
    lead: "A policy suite your practice can put to work.",
    body: "Develop your AI policy and handbook with guided resources and templates, shaped around your practice rather than written from scratch.",
  },
  {
    lead: "An accreditation you’ve earned.",
    body: "Demonstrate your competence through formal examination to qualify as an Answerable AP.",
  },
  {
    lead: "Recognition others can verify.",
    body: "Successful candidates join the public register of Answerable Accredited Professionals.",
  },
  {
    lead: "A community to keep learning with.",
    body: "Exchange experience, explore difficult questions, and continue developing alongside fellow AI Leads beyond the programme.",
  },
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
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(structuredData).replace(/</g, "\\u003c"),
        }}
      />
      {/* First screenful: content column left, mosaic on the right; the
          tagline sits below the fold. */}
      <div className="relative flex min-h-svh flex-col lg:flex-row">
        <div className="flex w-full max-w-lg flex-col px-6">
          {/* The corner marks of the logotype sit flush to the SVG edges, so
              it shares the 24px gutter with everything else. */}
          <header className="shrink-0 pt-6">
            <Logo className="h-14 w-auto" />
          </header>

          <main className="grow pt-12">
            <h1 className="text-xl/6 font-bold text-balance">
              For everything you put your name to.
            </h1>
            <p className="text-muted-foreground mt-2 text-sm/6">
              The people who change a practice aren’t always the first to try
              something new. They’re the ones who make it worthwhile for
              everyone else. AI needs that kind of leadership: grounded in the
              work, generous with colleagues, and clear about what good looks
              like.
            </p>

            <div className="mt-10">
              <p className="text-muted-foreground text-xs/6">
                Click to expand below:
              </p>
              <div className="mt-2">
                <ExpandableSections>
                  <ExpandableSection value="ai-lead" title="The AI Lead role">
                    <p className="text-foreground/75 text-sm/6">
                      When a client asks how your practice uses AI, the answer
                      should give them another reason to choose you.
                    </p>
                    <p className="text-foreground/75 text-sm/6">
                      An AI Lead helps build the substance behind that answer:
                      better ways of working, colleagues who know how to use the
                      tools well, and standards the practice can explain and
                      uphold.
                    </p>
                    <p className="text-foreground/75 text-sm/6">
                      They bring useful discoveries beyond the people who made
                      them. They connect everyday experimentation with decisions
                      about the practice’s future. And they help make the care
                      behind the work visible to the people commissioning it.
                    </p>
                  </ExpandableSection>

                  <ExpandableSection
                    value="core-values"
                    title="Built upon six core values"
                  >
                    <p className="text-foreground/75 text-sm/6">
                      Everything we teach, assess, and work towards together is
                      rooted in six commitments. They connect the principles
                      that make our work professional with the decisions we face
                      when using AI.
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
                          <p className="text-foreground/75 text-sm/6">
                            {value}
                          </p>
                        </li>
                      ))}
                    </ol>
                  </ExpandableSection>

                  <ExpandableSection
                    value="people"
                    title="The people behind the programme"
                  >
                    <p className="text-foreground/75 text-sm/6">
                      Keir Regan-Alexander has spent the past three years
                      helping more than 100 AEC firms develop their approach to
                      AI. He has worked alongside professionals establishing
                      policies, bringing colleagues into the conversation, and
                      stepping into the AI Lead role. The programme draws on
                      what they have learned together.
                    </p>
                    <p className="text-foreground/75 text-sm/6">
                      Sadie Morgan OBE is co-founder of Stirling Prize-winning
                      dRMM and founder of the Quality of Life Foundation. Her
                      career brings together excellence in practice and a
                      commitment to what good design makes possible for others.
                      At Answerable, she is helping shape an approach to AI
                      worthy of the professions adopting it and the people they
                      serve.
                    </p>
                    <p className="text-foreground/75 text-sm/6">
                      Together, they are developing a programme for
                      professionals who want to take an active part in that
                      future.
                    </p>
                  </ExpandableSection>

                  <ExpandableSection
                    value="accredited-professional"
                    title="Become an Answerable Accredited Professional"
                  >
                    <p className="text-foreground/75 text-sm/6">
                      The founding cohort is a structured programme for
                      professionals stepping into the AI Lead role. You’ll get:
                    </p>
                    <ul className="flex flex-col gap-2">
                      {ACCREDITATION_BENEFITS.map(({ lead, body }) => (
                        <li key={lead} className="flex gap-2">
                          <BulletSquare />
                          <p className="text-foreground/75 text-sm/6">
                            <strong className="text-foreground font-bold">
                              {lead}
                            </strong>{" "}
                            {body}
                          </p>
                        </li>
                      ))}
                    </ul>
                    <p className="text-foreground/75 text-sm/6">
                      You’ll develop an approach you can apply across whichever
                      AI tools your practice uses, now and in the future.
                    </p>
                  </ExpandableSection>
                </ExpandableSections>
              </div>
            </div>

            <section aria-labelledby="accreditation-heading" className="mt-10">
              <h2 id="accreditation-heading" className="text-sm/6 font-bold">
                Join the founding cohort
              </h2>
              <p className="text-muted-foreground mt-2 text-sm/6">
                Be among the first to earn the Answerable AP credential and join
                a professional community that continues beyond the programme.
              </p>
              <p className="text-muted-foreground mt-4 text-sm/6">
                We’re limiting the founding cohort to give participants the
                support and assessment the programme requires. Leave your email
                and we’ll send you programme details and let you know when
                enrolment opens.
              </p>
              <div className="mt-4">
                <WaitlistForm />
              </div>
              <p className="text-muted-foreground mt-2 text-xs/6 italic">
                Registering interest does not reserve a place or commit you to
                enrol.
              </p>
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

      {/* A white dither wash rises from the bottom edge, full bleed, capped
          at fifteen percent so it reads as texture rather than a band; the
          tagline sits on it in black. The footer is the positioned ancestor
          and its content is lifted above the canvas. Below lg the mosaic
          flows just above the footer and the wash reaches up behind it: its
          top is pulled up by the mosaic's height (the full width at 17:18)
          plus the gaps between them (mb-6 and mt-32), and it sits under
          in-flow content so the tiles paint over it. */}
      <footer className="relative mt-32 px-6 pt-32 pb-6">
        <DitherGradient
          from="white"
          direction="up"
          opacity={0.15}
          className="-z-10 max-lg:top-[calc(-152px_-_100vw_*_18_/_17)]"
        />
        {/* The tagline shows from sm up, one line stretched to the width of
            the page gutter; on phones it would be tiny, so it is left out.
            Public Sans Bold at 86 inks 63 units above the baseline and 12
            below it (the comma's tail), so a baseline at 66 in an 80-unit
            box leaves about two units clear on each side. A faint white
            stroke painted under the fill lifts the black letters off the
            wash: it is two screen pixels wide whatever the box scale, so one
            pixel shows outside the letter. */}
        <svg
          aria-hidden="true"
          viewBox="0 0 1000 80"
          className="relative hidden w-full fill-black stroke-white/5 stroke-2 [paint-order:stroke] [stroke-linejoin:round] sm:block"
          xmlns="http://www.w3.org/2000/svg"
        >
          <text
            x="0"
            y="66"
            textLength="1000"
            lengthAdjust="spacingAndGlyphs"
            vectorEffect="non-scaling-stroke"
            fontSize="86"
            fontWeight="700"
          >
            AI, FOR PROFESSIONALS
          </text>
        </svg>
        <p className="text-muted-foreground relative text-xs/4 sm:mt-2">
          © 2026 Answerable · answerable.org
        </p>
      </footer>
    </div>
  )
}
