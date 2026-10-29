import { BulletSquare } from "@/components/bullet-square"
import { ExpandableSection } from "@/components/expandable-sections"
import { Landing } from "@/components/new/landing"
import { Lockup } from "@/components/new/lockup"
import { PanelImage } from "@/components/new/panel-image"
import { RegisterLink } from "@/components/new/register-link"
import { WaitlistForm } from "@/components/waitlist-form"
import { createMetadata, SITE } from "@/lib/metadata"

export const metadata = createMetadata({
  pathname: "/new",
  title: "Answerable · AI Lead training and accreditation",
  absoluteTitle: true,
  index: false,
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
    lead: "An accreditation others can verify.",
    body: "Demonstrate your competence through formal examination, and take your place on the public register of Accredited Professionals.",
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

const BODY = "text-base/6"

export default function Page() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(structuredData).replace(/</g, "\\u003c"),
        }}
      />
      <Landing
        header={
          <header className="flex items-baseline justify-between py-6 lg:py-8">
            <Lockup />
            <RegisterLink />
          </header>
        }
        hero={
          <div>
            <h1 className="text-[2rem]/[1.05] font-black tracking-[-1px] text-balance lg:text-[2.5rem]/[1.05]">
              For everything you put your name to.
            </h1>
            <p className={`${BODY} text-muted-foreground mt-4`}>
              The people who change a practice aren’t always the first to try
              something new. They’re the ones who make it worthwhile for
              everyone else. AI needs that kind of leadership: grounded in the
              work, generous with colleagues, and clear about what good looks
              like.
            </p>
          </div>
        }
        join={
          <section
            aria-labelledby="accreditation-heading"
            id="join"
            className="scroll-mt-8"
          >
            <h2 id="accreditation-heading" className="text-lg/6 font-bold">
              Join the founding cohort
            </h2>
            <p className={`${BODY} text-muted-foreground mt-2`}>
              Be among the first to earn the Answerable AP credential and join a
              professional community that continues beyond the programme.
            </p>
            <p className={`${BODY} text-muted-foreground mt-4`}>
              We’re limiting the founding cohort to give participants the
              support and assessment the programme requires. Leave your email
              and we’ll send you programme details and let you know when
              enrolment opens.
            </p>
            <div className="mt-4">
              <WaitlistForm autoFocus={false} />
            </div>
            <p className="text-muted-foreground mt-2 text-sm/6">
              Registering interest does not reserve a place or commit you to
              enrol.
            </p>
          </section>
        }
        footer={
          <footer className="text-muted-foreground mt-12 py-8 text-sm/6 lg:mt-16">
            <p>© 2026 Answerable · answerable.org</p>
          </footer>
        }
      >
        <ExpandableSection value="ai-lead" title="The AI Lead role" size="lg">
          <PanelImage framing="ai-lead" />
          <p className={BODY}>
            When a client asks how your practice uses AI, the answer should give
            them another reason to choose you.
          </p>
          <p className={BODY}>
            An AI Lead helps build the substance behind that answer: better ways
            of working, colleagues who know how to use the tools well, and
            standards the practice can explain and uphold.
          </p>
          <p className={BODY}>
            They bring useful discoveries beyond the people who made them. They
            connect everyday experimentation with decisions about the practice’s
            future. And they help make the care behind the work visible to the
            people commissioning it.
          </p>
        </ExpandableSection>

        <ExpandableSection
          value="core-values"
          title="Built upon six core values"
          size="lg"
        >
          <PanelImage framing="core-values" />
          <p className={BODY}>
            Everything we teach, assess, and work towards together is rooted in
            six commitments. They connect the principles that make our work
            professional with the decisions we face when using AI.
          </p>
          <ol className="flex list-none flex-col gap-4">
            {VALUES.map((value, index) => (
              <li key={value} className="flex items-baseline gap-4">
                <span
                  aria-hidden="true"
                  className="w-8 shrink-0 text-2xl font-black tabular-nums"
                >
                  {index + 1}
                </span>
                <p className={BODY}>{value}</p>
              </li>
            ))}
          </ol>
        </ExpandableSection>

        <ExpandableSection
          value="people"
          title="The people behind the programme"
          size="lg"
        >
          <PanelImage framing="people" />
          <p className={BODY}>
            Keir Regan-Alexander has spent the past three years helping more
            than 100 AEC firms develop their approach to AI. He has worked
            alongside professionals establishing policies, bringing colleagues
            into the conversation, and stepping into the AI Lead role. The
            programme draws on what they have learned together.
          </p>
          <p className={BODY}>
            Sadie Morgan OBE is co-founder of Stirling Prize-winning dRMM and
            founder of the Quality of Life Foundation. Her career brings
            together excellence in practice and a commitment to what good design
            makes possible for others. At Answerable, she is helping shape an
            approach to AI worthy of the professions adopting it and the people
            they serve.
          </p>
          <p className={BODY}>
            Together, they are developing a programme for professionals who want
            to take an active part in that future.
          </p>
        </ExpandableSection>

        <ExpandableSection
          value="accredited-professional"
          title="Become an Answerable Accredited Professional"
          size="lg"
        >
          <PanelImage framing="accredited-professional" />
          <p className={BODY}>
            The founding cohort is a structured programme for professionals
            stepping into the AI Lead role. You’ll get:
          </p>
          <ul className="flex flex-col gap-4">
            {ACCREDITATION_BENEFITS.map(({ lead, body }) => (
              <li key={lead} className="flex gap-2">
                <BulletSquare />
                <div>
                  <p className={`${BODY} font-bold`}>{lead}</p>
                  <p className={BODY}>{body}</p>
                </div>
              </li>
            ))}
          </ul>
          <p className={BODY}>
            You’ll develop an approach you can apply across whichever AI tools
            your practice uses, now and in the future.
          </p>
        </ExpandableSection>
      </Landing>
    </>
  )
}
