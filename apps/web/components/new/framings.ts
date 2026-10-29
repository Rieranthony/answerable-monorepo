import forumStage from "@/assets/new/forum-stage.webp"
import terrace from "@/assets/new/terrace-conversations.webp"

/**
 * Two photographs, five framings. A framing is a crop, not a file: the same
 * image with its own `object-position`, so the browser fetches each file once.
 * The keys are the accordion's section values, plus `hero` for nothing open.
 */
export const FRAMINGS = {
  hero: {
    image: forumStage,
    x: 53,
    alt: "A speaker on a stage presents a building to a seated audience in an open hall full of plants and trees.",
  },
  "ai-lead": {
    image: forumStage,
    x: 0,
    alt: "People stand and talk under a tree at the back of a talk, the stage beyond them.",
  },
  "core-values": {
    image: terrace,
    x: 65,
    alt: "Two people talk on a planted terrace under a pale sun while another sits on a rug.",
  },
  people: {
    image: terrace,
    x: 26,
    alt: "Three people sit on wooden blocks among large leaves, deep in conversation.",
  },
  "accredited-professional": {
    image: forumStage,
    x: 100,
    alt: "Small groups talk with drinks beside the seating at a forum, the stage to their left.",
  },
} as const

export type FramingKey = keyof typeof FRAMINGS

export const FRAMING_KEYS = Object.keys(FRAMINGS) as FramingKey[]

export function isFramingKey(value: unknown): value is FramingKey {
  return typeof value === "string" && value in FRAMINGS
}
