"use client"

import { useEffect, useRef, useState } from "react"

import { COMMA_PATH } from "@answerable/ui/lib/logo"

// The comma's head is a 48-unit square centred on (1128, 240); at 4/3 it is
// 64px on screen. This puts that centre on the SVG origin, which the nested
// <svg x="50%" y="50%"> places at the middle of the viewport.
const COMMA_AT_ORIGIN = "scale(1.3333333) translate(-1128 -240)"

/** Picks the field colour before first paint; the CSS default is highlight 1. */
export const SPLASH_COLOUR_SCRIPT = `document.documentElement.style.setProperty("--splash","var(--highlight-"+(1+Math.floor(Math.random()*4))+")")`

/**
 * The entrance: an accent field, three squares that become the comma, and the
 * comma opening as a window onto the page. All motion is CSS (`.splash-*` in
 * globals.css); this component only removes the overlay when it is over, and
 * lets a click or key press skip it. The page is under it from the first byte.
 */
export function Splash() {
  const ref = useRef<HTMLDivElement>(null)
  const [gone, setGone] = useState(false)

  useEffect(() => {
    const overlay = ref.current
    if (!overlay) return

    const skip = () => overlay.setAttribute("data-skip", "")
    const end = (event: AnimationEvent) => {
      if (event.target === overlay) setGone(true)
    }
    overlay.addEventListener("animationend", end)
    window.addEventListener("pointerdown", skip, { once: true })
    window.addEventListener("keydown", skip, { once: true })

    // Reduced motion hides the overlay, so no animation ends; the timer is
    // also the fallback if one never does.
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    const timer = window.setTimeout(() => setGone(true), reduce ? 0 : 3000)

    return () => {
      overlay.removeEventListener("animationend", end)
      window.removeEventListener("pointerdown", skip)
      window.removeEventListener("keydown", skip)
      window.clearTimeout(timer)
    }
  }, [])

  if (gone) return null

  return (
    <div ref={ref} aria-hidden="true" className="splash fixed inset-0 z-50">
      {/* The same white frame as the image column's, so the field and the
          comma sit inside it and it hands over to the page's own frame. */}
      <div className="splash-frame" />
      <div className="splash-inset">
        <svg width="100%" height="100%" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <mask
              id="splash-mask"
              maskUnits="userSpaceOnUse"
              x="0"
              y="0"
              width="100%"
              height="100%"
            >
              <rect width="100%" height="100%" fill="white" />
              <svg x="50%" y="50%" overflow="visible">
                {/* The hole: black cuts the field away. */}
                <g className="splash-hole">
                  <path
                    d={COMMA_PATH}
                    fill="black"
                    transform={COMMA_AT_ORIGIN}
                  />
                </g>
              </svg>
            </mask>
          </defs>

          <rect
            width="100%"
            height="100%"
            className="splash-field"
            mask="url(#splash-mask)"
          />

          <svg x="50%" y="50%" overflow="visible">
            {/* Squares 64px wide, 32px apart: centres at -96, 0 and 96. The row
              slides 96px left so the third, the comma, lands on the origin. */}
            <g className="splash-row">
              <g transform="translate(-96 0)">
                <rect
                  className="splash-dot splash-dot-1"
                  x="-32"
                  y="-32"
                  width="64"
                  height="64"
                  fill="white"
                />
              </g>
              <g>
                <rect
                  className="splash-dot splash-dot-2"
                  x="-32"
                  y="-32"
                  width="64"
                  height="64"
                  fill="white"
                />
              </g>
              <g transform="translate(96 0)">
                <g className="splash-dot-3">
                  <g className="splash-mark">
                    {/* The comma is the square plus a tail; its tail is clipped
                      away until it grows, so the third square becomes it. */}
                    <g transform={COMMA_AT_ORIGIN}>
                      <path
                        className="splash-comma"
                        d={COMMA_PATH}
                        fill="white"
                      />
                    </g>
                  </g>
                </g>
              </g>
            </g>
          </svg>
        </svg>
      </div>
    </div>
  )
}
