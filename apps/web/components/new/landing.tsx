"use client"

import { useState, type ReactNode } from "react"

import { ExpandableSections } from "@/components/expandable-sections"
import { Panel } from "@/components/new/panel"
import {
  isPanelKey,
  PANEL_KEYS,
  PANELS,
  type PanelKey,
} from "@/components/new/panels"
import { cn } from "@answerable/ui/lib/utils"

// The accordion panel's height transition, plus a frame.
const PANEL_SETTLE_MS = 220

/**
 * From lg the form shares the first screen with the sections, so after one
 * opens or closes and its height settles, bring the form back into view: the
 * least scroll that shows it whole, after the header-on-screen scroll.
 */
function keepFormInView() {
  if (!window.matchMedia("(min-width: 64rem)").matches) return
  const reduceMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)",
  ).matches
  window.setTimeout(
    () =>
      document.querySelector("#join form")?.scrollIntoView({
        block: "nearest",
        behavior: reduceMotion ? "instant" : "smooth",
      }),
    reduceMotion ? 0 : PANEL_SETTLE_MS,
  )
}

type LandingProps = {
  header: ReactNode
  hero: ReactNode
  /** The `ExpandableSection`s; their values are panel keys. */
  children: ReactNode
  join: ReactNode
  footer: ReactNode
}

/**
 * Owns which section is open, because the panel follows it. The copy arrives
 * as server-rendered props; only the open value lives here. Nothing open shows
 * the hero panel.
 *
 * The panel stack is rendered once and a grid places it: a 2:1 banner under
 * the header below lg, and from lg the sticky column beside the copy. So the
 * page has one `h1`, in the hero panel, at every width.
 */
export function Landing({
  header,
  hero,
  children,
  join,
  footer,
}: LandingProps) {
  const [active, setActive] = useState<PanelKey>("hero")

  return (
    <div className="grid min-h-svh grid-cols-1 grid-rows-[auto_auto_1fr] lg:grid-cols-2 lg:grid-rows-[auto_1fr]">
      {/* The header stays on top while the page scrolls; from lg it spans the
          copy column only. `data-sticky-header` lets the sections scroll a
          header they open clear of it. */}
      <div
        data-sticky-header
        className="bg-background sticky top-0 z-30 px-6 lg:col-start-1 lg:row-start-1 lg:px-12"
      >
        <div className="mx-auto w-full max-w-[560px]">{header}</div>
      </div>

      {/* Phones: edge to edge under the header. From lg: the right column
          across both rows, the frame around it. The frame is as wide as the
          scrollbar's gutter, above and below the image, and to its right the
          gutter itself does the job. Where scrollbars overlay the page the
          gutter is zero, so the frame is 16px and the right padding makes it
          up. `FRAME_SCRIPT` sets both before first paint; without JS the frame
          is 16px all round, plus any gutter on the right. */}
      <div className="lg:col-start-2 lg:row-span-2 lg:row-start-1">
        <div className="lg:sticky lg:top-0 lg:h-svh lg:py-[var(--frame,16px)] lg:pr-[calc(var(--frame,16px)-var(--gutter,0px))]">
          <div className="relative aspect-[2/1] overflow-hidden lg:aspect-auto lg:h-full">
            {PANEL_KEYS.map((key) => (
              // The rest stay mounted, so a crossfade never waits for a
              // download. The hero panel carries the `h1`, so it is never
              // hidden from assistive technology.
              <div
                key={key}
                aria-hidden={key !== active && key !== "hero"}
                className={cn(
                  "absolute inset-0 transition-opacity duration-[400ms] ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none",
                  key === active ? "opacity-100" : "opacity-0",
                )}
              >
                <Panel
                  panel={PANELS[key]}
                  shape="responsive"
                  active={key === active}
                  heading={key === "hero"}
                  eager={key === "hero"}
                />
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="flex flex-col px-6 lg:col-start-1 lg:row-start-2 lg:px-12">
        <div className="mx-auto flex w-full max-w-[560px] grow flex-col">
          <main className="mt-8 flex flex-col gap-12">
            {hero}
            <div>
              <p className="text-muted-foreground text-sm/6">
                Click to expand below:
              </p>
              <div className="mt-2">
                <ExpandableSections
                  onValueChange={(value) => {
                    const open = value[0]
                    setActive(isPanelKey(open) ? open : "hero")
                    keepFormInView()
                  }}
                >
                  {children}
                </ExpandableSections>
              </div>
            </div>
            {join}
          </main>

          {footer}
        </div>
      </div>
    </div>
  )
}
