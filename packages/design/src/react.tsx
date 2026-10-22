"use client"

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react"
import { designToTokens, serializeHooks } from "./emit"
import { googleFontsHref } from "./fonts"
import { designToMarkdown } from "./markdown"
import { applyOverrides } from "./overrides"
import { designHooks, fontRequests } from "./runtime"
import type { Design, DesignToken } from "./types"

/** The design state `useDesign()` returns. */
export interface DesignState {
  /** The design as parsed. */
  design: Design
  /** The design with the overrides applied. */
  current: Design
  /** The contract tokens, overrides applied. */
  tokens: DesignToken[]
  /** Contract token names (`primary`) or design paths (`colors.accent-coral`) → the value set. */
  overrides: Record<string, string>
  /** Sets a contract token (`primary`, `type-button-size`) or a design path (`colors.neutral-100`, `fonts.sans.family`). */
  set(name: string, value: string): void
  /** Removes one override, or all of them. */
  reset(name?: string): void
  /** Token name → value: what `DesignVars` declares as `--design-<name>`. */
  hooks: Record<string, string>
  /** The `:root` block of hooks. */
  css: string
  /** The design's DESIGN.md with the overrides written in. */
  markdown: string
}

interface Context extends DesignState {
  fonts: Record<string, string>
}

const DesignContext = createContext<Context | null>(null)

const NO_FONTS: Record<string, string> = {}

/**
 * Holds a design and its overrides for the tree below. `fonts` maps a family to the CSS family a
 * self-hosted `next/font` gives it (`{ "Public Sans": publicSans.style.fontFamily }`), so the default
 * font is not loaded twice.
 */
export function DesignProvider({
  design,
  fonts = NO_FONTS,
  children,
}: {
  design: Design
  fonts?: Record<string, string>
  children?: ReactNode
}) {
  const [overrides, setOverrides] = useState<Record<string, string>>({})
  const set = useCallback(
    (name: string, value: string) =>
      setOverrides((previous) => ({ ...previous, [name]: value })),
    [],
  )
  const reset = useCallback(
    (name?: string) =>
      setOverrides((previous) => {
        if (name === undefined) return {}
        const next = { ...previous }
        delete next[name]
        return next
      }),
    [],
  )
  const base = useMemo(() => designToTokens(design), [design])
  const value = useMemo<Context>(() => {
    const current = applyOverrides(design, overrides)
    const tokens = designToTokens(current)
    const hooks = designHooks(base, current, tokens, fonts)
    let markdown: string | undefined
    return {
      design,
      current,
      tokens,
      overrides,
      set,
      reset,
      hooks,
      fonts,
      css: serializeHooks(hooks),
      get markdown() {
        markdown ??= designToMarkdown(design.source, current)
        return markdown
      },
    }
  }, [design, overrides, base, fonts, set, reset])
  return <DesignContext value={value}>{children}</DesignContext>
}

function useContextValue(): Context {
  const value = useContext(DesignContext)
  if (!value)
    throw new Error("useDesign() must be called inside a DesignProvider.")
  return value
}

/** The design state of the nearest `DesignProvider`. */
export function useDesign(): DesignState {
  return useContextValue()
}

/**
 * Declares the hooks: every token the overrides change, and `--design-font-sans` with the self-hosted family.
 * With `scope`, under `[data-design-scope="<scope>"]` instead of `:root`. A plain `<style>`, rendered where it
 * sits, so the server's HTML carries it and React keeps its text in step with the overrides.
 */
export function DesignVars({ scope }: { scope?: string }) {
  const { hooks } = useContextValue()
  const name = scope?.replace(/[^A-Za-z0-9_-]/g, "-")
  const selector = name ? `[data-design-scope="${name}"]` : ":root"
  return (
    <style data-design-vars={name ?? "root"}>
      {serializeHooks(hooks, selector)}
    </style>
  )
}

/** Loads, from Google Fonts, every family the design or the overrides name that the provider's `fonts` does not self-host. */
export function DesignFonts() {
  const { current, fonts } = useContextValue()
  return fontRequests(current, fonts).map((request) => (
    <link
      key={request.family}
      rel="stylesheet"
      precedence="design-fonts"
      href={googleFontsHref([request])}
    />
  ))
}
