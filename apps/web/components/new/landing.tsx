"use client"

import { useEffect, useState, type ReactNode } from "react"

import { Panel } from "@/components/new/panel"
import {
  isPanelKey,
  PANEL_KEYS,
  PANELS,
  type PanelKey,
} from "@/components/new/panels"
import { activeSectionIndex } from "@/lib/scroll-panel"
import { cn } from "@answerable/ui/lib/utils"

/** The panel the scroll position calls for; below lg the page has only the hero. */
function currentPanel(): PanelKey {
  if (!window.matchMedia("(min-width: 64rem)").matches) return "hero"
  const sections = [...document.querySelectorAll<HTMLElement>("[data-panel]")]
  const index = activeSectionIndex({
    tops: sections.map((section) => section.getBoundingClientRect().top),
    scrollY: window.scrollY,
    maxScroll: document.documentElement.scrollHeight - window.innerHeight,
    viewportHeight: window.innerHeight,
  })
  const key = sections[index]?.dataset.panel
  return isPanelKey(key) ? key : "hero"
}

type LandingProps = {
  header: ReactNode
  hero: ReactNode
  /** The `LandingSection`s. */
  children: ReactNode
  join: ReactNode
  footer: ReactNode
}

/**
 * Owns which panel shows, which follows the scroll. The copy arrives as
 * server-rendered props; only the active key lives here. Without JS the hero
 * panel stays.
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

  useEffect(() => {
    const update = () => setActive(currentPanel())
    update()
    window.addEventListener("scroll", update, { passive: true })
    window.addEventListener("resize", update)
    return () => {
      window.removeEventListener("scroll", update)
      window.removeEventListener("resize", update)
    }
  }, [])

  return (
    <div className="grid min-h-svh grid-cols-1 grid-rows-[auto_auto_1fr] lg:grid-cols-2 lg:grid-rows-[auto_1fr]">
      {/* The header stays on top while the page scrolls; from lg it spans the
          copy column only. */}
      <div className="bg-background sticky top-0 z-30 px-6 lg:col-start-1 lg:row-start-1 lg:px-12">
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
            {children}
            {join}
          </main>

          {footer}
        </div>
      </div>
    </div>
  )
}
