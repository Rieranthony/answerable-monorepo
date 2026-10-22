"use client"

import { useMemo } from "react"
import { useDesign } from "@answerable/design/react"

/** The contract tokens of the current design, name → value, overrides applied. */
export function useTokens(): ReadonlyMap<string, string> {
  const { tokens } = useDesign()
  return useMemo(
    () => new Map(tokens.map((token) => [token.name, token.value])),
    [tokens],
  )
}

/** A token's current value as text, so a readout follows the pane. */
export function TokenValue({ name }: { name: string }) {
  return <>{useTokens().get(name) ?? "unset"}</>
}
