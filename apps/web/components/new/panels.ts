import type { StaticImageData } from "next/image"

import forumStage from "@/assets/new/forum-stage.webp"
import terrace from "@/assets/new/terrace-conversations.webp"

/** The six core values, for the accordion and for the black statement panel. */
export const VALUES = [
  "We hold ourselves answerable for our work.",
  "We use AI only where we are competent to do so.",
  "We are honest about how we use AI.",
  "We respect the intellectual and creative work of others.",
  "We protect the information entrusted to us.",
  "We use AI to strengthen our professions, not to diminish them.",
]

export type Panel =
  | {
      kind: "image"
      image: StaticImageData
      /** Focal point: the image's `object-position` x, in percent. */
      x: number
      alt: string
      text?: { style: "headline" | "title" | "label"; value: string }
      /** Black at the top edge, fading to nothing, behind the text only. */
      scrim: number
    }
  /** The six values on black. */
  | { kind: "statement"; title: string }
  /** A comma-shaped window onto an image, on black. */
  | { kind: "window"; image: StaticImageData; x: number; alt: string }

/**
 * One panel per state of the page: the accordion's section values, plus
 * `hero` for nothing open. A panel is a crop, not a file: two photographs are
 * placeholders until Laura's images arrive, so the browser fetches each once.
 *
 * A new image from Laura is one file in `assets/new/` and one line here.
 * `scrim` goes to 0 for an image dark enough under its text.
 */
export const PANELS = {
  hero: {
    kind: "image",
    image: forumStage,
    x: 53,
    alt: "A speaker on a stage presents a building to a seated audience in an open hall full of plants and trees.",
    text: { style: "headline", value: "For everything you put your name to." },
    scrim: 0.45,
  },
  "ai-lead": {
    kind: "image",
    image: forumStage,
    x: 0,
    alt: "People stand and talk under a tree at the back of a talk, the stage beyond them.",
    text: { style: "label", value: "The AI Lead role" },
    scrim: 0.45,
  },
  "core-values": { kind: "statement", title: "Built upon six core values" },
  people: {
    kind: "image",
    image: terrace,
    x: 26,
    alt: "Three people sit on wooden blocks among large leaves, deep in conversation.",
    text: { style: "title", value: "The people behind the programme" },
    scrim: 0.45,
  },
  "accredited-professional": {
    kind: "window",
    image: terrace,
    x: 65,
    alt: "Two people talk on a planted terrace under a pale sun, seen through a comma-shaped window.",
  },
} as const satisfies Record<string, Panel>

export type PanelKey = keyof typeof PANELS

export const PANEL_KEYS = Object.keys(PANELS) as PanelKey[]

export function isPanelKey(value: unknown): value is PanelKey {
  return typeof value === "string" && value in PANELS
}
