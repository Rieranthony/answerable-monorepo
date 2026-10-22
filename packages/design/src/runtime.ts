// What the React runtime injects, as plain functions: the hooks block and the Google Fonts to load.
import { defaultFont } from "./emit"
import { familyName, fontStack, type FontRequest } from "./fonts"
import type { Design, DesignToken } from "./types"

const lookup = (fonts: Record<string, string>, family: string) =>
  Object.entries(fonts).find(
    ([name]) => name.toLowerCase() === familyName(family).toLowerCase(),
  )?.[1]

/**
 * The hooks to declare: every contract token of the design, since tokens.css carries Answerable's defaults and
 * any other design differs from them, with `font-sans` carrying the self-hosted family when `fonts`
 * (family → the CSS family `next/font` gives it) has the default font.
 */
export function designHooks(
  current: Design,
  tokens: readonly DesignToken[],
  fonts: Record<string, string>,
): Record<string, string> {
  const hooks = Object.fromEntries(
    tokens.map((token) => [token.name, token.value]),
  )
  const font = defaultFont(current)
  const selfHosted = font && lookup(fonts, font.family)
  if (
    font &&
    selfHosted &&
    current.roles["font-sans"].value === fontStack(font)
  ) {
    hooks["font-sans"] = font.fallback
      ? `${selfHosted}, ${font.fallback}`
      : selfHosted
  }
  return hooks
}

/** The Google Fonts families a design names that `fonts` does not self-host, each with the weights the design uses. */
export function fontRequests(
  design: Design,
  fonts: Record<string, string>,
): FontRequest[] {
  const families = new Map<string, { family: string; weights: Set<number> }>()
  const add = (family: string, weights: readonly (number | undefined)[]) => {
    const name = familyName(family)
    const key = name.toLowerCase()
    const entry = families.get(key) ?? {
      family: name,
      weights: new Set<number>(),
    }
    for (const weight of weights)
      if (weight !== undefined) entry.weights.add(weight)
    families.set(key, entry)
  }
  for (const font of Object.values(design.fonts))
    add(font.family, Object.values(font.weights))
  const roleWeights = (
    ["weight-body", "weight-label", "weight-statement"] as const
  ).map((role) => Number(design.roles[role].value))
  const named = /^"([^"]+)"/.exec(design.roles["font-sans"].value)?.[1]
  const sans = named ?? defaultFont(design)?.family
  if (sans) add(sans, roleWeights)
  for (const level of Object.values(design.typography)) {
    if (level.fontFamily) add(level.fontFamily, [level.weight])
  }
  return [...families.values()]
    .filter(({ family }) => lookup(fonts, family) === undefined)
    .map(({ family, weights }) => ({
      family,
      weights: [...weights].sort((a, b) => a - b),
    }))
}
