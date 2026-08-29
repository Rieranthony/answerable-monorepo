"use client"

import { useEffect, useState } from "react"
import { preload } from "react-dom"

import { COMMA_PATH } from "@/components/logo"
import {
  ACTIVE_PHOTO,
  COMMA_BOX,
  COMMA_SCALE,
  computeMosaicLayout,
  MOSAIC,
  MOSAIC_PHOTOS,
} from "@/lib/mosaic-layout"
import { cn } from "@/lib/utils"

/**
 * The hero mosaic: one photo clipped into the logo's shapes on one inline
 * SVG, so it scales to any band height. The seeded layout is deterministic,
 * so the server-prerendered markup and the client hydration always match.
 * Pressing Space cycles through the candidate photos (try-out helper; the
 * default is ACTIVE_PHOTO).
 *
 * Transform composition is deliberate: the animated wrapper <g> carries NO
 * transform attribute (the CSS entrance animation would replace it), the
 * static child <g> owns cell placement, and comma rotation is baked into
 * pre-rotated <clipPath> defs — the clip shape rotates, never the photo.
 */
const MARKS = computeMosaicLayout()

const W = MOSAIC.cols * MOSAIC.cell // 816
const H = MOSAIC.rows * MOSAIC.cell // 864
const PW = MOSAIC.photoCols * MOSAIC.cell // 576 — the photo, 2:3
const PHOTO_X = W - PW // photo anchored to the rightmost columns
const INSET = MOSAIC.gap / 2
const TILE = MOSAIC.cell - MOSAIC.gap // visible window inside a cell
/** Shrink factor that carves the gutter out of a cell-sized shape. */
const TILE_SCALE = TILE / MOSAIC.cell

/**
 * Normalizes COMMA_PATH to the owning cell's origin, pre-rotated, and shrunk
 * about the cell center so the tile gutter applies to commas too. Read right
 * to left: normalize to 0..48, shrink about (24,24), rotate about (24,24).
 */
const commaTransform = (rot: number) =>
  `${rot ? `rotate(${rot} 24 24) ` : ""}translate(24 24) scale(${TILE_SCALE}) translate(-24 -24) scale(${COMMA_SCALE}) translate(${-COMMA_BOX.x} ${-COMMA_BOX.y})`

export function Mosaic({ className }: { className?: string }) {
  const [photo, setPhoto] = useState<(typeof MOSAIC_PHOTOS)[number]>(ACTIVE_PHOTO)

  // Emits one <link rel="preload"> in <head>; the mosaic renders on every
  // viewport, so the photo is always worth fetching early.
  preload(photo, { as: "image", type: "image/webp" })

  // Space cycles through the candidate photos, except while typing in a
  // form field. The other sprites are pre-warmed so the swap is instant.
  useEffect(() => {
    for (const candidate of MOSAIC_PHOTOS)
      preload(candidate, { as: "image", type: "image/webp" })
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== "Space" && event.key !== " ") return
      if (
        event.target instanceof Element &&
        event.target.closest("input, textarea, select, [contenteditable]")
      )
        return
      event.preventDefault()
      setPhoto(
        (current) =>
          MOSAIC_PHOTOS[
            (MOSAIC_PHOTOS.indexOf(current) + 1) % MOSAIC_PHOTOS.length
          ],
      )
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="xMaxYMid slice"
      aria-hidden="true"
      className={cn("dark:opacity-90", className)}
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <clipPath id="mz-sq">
          <rect x={INSET} y={INSET} width={TILE} height={TILE} />
        </clipPath>
        {([0, 90, 180, 270] as const).map((rot) => (
          <clipPath key={rot} id={`mz-c${rot}`}>
            <path d={COMMA_PATH} transform={commaTransform(rot)} />
          </clipPath>
        ))}
      </defs>
      {MARKS.map((m, i) => {
        const x = m.col * MOSAIC.cell
        const y = m.row * MOSAIC.cell
        const style = { animationDelay: `${m.delayMs}ms` }

        if (m.shape === "semicolon")
          return (
            <g
              key={i}
              className="mosaic-tile fill-mosaic-mark"
              fillOpacity={m.fade}
              style={style}
            >
              <rect x={x + INSET} y={y + INSET} width={TILE} height={TILE} />
              <g transform={`translate(${x} ${y + 72})`}>
                <path d={COMMA_PATH} transform={commaTransform(0)} />
              </g>
            </g>
          )

        if (m.fill === "solid")
          return (
            <g
              key={i}
              className="mosaic-tile fill-mosaic-mark"
              fillOpacity={m.fade}
              style={style}
            >
              <g transform={`translate(${x} ${y})`}>
                {m.shape === "square" ? (
                  <rect x={INSET} y={INSET} width={TILE} height={TILE} />
                ) : (
                  <path d={COMMA_PATH} transform={commaTransform(m.rot)} />
                )}
              </g>
            </g>
          )

        // Image tile: the full photo sits under a cell-local clip window,
        // so fragments align perfectly across tiles and every tile reuses
        // the same single decoded bitmap.
        const clip = m.shape === "square" ? "mz-sq" : `mz-c${m.rot}`
        return (
          <g key={i} className="mosaic-tile" style={style}>
            <g transform={`translate(${x} ${y})`} clipPath={`url(#${clip})`}>
              <image
                href={photo}
                x={PHOTO_X - x}
                y={-y}
                width={PW}
                height={H}
                className={m.gray ? "grayscale" : undefined}
                {...({ loading: "lazy" } as object)}
              />
            </g>
          </g>
        )
      })}
    </svg>
  )
}
