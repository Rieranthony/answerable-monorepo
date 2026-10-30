import type { CSSProperties, ReactNode } from "react"

import { FramedImage } from "@/components/new/framed-image"
import { GridFrame } from "@/components/new/grid-frame"
import {
  PANELS,
  VALUES,
  type Panel as PanelData,
  type PanelKey,
} from "@/components/new/panels"
import { CredentialMark } from "@/components/new/credential-mark"
import { COMMA_PATH, COMMA_VIEW_BOX } from "@answerable/ui/lib/logo"
import { cn } from "@answerable/ui/lib/utils"

/**
 * `column` is the desktop sticky column, `banner` the 2:1 phone banner, and
 * `responsive` is a banner below `lg` and a column from it, so the stack is
 * rendered once and the page keeps one `h1`.
 */
type Shape = "column" | "banner" | "responsive"

/**
 * What differs between the two shapes, as literal classes so Tailwind finds
 * them. Everything is in `cqw`, the panel's own width, so one rule holds at
 * every size.
 */
const SHAPES = {
  // Gradient height: half the column, all of a banner.
  scrim: {
    column: "h-1/2",
    banner: "h-full",
    responsive: "h-full lg:h-1/2",
  },
  // The six values fit a column; a banner shows only the title.
  list: {
    column: "flex",
    banner: "hidden",
    responsive: "hidden lg:flex",
  },
  title: {
    column: "hidden",
    banner: "block",
    responsive: "block lg:hidden",
  },
  comma: {
    column: "right-[8cqw] bottom-[8cqw] w-[22cqw]",
    banner: "right-[6cqw] bottom-[6cqw] w-[14cqw]",
    responsive:
      "right-[6cqw] bottom-[6cqw] w-[14cqw] lg:right-[8cqw] lg:bottom-[8cqw] lg:w-[22cqw]",
  },
  // The window: centred near the bottom of a column, at the right of a banner.
  window: {
    column: "bottom-[10cqw] left-1/2 h-[62%] -translate-x-1/2",
    banner: "top-[8%] right-[6cqw] h-[84%]",
    responsive:
      "top-[8%] right-[6cqw] h-[84%] lg:top-auto lg:right-auto lg:bottom-[10cqw] lg:left-1/2 lg:h-[62%] lg:-translate-x-1/2",
  },
} satisfies Record<string, Record<Shape, string>>

const TEXT_STYLES = {
  headline: { fontSize: "clamp(24px, 5.7cqw, 48px)", lineHeight: 1.1 },
  title: { fontSize: "clamp(20px, 4cqw, 34px)", lineHeight: 1.15 },
  label: { fontSize: "clamp(16px, 3.2cqw, 26px)", lineHeight: 1.15 },
} satisfies Record<string, CSSProperties>

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

// Top left, 7cqw in: the corner marks' inset plus their size.
const TEXT_BOX = "absolute top-[7cqw] right-[12cqw] left-[7cqw] z-10 text-white"

type PanelProps = {
  panel: PanelData
  shape: Shape
  /** Whether the panel is showing; an inactive image is decorative. */
  active: boolean
  /** Renders the headline as the page's `h1`. Only the hero panel has one. */
  heading?: boolean
  /** Loads the image at once, for the panel the page opens on. */
  eager?: boolean
  /** Leaves the title off, where the accordion shows it right above. */
  bare?: boolean
}

/**
 * One panel, filling its positioned parent. It is a size container, so
 * everything inside scales with the panel's width. The text on it is
 * `aria-hidden`, because the accordion carries the titles, except the headline
 * when it is the page's `h1`.
 */
export function Panel({
  panel,
  shape,
  active,
  heading = false,
  eager = false,
  bare = false,
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
          bare={bare}
        />
      )}
      {panel.kind === "statement" && (
        <StatementPanel panel={panel} shape={shape} bare={bare} />
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
  bare,
}: {
  panel: Extract<PanelData, { kind: "image" }>
  shape: Shape
  active: boolean
  heading: boolean
  eager: boolean
  bare: boolean
}) {
  const text = bare ? undefined : panel.text
  const { scrim } = panel
  const mark = "pointer-events-none absolute z-10 size-[3.5cqw] bg-white"

  return (
    <>
      <FramedImage
        image={panel.image}
        x={panel.x}
        alt={panel.alt}
        eager={eager}
        decorative={!active}
      />
      {text && scrim > 0 && (
        <div
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute inset-x-0 top-0",
            SHAPES.scrim[shape],
          )}
          style={{
            backgroundImage: `linear-gradient(to bottom, rgba(0,0,0,${scrim}), rgba(0,0,0,0))`,
          }}
        />
      )}
      {text && <PanelText text={text} heading={heading} />}
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

function PanelText({
  text,
  heading,
}: {
  text: NonNullable<Extract<PanelData, { kind: "image" }>["text"]>
  heading: boolean
}) {
  const style = TEXT_STYLES[text.style]
  const type = "font-bold tracking-[-0.02em] text-balance"

  if (text.style === "headline" && heading) {
    return (
      <h1 className={cn(TEXT_BOX, type, "lg:max-w-[10em]")} style={style}>
        {text.value}
      </h1>
    )
  }
  return (
    <div aria-hidden="true" className={cn(TEXT_BOX, type)} style={style}>
      {text.style === "label" ? (
        <GridFrame>{text.value}</GridFrame>
      ) : (
        text.value
      )}
    </div>
  )
}

function StatementPanel({
  panel,
  shape,
  bare,
}: {
  panel: Extract<PanelData, { kind: "statement" }>
  shape: Shape
  bare: boolean
}) {
  return (
    <>
      <ol
        aria-hidden="true"
        className={cn(
          TEXT_BOX,
          "list-none flex-col font-bold",
          SHAPES.list[shape],
        )}
        style={{
          fontSize: "clamp(14px, 2.6cqw, 22px)",
          lineHeight: 1.25,
          gap: "2.2cqw",
        }}
      >
        {VALUES.map((value, index) => (
          <li key={value} className="flex gap-[1.2em]">
            <span className="w-[1ch] shrink-0 font-black tabular-nums">
              {index + 1}
            </span>
            <span>{value}</span>
          </li>
        ))}
      </ol>
      {!bare && (
        <div
          aria-hidden="true"
          className={cn(
            TEXT_BOX,
            "font-bold tracking-[-0.02em] text-balance",
            SHAPES.title[shape],
          )}
          style={TEXT_STYLES.title}
        >
          {panel.title}
        </div>
      )}
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
        className={cn(TEXT_BOX, "font-bold tracking-[-0.02em]")}
        style={TEXT_STYLES.label}
      >
        <CredentialMark />
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
 * A section's panel at the top of its accordion panel on phones: a 2:1 banner,
 * always showing, without the title the accordion shows right above it. From
 * lg the sticky column shows it instead; the lazy image inside a hidden box
 * never loads.
 */
export function SectionPanel({
  panelKey,
}: {
  panelKey: Exclude<PanelKey, "hero">
}) {
  return (
    <div className="relative aspect-[2/1] w-full lg:hidden">
      <Panel panel={PANELS[panelKey]} shape="banner" active bare />
    </div>
  )
}
