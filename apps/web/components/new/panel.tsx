import type { CSSProperties, ReactNode } from "react"

import { FramedImage } from "@/components/new/framed-image"
import { GridFrame } from "@/components/new/grid-frame"
import {
  PANELS,
  type Panel as PanelData,
  type PanelKey,
} from "@/components/new/panels"
import { COMMA_PATH, COMMA_VIEW_BOX } from "@answerable/ui/lib/logo"
import { cn } from "@answerable/ui/lib/utils"

/**
 * `banner` is the 2:1 phone banner, and `responsive` is a banner below `lg` and
 * the desktop sticky column from it, so the stack is rendered once and the page
 * keeps one `h1`.
 */
type Shape = "banner" | "responsive"

/**
 * What differs between the two shapes, as literal classes so Tailwind finds
 * them. Everything is in `cqw`, the panel's own width, so one rule holds at
 * every size.
 */
const BANNER_BAND =
  "[background-image:linear-gradient(to_bottom,transparent_4%,rgba(0,0,0,var(--scrim))_30%,rgba(0,0,0,var(--scrim))_70%,transparent_96%)]"
const SHAPES = {
  // The band behind the words: it holds its strength across the words' height.
  band: {
    banner: BANNER_BAND,
    responsive: `${BANNER_BAND} lg:[background-image:linear-gradient(to_bottom,transparent_20%,rgba(0,0,0,var(--scrim))_38%,rgba(0,0,0,var(--scrim))_62%,transparent_80%)]`,
  },
  // Small enough on a banner to stay clear of the words in the middle.
  comma: {
    banner: "right-[6cqw] bottom-[6cqw] w-[9cqw]",
    responsive:
      "right-[6cqw] bottom-[6cqw] w-[9cqw] lg:right-[8cqw] lg:bottom-[8cqw] lg:w-[22cqw]",
  },
  // The window: centred near the bottom of a column, at the right of a banner.
  window: {
    banner: "top-[8%] right-[6cqw] h-[84%]",
    responsive:
      "top-[8%] right-[6cqw] h-[84%] lg:top-auto lg:right-auto lg:bottom-[10cqw] lg:left-1/2 lg:h-[62%] lg:-translate-x-1/2",
  },
} satisfies Record<string, Record<Shape, string>>

const WORDS_STYLE: CSSProperties = {
  fontSize: "clamp(24px, 5.7cqw, 48px)",
  lineHeight: 1.1,
}
const WORDS =
  "absolute inset-0 z-10 flex items-center justify-center px-[10cqw] text-center font-bold tracking-[-0.02em] text-balance text-white"

// The comma as a CSS mask, so an image can show through its shape.
const COMMA_MASK = `url("data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${COMMA_VIEW_BOX}"><path d="${COMMA_PATH}"/></svg>`,
)}")`

const COMMA_WINDOW: CSSProperties = {
  maskImage: COMMA_MASK,
  maskSize: "contain",
  maskRepeat: "no-repeat",
  maskPosition: "center",
}

type PanelProps = {
  panel: PanelData
  shape: Shape
  /** Whether the panel is showing; an inactive image is decorative. */
  active: boolean
  /** Renders the words as the page's `h1`. Only the hero panel has one. */
  heading?: boolean
  /** Loads the image at once, for the panel the page opens on. */
  eager?: boolean
}

/**
 * One panel, filling its positioned parent. It is a size container, so
 * everything inside scales with the panel's width. The words on it are
 * `aria-hidden`, because the sections carry the titles, except the headline
 * when it is the page's `h1`.
 */
export function Panel({
  panel,
  shape,
  active,
  heading = false,
  eager = false,
}: PanelProps) {
  return (
    <div
      className={cn(
        "@container absolute inset-0 overflow-hidden",
        panel.kind !== "image" && "bg-black",
      )}
    >
      {panel.kind === "image" && (
        <ImagePanel
          panel={panel}
          shape={shape}
          active={active}
          heading={heading}
          eager={eager}
        />
      )}
      {panel.kind === "statement" && (
        <StatementPanel panel={panel} shape={shape} />
      )}
      {panel.kind === "window" && (
        <WindowPanel
          panel={panel}
          shape={shape}
          active={active}
          eager={eager}
        />
      )}
    </div>
  )
}

function ImagePanel({
  panel,
  shape,
  active,
  heading,
  eager,
}: {
  panel: Extract<PanelData, { kind: "image" }>
  shape: Shape
  active: boolean
  heading: boolean
  eager: boolean
}) {
  const mark = "pointer-events-none absolute z-10 size-[3.5cqw] bg-white"

  return (
    <>
      <FramedImage
        image={panel.image}
        x={panel.x}
        alt={panel.alt}
        eager={eager}
        decorative={!active}
        zoom={shape === "banner" ? panel.bannerZoom : undefined}
      />
      {panel.scrim > 0 && (
        <div
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute inset-0",
            SHAPES.band[shape],
          )}
          style={{ "--scrim": panel.scrim } as CSSProperties}
        />
      )}
      {heading ? (
        <h1 className={WORDS} style={WORDS_STYLE}>
          {panel.words}
        </h1>
      ) : (
        <div aria-hidden="true" className={WORDS} style={WORDS_STYLE}>
          {panel.words}
        </div>
      )}
      {/* The old logotype's corner marks, once: three squares and the comma. */}
      <span
        aria-hidden="true"
        className={cn(mark, "top-[3.5cqw] left-[3.5cqw]")}
      />
      <span
        aria-hidden="true"
        className={cn(mark, "top-[3.5cqw] right-[3.5cqw]")}
      />
      <span
        aria-hidden="true"
        className={cn(mark, "bottom-[3.5cqw] left-[3.5cqw]")}
      />
      <Comma className="pointer-events-none absolute right-[3.5cqw] bottom-[3.5cqw] z-10 w-[3.5cqw]" />
    </>
  )
}

function StatementPanel({
  panel,
  shape,
}: {
  panel: Extract<PanelData, { kind: "statement" }>
  shape: Shape
}) {
  return (
    <>
      <div aria-hidden="true" className={WORDS} style={WORDS_STYLE}>
        {panel.words}
      </div>
      <Comma className={cn("absolute", SHAPES.comma[shape])} />
    </>
  )
}

function WindowPanel({
  panel,
  shape,
  active,
  eager,
}: {
  panel: Extract<PanelData, { kind: "window" }>
  shape: Shape
  active: boolean
  eager: boolean
}) {
  return (
    <>
      <div
        aria-hidden="true"
        className="absolute top-[7cqw] left-[7cqw] z-10 font-bold tracking-[-0.02em] text-white"
        style={{ fontSize: "clamp(16px, 3.2cqw, 26px)", lineHeight: 1.15 }}
      >
        <GridFrame>Answerable AP</GridFrame>
      </div>
      <div
        className={cn("absolute aspect-[48.21/72.002]", SHAPES.window[shape])}
        style={COMMA_WINDOW}
      >
        <FramedImage
          image={panel.image}
          x={panel.x}
          alt={panel.alt}
          eager={eager}
          decorative={!active}
        />
      </div>
    </>
  )
}

function Comma({ className }: { className: string }): ReactNode {
  return (
    <svg
      aria-hidden="true"
      viewBox={COMMA_VIEW_BOX}
      className={cn("h-auto fill-white", className)}
    >
      <path d={COMMA_PATH} />
    </svg>
  )
}

/**
 * A section of the copy, which the sticky column follows from lg through
 * `data-panel`. Below lg the section's own panel sits above it, edge to edge;
 * from lg it is hidden and its lazy image never loads. A panel with words on it
 * shows the title there, so the heading is for screen readers only below lg.
 */
export function LandingSection({
  panelKey,
  title,
  children,
}: {
  panelKey: Exclude<PanelKey, "hero">
  title: string
  children: ReactNode
}) {
  const panel = PANELS[panelKey]
  return (
    <section data-panel={panelKey} className="flex flex-col gap-4">
      <div className="relative -mx-6 aspect-[2/1] lg:hidden">
        <Panel panel={panel} shape="banner" active />
      </div>
      <h2
        className={cn(
          "text-lg/6 font-bold",
          panel.kind !== "window" && "sr-only lg:not-sr-only",
        )}
      >
        {title}
      </h2>
      {children}
    </section>
  )
}
