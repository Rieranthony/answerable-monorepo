import { clsx, type ClassValue } from "clsx"
import { extendTailwindMerge } from "tailwind-merge"

/*
 * The design's three weights are weights, not font families (so `font-label`
 * never drops `font-sans`), and a `type-<level>` replaces the size, weight,
 * leading and tracking before it. `type-numeric` only sets tabular figures,
 * so it combines with any level.
 */
const twMerge = extendTailwindMerge<"type-level">({
  extend: {
    theme: { "font-weight": ["body", "label", "statement"] },
    classGroups: {
      "type-level": [{ type: [(value: string) => value !== "numeric"] }],
    },
    conflictingClassGroups: {
      "type-level": ["font-size", "font-weight", "leading", "tracking"],
    },
  },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
