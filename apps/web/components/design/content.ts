// The words the showcase sets in the design: the programme's own copy from the landing page, never placeholder text.

export const PROGRAMME = {
  headline: "For everything you put your name to.",
  lead: "The people who change a practice aren’t always the first to try something new. They’re the ones who make it worthwhile for everyone else.",
  leadership:
    "AI needs that kind of leadership: grounded in the work, generous with colleagues, and clear about what good looks like.",
  role: [
    "When a client asks how your practice uses AI, the answer should give them another reason to choose you.",
    "An AI Lead helps build the substance behind that answer: better ways of working, colleagues who know how to use the tools well, and standards the practice can explain and uphold.",
  ],
  people:
    "Keir Regan-Alexander has spent the past three years helping more than 100 AEC firms develop their approach to AI. He has worked alongside professionals establishing policies, bringing colleagues into the conversation, and stepping into the AI Lead role.",
  cohort:
    "We’re limiting the founding cohort to give participants the support and assessment the programme requires.",
  enrol:
    "Leave your email and we’ll send you programme details and let you know when enrolment opens.",
  notReserved:
    "Registering interest does not reserve a place or commit you to enrol.",
  registered:
    "You’re on the list. We’ll email you the programme details when enrolment opens.",
  failed: "Something went wrong on our side. Please try again in a moment.",
  invalidEmail: "That doesn't look like a valid email address.",
  register: "Register your interest",
  join: "Join the founding cohort",
}

export const VALUES = [
  "We hold ourselves answerable for our work.",
  "We use AI only where we are competent to do so.",
  "We are honest about how we use AI.",
  "We respect the intellectual and creative work of others.",
  "We protect the information entrusted to us.",
  "We use AI to strengthen our professions, not to diminish them.",
]

export const BENEFITS = [
  {
    lead: "The skills to lead your practice’s approach to AI.",
    body: "Practical training grounded in six core values, equipping you to guide decisions and help colleagues use AI well.",
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

export const SECTIONS = [
  "The AI Lead role",
  "Built upon six core values",
  "The people behind the programme",
  "Join the founding cohort",
]

/** A line of copy for each type level, set in the level itself. */
export const SPECIMENS: Record<string, string> = {
  "statement-xl": PROGRAMME.headline,
  "statement-lg": "AI needs that kind of leadership.",
  "statement-md": PROGRAMME.join,
  "statement-quote": VALUES[0]!,
  "number-display": "100+",
  "number-stat": "6",
  "list-marker": "1 2 3 4",
  "heading-h1": "The AI Lead role",
  "heading-h2": "Built upon six core values",
  "heading-h3": "The people behind the programme",
  "heading-h4": PROGRAMME.join,
  "lead-lg": PROGRAMME.role[0]!,
  lead: PROGRAMME.lead,
  "body-lg": PROGRAMME.leadership,
  "body-md": PROGRAMME.role[1]!,
  "body-sm": PROGRAMME.cohort,
  caption: PROGRAMME.notReserved,
  "ui-text": PROGRAMME.enrol,
  label: "Email",
  button: PROGRAMME.register,
  "nav-link": "Core values",
  "nav-link-active": "The AI Lead role",
  badge: "Founding cohort",
  eyebrow: "Accreditation",
  "table-head": "Contrast",
  numeric: "0123456789",
}
