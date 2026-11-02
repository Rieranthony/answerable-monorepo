import type { StaticImageData } from "next/image"

import forumStage from "@/assets/new/forum-stage.webp"
import terrace from "@/assets/new/terrace-conversations.webp"

export type Panel =
  | {
      kind: "image"
      image: StaticImageData
      /** Focal point: the image's `object-position` x, in percent. */
      x: number
      alt: string
      /** The words in the middle of the image. */
      words: string
      /** How black the band behind the words is, at its strongest. */
      scrim: number
      /** Zooms a phone banner towards `x`, where 2:1 leaves no room to crop. */
      bannerZoom?: number
    }
  /** Words on black, the big comma below them. */
  | { kind: "statement"; words: string }
  /** A comma-shaped window onto an image, on black. */
  | { kind: "window"; image: StaticImageData; x: number; alt: string }

/**
 * One panel per state of the page: the sections' panels, plus `hero` above the
 * first section. A panel is a crop, not a file: two photographs are placeholders
 * until Laura's images arrive, so the browser fetches each once.
 *
 * A new image from Laura is one file in `assets/new/` and one line here.
 * `scrim` goes to 0 for an image dark enough behind its words.
 */
export const PANELS = {
  hero: {
    kind: "image",
    image: forumStage,
    x: 53,
    alt: "A speaker on a stage presents a building to a seated audience in an open hall full of plants and trees.",
    words: "For everything you put your name to.",
    scrim: 0.5,
  },
  "ai-lead": {
    kind: "image",
    image: forumStage,
    x: 0,
    alt: "People stand and talk under a tree at the back of a talk, the stage beyond them.",
    words: "The AI Lead role",
    scrim: 0.5,
    bannerZoom: 1.8,
  },
  "core-values": { kind: "statement", words: "Built upon six core values" },
  people: {
    kind: "image",
    image: terrace,
    x: 26,
    alt: "Three people sit on wooden blocks among large leaves, deep in conversation.",
    words: "The people behind the programme",
    scrim: 0.5,
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
