"use client"

import { useEffect, useState, useSyncExternalStore } from "react"

import {
  MOSAIC_DITHER,
  type DitherSettings,
  type DitherType,
} from "@/lib/mosaic-layout"

/**
 * Dev-only panel for dialling in the mosaic dither. Guarded by NODE_ENV at
 * the call site so the whole component drops out of production bundles.
 *
 * Edits are per scheme and persisted to localStorage, so tuning survives
 * reloads. "Copy" emits the MOSAIC_DITHER literal to paste back into
 * lib/mosaic-layout.ts — once the values are settled, bake them in and this
 * panel can go.
 */

const STORAGE_KEY = "mosaic-dither-tuning"
const TYPES: DitherType[] = ["random", "2x2", "4x4", "8x8"]

export type Tuning = Record<"light" | "dark", DitherSettings>

export function loadTuning(): Tuning | null {
  if (typeof window === "undefined") return null
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as Tuning) : null
  } catch {
    return null
  }
}

interface MosaicTunerProps {
  scheme: "light" | "dark"
  tuning: Tuning
  onChange: (next: Tuning) => void
}

const emptySubscribe = () => () => {}

export function MosaicTuner({ scheme, tuning, onChange }: MosaicTunerProps) {
  const [copied, setCopied] = useState(false)
  // Stored tuning is only available on the client, so render nothing until
  // after hydration rather than emit markup the server cannot match.
  const mounted = useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false,
  )
  const current = tuning[scheme]

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(tuning))
    } catch {
      // Private mode or blocked storage — tuning just will not persist.
    }
  }, [tuning])

  const set = (patch: Partial<DitherSettings>) =>
    onChange({ ...tuning, [scheme]: { ...current, ...patch } })

  const copy = () => {
    const literal = `export const MOSAIC_DITHER: Record<"light" | "dark", DitherSettings> = ${JSON.stringify(tuning, null, 2)}`
    void navigator.clipboard?.writeText(literal)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1200)
  }

  const reset = () => onChange(structuredClone(MOSAIC_DITHER) as Tuning)

  if (!mounted) return null

  return (
    <div className="border-border bg-background/95 fixed bottom-4 left-4 z-50 flex w-60 flex-col gap-2 border p-3 font-mono text-[11px] backdrop-blur">
      <div className="flex items-center justify-between">
        <strong className="font-bold">dither · {scheme}</strong>
        <span className="text-muted-foreground">dev only</span>
      </div>

      <label className="flex items-center justify-between gap-2">
        type
        <select
          value={current.type}
          onChange={(e) => set({ type: e.target.value as DitherType })}
          className="border-border border bg-transparent px-1 py-0.5"
        >
          {TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1">
        <span className="flex justify-between">
          size <span>{current.size}</span>
        </span>
        <input
          type="range"
          min={0.5}
          max={20}
          step={0.5}
          value={current.size}
          onChange={(e) => set({ size: Number(e.target.value) })}
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="flex justify-between">
          colorSteps <span>{current.colorSteps}</span>
        </span>
        <input
          type="range"
          min={1}
          max={7}
          step={1}
          value={current.colorSteps}
          onChange={(e) => set({ colorSteps: Number(e.target.value) })}
        />
      </label>

      <label className="flex items-center justify-between">
        inverted
        <input
          type="checkbox"
          checked={current.inverted}
          onChange={(e) => set({ inverted: e.target.checked })}
        />
      </label>

      {(["colorFront", "colorBack", "colorHighlight"] as const).map((key) => (
        <label key={key} className="flex items-center justify-between">
          {key.replace("color", "").toLowerCase()}
          <input
            type="color"
            value={current[key]}
            onChange={(e) => set({ [key]: e.target.value })}
            className="h-5 w-10 bg-transparent"
          />
        </label>
      ))}

      <div className="flex gap-2 pt-1">
        <button
          type="button"
          onClick={copy}
          className="border-border hover:bg-muted flex-1 border px-2 py-1"
        >
          {copied ? "copied" : "copy"}
        </button>
        <button
          type="button"
          onClick={reset}
          className="border-border hover:bg-muted flex-1 border px-2 py-1"
        >
          reset
        </button>
      </div>
    </div>
  )
}
