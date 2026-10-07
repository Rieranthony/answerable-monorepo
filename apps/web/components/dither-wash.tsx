"use client"

import { useEffect, useRef } from "react"
import { cn } from "@answerable/ui/lib/utils"

// 4×4 ordered (Bayer) matrix, normalised to 0–1 thresholds.
const BAYER4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
].map((row) => row.map((v) => (v + 0.5) / 16))

// CSS px per dither cell, and caps on the backing canvas: a background wash
// never needs more cells than this.
const CELL = 3
const MAX_COLS = 960
const MAX_ROWS = 600

/**
 * Paint a white ordered-dither ramp, solid at the bottom edge and dissolving
 * to transparent at the top, onto a low-resolution canvas sized from the
 * wrapper's box. Lit cells carry the ramp; the others keep a faint tint that
 * also fades out, so the falloff reads smooth.
 */
function paintWash(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  opacity: number,
) {
  const ctx = canvas.getContext("2d")
  if (!ctx || width <= 0 || height <= 0) return
  const cols = Math.min(MAX_COLS, Math.max(4, Math.round(width / CELL)))
  const rows = Math.min(MAX_ROWS, Math.max(4, Math.round(height / CELL)))
  canvas.width = cols
  canvas.height = rows

  for (let y = 0; y < rows; y++) {
    const density = (y + 0.5) / rows
    for (let x = 0; x < cols; x++) {
      const lit = density > BAYER4[y & 3][x & 3]
      const alpha = (lit ? 0.35 + 0.65 * density : 0.12 * density) * opacity
      if (alpha <= 0.004) continue
      ctx.fillStyle = `rgba(255,255,255,${alpha})`
      ctx.fillRect(x, y, 1, 1)
    }
  }
}

/**
 * A white dither wash that rises from the bottom edge of its nearest
 * positioned ancestor. Static: one paint per size change, no animation loop.
 */
export function DitherWash({
  opacity,
  className,
}: {
  /** Overall opacity multiplier, 0–1. */
  opacity: number
  className?: string
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const wrap = wrapRef.current
    const canvas = canvasRef.current
    if (!wrap || !canvas) return
    const paint = () => {
      const box = wrap.getBoundingClientRect()
      paintWash(canvas, box.width, box.height, opacity)
    }
    paint()
    const observer = new ResizeObserver(paint)
    observer.observe(wrap)
    return () => observer.disconnect()
  }, [opacity])

  return (
    <div
      ref={wrapRef}
      aria-hidden
      className={cn(
        "pointer-events-none absolute inset-0 overflow-hidden",
        className,
      )}
    >
      <canvas
        ref={canvasRef}
        className="absolute inset-0 h-full w-full"
        style={{ imageRendering: "pixelated" }}
      />
    </div>
  )
}
