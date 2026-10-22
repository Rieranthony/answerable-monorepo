"use client"

import {
  createContext,
  useContext,
  useId,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react"
import { parseColor } from "@answerable/design"
import { useDesign } from "@answerable/design/react"
import { inputClassName } from "@answerable/ui/lib/input"
import { cn } from "@answerable/ui/lib/utils"

import { formatRatio, verdict } from "./lib"

/**
 * What a surface inside the pane spreads to keep the default design: the scope attribute and the
 * self-hosted font. Popups portal out of the pane, so they spread it too.
 */
export type PaneScope = {
  "data-design-scope": "default"
  style: CSSProperties
}

export const PaneScopeContext = createContext<PaneScope>({
  "data-design-scope": "default",
  style: {},
})

export const usePaneScope = () => useContext(PaneScopeContext)

const fieldClassName = cn(inputClassName, "h-(--control-sm) px-2")

/**
 * A text field that commits on blur or Enter, writes through `useDesign().set`, and keeps an
 * invalid entry on screen, marked, until it is fixed or Escape restores the value.
 */
function useDraft(value: string, commit: (text: string) => string | null) {
  const [draft, setDraft] = useState<string | null>(null)
  const [invalid, setInvalid] = useState(false)
  function apply() {
    if (draft === null || draft.trim() === value) {
      setDraft(null)
      setInvalid(false)
      return
    }
    const accepted = commit(draft.trim())
    setInvalid(accepted === null)
    if (accepted !== null) setDraft(null)
  }
  return {
    invalid,
    inputProps: {
      value: draft ?? value,
      "aria-invalid": invalid || undefined,
      onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
        setDraft(event.target.value),
      onBlur: apply,
      onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key === "Enter") apply()
        if (event.key === "Escape" && draft !== null) {
          event.stopPropagation()
          setDraft(null)
          setInvalid(false)
        }
      },
      spellCheck: false,
      autoComplete: "off",
    },
  }
}

/** The square marker an invalid field takes beside its label. */
function Marker({ show }: { show: boolean }) {
  return show ? (
    <span aria-hidden="true" className="bg-destructive size-1 shrink-0" />
  ) : null
}

/** A colour as a compact readout: lowercase hex and a rounded oklch. */
function readout(hex: string) {
  const parsed = parseColor(hex)
  if (!parsed) return hex
  const { l, c, h } = parsed.oklch
  const alpha = parsed.alpha < 1 ? ` / ${parsed.alpha.toFixed(2)}` : ""
  return `${parsed.hex} · oklch(${l.toFixed(3)} ${c.toFixed(3)} ${h.toFixed(1)}${alpha})`
}

/** A square of colour on a muted pad, so white shows on white without a stroke. */
function Swatch({ value }: { value: string }) {
  return (
    <span aria-hidden="true" className="bg-muted shrink-0 p-0.5">
      <span className="block size-3" style={{ background: value }} />
    </span>
  )
}

/**
 * A colour: swatch, a field that reads any CSS colour and converts it to hex on blur, the hex and oklch
 * readouts, and the contrast against the colour it is set with.
 */
export function ColourField({
  name,
  label,
  value,
  against,
}: {
  /** What `set` receives: a role (`primary`) or a design path (`colors.neutral-100`). */
  name: string
  label: string
  value: string
  against?: { label: string; value: string }
}) {
  const { set } = useDesign()
  const id = useId()
  const { invalid, inputProps } = useDraft(value, (text) => {
    const parsed = parseColor(text)
    if (!parsed) return null
    set(name, parsed.hex)
    return parsed.hex
  })
  const result = against ? verdict(value, against.value) : null
  return (
    <div className="flex flex-col gap-1 py-1.5">
      <div className="flex items-center gap-2">
        <Swatch value={value} />
        <label
          htmlFor={id}
          className="type-label flex w-36 min-w-0 shrink-0 items-center gap-2"
        >
          <span className="truncate" title={label}>
            {label}
          </span>
          <Marker show={invalid} />
        </label>
        <input
          id={id}
          className={cn(fieldClassName, "min-w-0 flex-1")}
          aria-describedby={`${id}-readout`}
          {...inputProps}
        />
      </div>
      <p
        id={`${id}-readout`}
        className="type-caption text-muted-foreground type-numeric flex justify-between gap-2 pl-6"
      >
        <span className="truncate">
          {invalid ? "Not a CSS colour" : readout(value)}
        </span>
        {result && against && (
          <span className="shrink-0" title={`Against ${against.label}`}>
            {formatRatio(result.ratio)} {result.level}
            <span className="sr-only"> against {against.label}</span>
          </span>
        )}
      </p>
    </div>
  )
}

/** A value checked against a CSS property before it is set: a dimension, a shadow, a duration. */
export function TokenField({
  name,
  label,
  value,
  property,
  compact = false,
}: {
  name: string
  label: string
  value: string
  /** The CSS property the value must be valid for, such as `width` or `box-shadow`. */
  property: string
  /** In a table row: the label is for screen readers only. */
  compact?: boolean
}) {
  const { set } = useDesign()
  const id = useId()
  const { invalid, inputProps } = useDraft(value, (text) => {
    if (!CSS.supports(property, text)) return null
    set(name, text)
    return text
  })
  if (compact) {
    return (
      <input
        id={id}
        aria-label={label}
        className={cn(fieldClassName, "type-numeric w-full min-w-0 px-1.5")}
        {...inputProps}
      />
    )
  }
  return (
    <div className="flex flex-col gap-1 py-1">
      <label htmlFor={id} className="type-label flex items-center gap-2">
        {label}
        <Marker show={invalid} />
      </label>
      <input id={id} className={fieldClassName} {...inputProps} />
    </div>
  )
}
