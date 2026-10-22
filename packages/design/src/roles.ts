// Roles: read from the file's `roles` group, then completed by inference so any design.md file renders.
import { ROLES, isColourRole, isRole, type RoleName } from "./contract"
import { contrast, luminance, mix, parseColor } from "./color"
import { findFont, fontStack, nearestWeight } from "./fonts"
import { group, isDimension, report, unresolved, type Context } from "./profile"
import { isTree, referenceOf } from "./resolve"
import type { DesignColor, DesignFont, DesignRole } from "./types"

/** What inference reads besides the roles. */
export interface RoleInputs {
  colors: Record<string, DesignColor>
  fonts: Record<string, DesignFont>
  rounded: Record<string, string>
  spacing: Record<string, string>
}

interface Source {
  ref?: string
  value: string
  /** What the role was inferred from, for the finding. */
  from: string
  /** The colour the value is, when it is a named colour. */
  colour?: string
  /** The role the value copies, when it copies one. */
  role?: RoleName
}

function fileRole(
  context: Context,
  inputs: RoleInputs,
  role: RoleName,
  value: unknown,
): string | undefined {
  const path = `roles.${role}`
  if (isColourRole(role)) {
    const colour = typeof value === "string" ? parseColor(value) : null
    if (colour) return colour.hex
    report(
      context,
      "error",
      path,
      `"${path}" must be a colour; the role is inferred instead.`,
      "profile-role",
    )
    return undefined
  }
  if (role === "font-sans") {
    if (isTree(value) && typeof value.family === "string") {
      const fallback =
        typeof value.fallback === "string"
          ? value.fallback
          : "system-ui, sans-serif"
      return fontStack({ family: value.family, fallback })
    }
    if (typeof value === "string") {
      const font = Object.values(inputs.fonts).find(
        (entry) => entry.family.toLowerCase() === value.toLowerCase(),
      )
      return font ? fontStack(font) : value
    }
  } else if (role.startsWith("weight-")) {
    const weight = Number(value)
    if (Number.isInteger(weight) && weight >= 1 && weight <= 1000)
      return String(weight)
  } else if (
    (typeof value === "string" || typeof value === "number") &&
    isDimension(String(value))
  ) {
    return String(value)
  }
  report(
    context,
    "error",
    path,
    `"${path}" has a value the role cannot take; the role is inferred instead.`,
    "profile-role",
  )
  return undefined
}

/** The roles the file binds in its `roles` group. */
function fromFile(
  context: Context,
  inputs: RoleInputs,
): Partial<Record<RoleName, Source>> {
  const [raw, resolved] = group(context, "roles")
  const sources: Partial<Record<RoleName, Source>> = {}
  for (const [role, written] of Object.entries(raw)) {
    if (!isRole(role)) {
      report(
        context,
        "warning",
        `roles.${role}`,
        `"${role}" is not a role of the contract; it is ignored.`,
        "profile-role",
      )
      continue
    }
    const value = resolved[role]
    if (unresolved(value)) continue
    const text = fileRole(context, inputs, role, value)
    if (text === undefined) continue
    const ref = referenceOf(written)
    const colour = ref?.startsWith("colors.")
      ? ref.slice("colors.".length)
      : undefined
    sources[role] = { ref, value: text, from: "the roles group", colour }
  }
  return sources
}

/** Every role of the contract: the file's, then the inferred ones, each inference reported as an info finding. */
export function roles(
  context: Context,
  inputs: RoleInputs,
): Record<RoleName, DesignRole> {
  const { colors, fonts, rounded, spacing } = inputs
  const sources = fromFile(context, inputs)
  const value = (role: RoleName) => sources[role]!.value

  const colour = (name: string): Source | undefined => {
    const entry = colors[name]
    return (
      entry && {
        ref: `colors.${name}`,
        value: entry.hex,
        from: `colors.${name}`,
        colour: name,
      }
    )
  }
  const copy = (role: RoleName): Source => ({
    ref: sources[role]!.ref,
    value: value(role),
    from: `the ${role} role`,
    role,
  })
  const literal = (text: string, from: string): Source => ({
    value: text,
    from,
  })
  const better = (against: string): Source =>
    contrast(value("foreground"), against)! >=
    contrast(value("background"), against)!
      ? copy("foreground")
      : copy("background")
  const mixed = (amount: number, what: string): Source =>
    literal(
      mix(value("foreground"), value("background"), amount),
      `a ${amount * 100}% mix of the foreground into the background (${what})`,
    )
  const nearestNeutral = (): Source | undefined => {
    const background = value("background")
    const target = luminance(background)
    const neutrals = Object.keys(colors).filter(
      (name) =>
        /^(neutral|gray|grey)(-|$)/.test(name) &&
        colors[name]!.hex !== background,
    )
    const name = neutrals.reduce<string | undefined>(
      (best, next) =>
        best === undefined ||
        Math.abs(luminance(colors[next]!.hex) - target) <
          Math.abs(luminance(colors[best]!.hex) - target)
          ? next
          : best,
      undefined,
    )
    return name === undefined
      ? undefined
      : {
          ...colour(name)!,
          from: `colors.${name}, the neutral nearest the background`,
        }
  }
  const pair = (role: RoleName): Source => {
    const base = sources[role]!
    const on =
      base.colour === undefined ? undefined : colour(`on-${base.colour}`)
    if (on) return on
    if (
      base.role === "background" ||
      base.colour === "background" ||
      base.colour?.startsWith("surface")
    ) {
      return copy("foreground")
    }
    if (base.role === "primary" || base.role === "accent")
      return copy(`${base.role}-foreground`)
    return better(base.value)
  }

  const accents = Object.keys(colors).filter((name) =>
    name.startsWith("accent-"),
  )
  const pool = [
    ...accents,
    ...["primary", "secondary", "tertiary", "error"].filter(
      (name) => colors[name],
    ),
  ]
  const highlight = (index: number): Source =>
    pool.length === 0
      ? copy("foreground")
      : {
          ...colour(pool[index % pool.length]!)!,
          from: `colors.${pool[index % pool.length]}, the file's accent colours in order`,
        }

  const font = Object.entries(fonts).find(([, entry]) => entry.default)
  const weight = (
    role: "body" | "label" | "statement",
    wanted: number,
  ): Source => {
    if (!font)
      return literal(
        String(wanted),
        "the profile's default, as the design has no font",
      )
    const [key, entry] = font
    const declared = entry.weights[role]
    if (declared !== undefined) {
      return {
        ref: `fonts.${key}.weights.${role}`,
        value: String(declared),
        from: `fonts.${key}.weights.${role}`,
      }
    }
    const offered = findFont(entry.family, context.catalogue)?.weights ?? []
    const nearest = nearestWeight(wanted, offered)
    return literal(
      String(nearest),
      offered.length > 0
        ? `the profile's ${wanted}, the nearest weight ${entry.family} offers`
        : "the profile's default",
    )
  }
  const dimension = (
    group: "rounded" | "spacing",
    keys: string[],
    fallback: string,
  ): Source => {
    const map = group === "rounded" ? rounded : spacing
    const key = keys.find((name) => map[name] !== undefined)
    return key === undefined
      ? literal(fallback, "the profile's default")
      : { ref: `${group}.${key}`, value: map[key]!, from: `${group}.${key}` }
  }

  const rules: [RoleName, () => Source][] = [
    [
      "background",
      () =>
        colour("background") ??
        colour("surface") ??
        literal("#ffffff", "the profile's default"),
    ],
    [
      "foreground",
      () =>
        colour("foreground") ??
        colour("on-background") ??
        colour("on-surface") ??
        literal("#000000", "the profile's default"),
    ],
    [
      "primary",
      () => colour("primary") ?? colour("foreground") ?? copy("foreground"),
    ],
    [
      "muted",
      () =>
        colour("muted") ??
        colour("surface-container") ??
        nearestNeutral() ??
        mixed(0.04, "no muted colour"),
    ],
    [
      "muted-foreground",
      () =>
        colour("muted-foreground") ??
        colour("on-surface-variant") ??
        mixed(0.6, "no muted text colour"),
    ],
    [
      "card",
      () =>
        colour("card") ??
        colour("surface-card") ??
        colour("surface-container-lowest") ??
        copy("background"),
    ],
    [
      "popover",
      () =>
        colour("popover") ??
        colour("surface-card") ??
        colour("surface-container-lowest") ??
        copy("background"),
    ],
    ["secondary", () => colour("secondary") ?? copy("muted")],
    ["accent", () => colour("accent") ?? copy("muted")],
    ["input", () => colour("input") ?? copy("muted")],
    [
      "destructive",
      () => colour("destructive") ?? colour("error") ?? copy("primary"),
    ],
    [
      "border",
      () =>
        colour("border") ??
        colour("separator") ??
        colour("outline-variant") ??
        colour("outline") ??
        mixed(0.1, "no border colour"),
    ],
    ["ring", () => colour("ring") ?? copy("primary")],
    [
      "sidebar",
      () =>
        colour("sidebar") ??
        colour("surface-container-low") ??
        copy("background"),
    ],
    ["sidebar-primary", () => colour("sidebar-primary") ?? copy("primary")],
    ["sidebar-accent", () => colour("sidebar-accent") ?? copy("accent")],
    ["sidebar-border", () => colour("sidebar-border") ?? copy("border")],
    ["sidebar-ring", () => colour("sidebar-ring") ?? copy("ring")],
    [
      "overlay",
      () => colour("overlay") ?? literal("#00000080", "the profile's default"),
    ],
    [
      "surface-dark",
      () =>
        colour("surface-dark") ??
        colour("inverse-surface") ??
        copy("foreground"),
    ],
    [
      "on-dark",
      () =>
        colour("on-dark") ??
        colour("inverse-on-surface") ??
        better(value("surface-dark")),
    ],
    [
      "success",
      () => colour("success") ?? literal("#16a34a", "the profile's default"),
    ],
    [
      "warning",
      () => colour("warning") ?? literal("#f59e0b", "the profile's default"),
    ],
    [
      "info",
      () => colour("info") ?? literal("#0ea5e9", "the profile's default"),
    ],
    ...[1, 2, 3, 4].map((n): [RoleName, () => Source] => [
      `highlight-${n}` as RoleName,
      () => colour(`highlight-${n}`) ?? highlight(n - 1),
    ]),
    ["on-accent", () => colour("on-accent") ?? better(value("highlight-1"))],
    ["chart-1", () => colour("chart-1") ?? copy("foreground")],
    ...[2, 3, 4, 5].map((n): [RoleName, () => Source] => [
      `chart-${n}` as RoleName,
      () => colour(`chart-${n}`) ?? copy(`highlight-${n - 1}` as RoleName),
    ]),
    ...(
      [
        "card",
        "popover",
        "primary",
        "secondary",
        "accent",
        "destructive",
        "sidebar",
        "sidebar-primary",
        "sidebar-accent",
      ] as const
    ).map((role): [RoleName, () => Source] => [
      `${role}-foreground`,
      () => colour(`${role}-foreground`) ?? pair(role),
    ]),
    [
      "font-sans",
      () =>
        font
          ? {
              ref: `fonts.${font[0]}`,
              value: fontStack(font[1]),
              from: `fonts.${font[0]}, the default font`,
            }
          : literal(
              "system-ui, sans-serif",
              "the profile's default, as the design has no font",
            ),
    ],
    ["weight-body", () => weight("body", 400)],
    ["weight-label", () => weight("label", 700)],
    ["weight-statement", () => weight("statement", 900)],
    [
      "radius",
      () => dimension("rounded", ["default", "DEFAULT", "md", "sm"], "0px"),
    ],
    ["radius-full", () => dimension("rounded", ["full"], "9999px")],
    ["spacing-unit", () => dimension("spacing", ["unit", "base"], "4px")],
  ]

  const inferred = new Set<RoleName>()
  for (const [role, rule] of rules) {
    if (sources[role]) continue
    const source = rule()
    sources[role] = source
    inferred.add(role)
    report(
      context,
      "info",
      `roles.${role}`,
      `"${role}" is inferred from ${source.from}: ${source.value}.`,
      "profile-role",
    )
  }

  return Object.fromEntries(
    ROLES.map((role) => {
      const { ref, value: text } = sources[role]!
      const entry: DesignRole =
        ref === undefined ? { value: text } : { ref, value: text }
      if (inferred.has(role)) {
        entry.inferred = true
        if (ref !== undefined) context.refs[`roles.${role}`] = ref
      }
      return [role, entry]
    }),
  ) as Record<RoleName, DesignRole>
}
