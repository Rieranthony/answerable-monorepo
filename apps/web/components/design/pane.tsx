"use client"

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react"
import { Accordion } from "@base-ui/react/accordion"
import { ChevronDownIcon, SlidersHorizontalIcon, XIcon } from "lucide-react"
import {
  COLOUR_ROLES,
  GROUP_TOKENS,
  categoryFallback,
  defaultFont,
  nearestWeight,
  type Design,
  type GoogleFont,
  type TokenGroup,
} from "@answerable/design"
import { useDesign } from "@answerable/design/react"
import { Button } from "@answerable/ui/components/button"
import {
  Combobox,
  ComboboxCollection,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
} from "@answerable/ui/components/combobox"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@answerable/ui/components/select"
import { Separator } from "@answerable/ui/components/separator"
import { Slider, SliderLabel } from "@answerable/ui/components/slider"

import { useCopy } from "./actions"
import { partnerOf, rolePath, weightName } from "./lib"
import {
  ColourField,
  PaneScopeContext,
  TokenField,
  usePaneScope,
  type PaneScope,
} from "./pane-fields"
import { useTokens } from "./readouts"

/**
 * The floating editor: fixed at the top right, inside the default design so it never changes with the
 * page, collapsing to a 36px square. Every control writes through `useDesign().set`.
 */
export function DesignPane({ font }: { font: string }) {
  const [open, setOpen] = useState(false)
  const panelId = useId()
  const toggle = useRef<HTMLButtonElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const moved = useRef(false)
  const scope = useMemo<PaneScope>(
    () => ({
      "data-design-scope": "default",
      style: { "--design-font-sans": font } as CSSProperties,
    }),
    [font],
  )

  // Focus follows the pane: into it on open, back to the square on close; not on the first render.
  useEffect(() => {
    if (!moved.current) return
    if (open) heading.current?.focus()
    else toggle.current?.focus()
  }, [open])

  function setPane(next: boolean) {
    moved.current = true
    setOpen(next)
  }

  return (
    <PaneScopeContext value={scope}>
      <div
        {...scope}
        className="type-ui-text text-foreground fixed top-4 right-4 z-40 font-sans antialiased"
      >
        {open ? (
          <section
            id={panelId}
            aria-labelledby={`${panelId}-heading`}
            className="bg-popover text-popover-foreground flex max-h-[calc(100svh-2rem)] w-[min(26rem,calc(100vw-2rem))] flex-col shadow-lg"
          >
            <header className="flex shrink-0 items-center justify-between gap-2 py-1 pr-1 pl-4">
              <h2
                ref={heading}
                id={`${panelId}-heading`}
                tabIndex={-1}
                className="type-label outline-none"
              >
                Design
              </h2>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Collapse the design pane"
                aria-expanded
                aria-controls={panelId}
                onClick={() => setPane(false)}
              >
                <XIcon />
              </Button>
            </header>
            <Separator />
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
              <Sections />
            </div>
            <Separator />
            <PaneActions />
          </section>
        ) : (
          <Button
            ref={toggle}
            size="icon"
            aria-label="Open the design pane"
            aria-expanded={false}
            onClick={() => setPane(true)}
            className="shadow-md"
          >
            <SlidersHorizontalIcon />
          </Button>
        )}
      </div>
    </PaneScopeContext>
  )
}

function Item({
  value,
  title,
  children,
}: {
  value: string
  title: string
  children: ReactNode
}) {
  return (
    <Accordion.Item
      value={value}
      className="border-border border-b last:border-0"
    >
      <Accordion.Header>
        <Accordion.Trigger className="group/trigger type-label hover:bg-accent focus-visible:focus-ring flex h-(--control-md) w-full items-center justify-between gap-2 px-4 text-left outline-none">
          {title}
          <ChevronDownIcon
            aria-hidden="true"
            className="duration-fast size-4 transition-transform group-data-panel-open/trigger:rotate-180 motion-reduce:transition-none"
          />
        </Accordion.Trigger>
      </Accordion.Header>
      <Accordion.Panel className="flex flex-col gap-1 px-4 pb-4">
        {children}
      </Accordion.Panel>
    </Accordion.Item>
  )
}

function Sections() {
  return (
    <Accordion.Root multiple defaultValue={["colours"]}>
      <Item value="colours" title="Colours">
        <Colours />
      </Item>
      <Item value="type" title="Type">
        <Type />
      </Item>
      <Item value="shape" title="Shape">
        <Shape />
      </Item>
      <Item value="spacing" title="Spacing">
        <Spacing />
      </Item>
      {(
        [
          ["sizes", "Sizes", "Sizes", "width"],
          ["elevation", "Elevation", "Elevation", "box-shadow"],
          ["lines", "Lines", "Lines", "width"],
          ["motion", "Motion", "Motion", "transition-duration"],
        ] as const
      ).map(([value, title, group, property]) => (
        <Item key={value} value={value} title={title}>
          <GroupTokens group={group} property={property} />
        </Item>
      ))}
    </Accordion.Root>
  )
}

function Subheading({ children }: { children: ReactNode }) {
  return (
    <h3 className="type-eyebrow text-muted-foreground pt-3 pb-1">{children}</h3>
  )
}

/** One row per colour role and per named colour of the file. */
function Colours() {
  const { current } = useDesign()
  const tokens = useTokens()
  return (
    <>
      <Subheading>Roles</Subheading>
      {COLOUR_ROLES.map((role) => {
        const partner = partnerOf(role)
        const against = tokens.get(partner)
        return (
          <ColourField
            key={role}
            name={role}
            label={role}
            value={tokens.get(role) ?? ""}
            against={against ? { label: partner, value: against } : undefined}
          />
        )
      })}
      <Subheading>Named colours</Subheading>
      {Object.entries(current.colors).map(([name, colour]) => {
        // Read against what the colour is used with: the partner of the first role bound to it.
        const role = COLOUR_ROLES.find(
          (entry) => current.roles[entry].ref === `colors.${name}`,
        )
        const partner = role ? partnerOf(role) : "background"
        return (
          <ColourField
            key={name}
            name={`colors.${name}`}
            label={name}
            value={colour.hex}
            against={{ label: partner, value: tokens.get(partner) ?? "" }}
          />
        )
      })}
    </>
  )
}

// The catalogue is 220 KB of JSON: loaded once, the first time the Type section opens.
let catalogue: Promise<GoogleFont[]> | undefined
const loadCatalogue = () =>
  (catalogue ??= import("@answerable/design/google-fonts.json").then(
    (module) => module.default as GoogleFont[],
  ))

function useCatalogue() {
  const [fonts, setFonts] = useState<GoogleFont[] | null>(null)
  useEffect(() => {
    let live = true
    loadCatalogue().then((loaded) => live && setFonts(loaded))
    return () => {
      live = false
    }
  }, [])
  return fonts
}

const CATEGORIES = [
  "Sans Serif",
  "Serif",
  "Display",
  "Handwriting",
  "Monospace",
]

type FontGroup = { value: string; items: GoogleFont[] }

function groupFonts(fonts: readonly GoogleFont[]): FontGroup[] {
  const groups = new Map<string, GoogleFont[]>()
  for (const font of fonts) {
    const list = groups.get(font.category) ?? []
    list.push(font)
    groups.set(font.category, list)
  }
  return [
    ...CATEGORIES.filter((category) => groups.has(category)),
    ...[...groups.keys()].filter((category) => !CATEGORIES.includes(category)),
  ].map((value) => ({ value, items: groups.get(value)! }))
}

const ROLES = ["body", "label", "statement"] as const
const FALLBACK_WEIGHTS = { body: 400, label: 700, statement: 900 }

/** The default font's key in `fonts`, which the typeface and weight controls write to. */
function fontKey(design: Design) {
  const font = defaultFont(design)
  return Object.entries(design.fonts).find(([, entry]) => entry === font)?.[0]
}

/** The typeface, the three weight roles and the level table. */
function Type() {
  const { design, current, set } = useDesign()
  const fonts = useCatalogue()
  const scope = usePaneScope()
  const key = fontKey(current)
  const font = key ? current.fonts[key] : undefined
  const family = font?.family
  const groups = useMemo(() => (fonts ? groupFonts(fonts) : []), [fonts])
  const entry = useMemo(
    () =>
      family
        ? fonts?.find((f) => f.family.toLowerCase() === family.toLowerCase())
        : undefined,
    [fonts, family],
  )
  const selected: GoogleFont | null = family
    ? (entry ?? { family, category: "", weights: [], italic: false, axes: [] })
    : null

  function pick(next: GoogleFont | null) {
    if (!next || !key) return
    set(`fonts.${key}.family`, next.family)
    set(`fonts.${key}.fallback`, categoryFallback(next.category))
    // The weights the file asks for, moved to the nearest the family offers.
    for (const role of ROLES) {
      const wanted = design.fonts[key]?.weights[role] ?? FALLBACK_WEIGHTS[role]
      set(
        `fonts.${key}.weights.${role}`,
        String(nearestWeight(wanted, next.weights)),
      )
    }
  }

  const offered = entry?.weights ?? []

  return (
    <>
      <Subheading>Typeface</Subheading>
      {key ? (
        <Combobox
          items={groups}
          value={selected}
          onValueChange={(value) => pick(value as GoogleFont | null)}
          itemToStringLabel={(item: GoogleFont) => item.family}
          isItemEqualToValue={(a: GoogleFont, b: GoogleFont) =>
            a.family === b.family
          }
          limit={80}
          autoHighlight
        >
          <ComboboxInput
            aria-label="Typeface"
            placeholder={
              fonts
                ? `Search ${fonts.length.toLocaleString("en-GB")} Google Fonts`
                : "Loading fonts…"
            }
            className="h-(--control-sm)"
          />
          <ComboboxContent {...scope}>
            <ComboboxEmpty>No family matches.</ComboboxEmpty>
            <ComboboxList>
              {(group: FontGroup) => (
                <ComboboxGroup key={group.value} items={group.items}>
                  <ComboboxLabel>{group.value}</ComboboxLabel>
                  <ComboboxCollection>
                    {(item: GoogleFont) => (
                      <ComboboxItem key={item.family} value={item}>
                        {item.family}
                      </ComboboxItem>
                    )}
                  </ComboboxCollection>
                </ComboboxGroup>
              )}
            </ComboboxList>
          </ComboboxContent>
        </Combobox>
      ) : (
        <p className="type-caption text-muted-foreground">
          This design names no font to change.
        </p>
      )}

      {key && font && (
        <>
          <Subheading>Weights</Subheading>
          {ROLES.map((role) => {
            const value = String(font.weights[role] ?? FALLBACK_WEIGHTS[role])
            const options = offered.length > 0 ? offered.map(String) : [value]
            const items = options.map((weight) => ({
              value: weight,
              label: weightName(weight),
            }))
            return (
              <div
                key={role}
                className="flex items-center justify-between gap-2 py-1"
              >
                <span id={`weight-${role}`} className="type-label capitalize">
                  {role}
                </span>
                <Select
                  items={items}
                  value={value}
                  onValueChange={(next) => {
                    if (next) set(`fonts.${key}.weights.${role}`, String(next))
                  }}
                >
                  <SelectTrigger
                    size="sm"
                    aria-labelledby={`weight-${role}`}
                    className="w-40"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent {...scope}>
                    {items.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )
          })}
        </>
      )}

      <Subheading>Levels</Subheading>
      <table className="type-caption w-full table-fixed">
        <thead>
          <tr className="text-muted-foreground text-left">
            <th scope="col" className="font-label w-auto pb-1">
              Level
            </th>
            {["Size", "Weight", "Leading", "Tracking"].map((label) => (
              <th key={label} scope="col" className="font-label w-16 pb-1 pl-1">
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Object.entries(current.typography).map(([level, type]) => (
            <tr key={level}>
              <th
                scope="row"
                className="font-body truncate py-0.5 pr-1 text-left"
              >
                {level}
              </th>
              {(
                [
                  ["fontSize", "size", "font-size", "size"],
                  ["fontWeight", "weight", "font-weight", "weight"],
                  ["lineHeight", "leading", "line-height", "leading"],
                  ["letterSpacing", "tracking", "letter-spacing", "tracking"],
                ] as const
              ).map(([yaml, field, property, label]) => (
                <td key={yaml} className="py-0.5 pl-1">
                  <TokenField
                    compact
                    name={`typography.${level}.${yaml}`}
                    label={`${level} ${label}`}
                    value={type[field] === undefined ? "" : String(type[field])}
                    property={property}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}

function PixelSlider({
  label,
  name,
  value,
  min,
  max,
}: {
  label: string
  name: string
  value: string
  min: number
  max: number
}) {
  const { set } = useDesign()
  const number = parseFloat(value)
  const current = Number.isFinite(number) ? number : min
  return (
    <Slider
      value={[Math.min(max, Math.max(min, current))]}
      min={min}
      max={max}
      step={1}
      onValueChange={(next) => {
        const [first] = Array.isArray(next) ? next : [next]
        if (first !== undefined) set(name, `${first}px`)
      }}
      className="flex flex-col gap-2 py-2"
    >
      <span className="flex items-baseline justify-between gap-2">
        <SliderLabel>{label}</SliderLabel>
        <span className="type-caption text-muted-foreground type-numeric">
          {value}
        </span>
      </span>
    </Slider>
  )
}

/** The radius, 0 to 24px, and the full radius radios and avatars take. */
function Shape() {
  const { current } = useDesign()
  const tokens = useTokens()
  return (
    <>
      <PixelSlider
        label="Radius"
        name={rolePath(current, "radius")}
        value={tokens.get("radius") ?? "0px"}
        min={0}
        max={24}
      />
      <TokenField
        label="Full radius"
        name={rolePath(current, "radius-full")}
        value={tokens.get("radius-full") ?? ""}
        property="border-radius"
      />
    </>
  )
}

/** The unit every `p-*`, `gap-*`, `h-*` and `size-*` scales from, 2 to 8px. */
function Spacing() {
  const { current } = useDesign()
  return (
    <PixelSlider
      label="Unit"
      name={rolePath(current, "spacing-unit")}
      value={useTokens().get("spacing-unit") ?? "4px"}
      min={2}
      max={8}
    />
  )
}

const COLOUR_TOKENS = new Set(["line-separator-color", "line-statement-color"])

/** The tokens of one profile group, each checked against the CSS property it feeds. */
function GroupTokens({
  group,
  property,
}: {
  group: TokenGroup
  property: string
}) {
  const tokens = useTokens()
  const names = GROUP_TOKENS.filter((spec) => spec.group === group).map(
    (spec) => spec.name,
  )
  if (group === "Lines") names.push("focus-ring")
  return names.map((name) =>
    COLOUR_TOKENS.has(name) ? (
      <ColourField
        key={name}
        name={name}
        label={name}
        value={tokens.get(name) ?? ""}
        against={{ label: "background", value: tokens.get("background") ?? "" }}
      />
    ) : (
      <TokenField
        key={name}
        name={name}
        label={name}
        value={tokens.get(name) ?? ""}
        property={
          name === "focus-ring"
            ? "box-shadow"
            : name === "ease"
              ? "transition-timing-function"
              : property
        }
      />
    ),
  )
}

/** Reset all, Copy CSS, Copy DESIGN.md. */
function PaneActions() {
  const { reset, css, markdown, overrides } = useDesign()
  const { copied, copy } = useCopy()
  const edits = Object.keys(overrides).length
  return (
    <footer className="flex shrink-0 items-center gap-2 p-2">
      <Button
        variant="ghost"
        size="sm"
        disabled={edits === 0}
        onClick={() => reset()}
      >
        Reset all
      </Button>
      <Button
        variant="secondary"
        size="sm"
        className="ml-auto"
        onClick={() => copy("css", css)}
      >
        {copied === "css" ? "Copied" : "Copy CSS"}
      </Button>
      <Button
        variant="secondary"
        size="sm"
        onClick={() => copy("markdown", markdown)}
      >
        {copied === "markdown" ? "Copied" : "Copy DESIGN.md"}
      </Button>
      <span className="sr-only" aria-live="polite">
        {copied ? "Copied to the clipboard" : ""}
      </span>
    </footer>
  )
}
