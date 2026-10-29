import { FramedImage } from "@/components/new/framed-image"
import { FRAMING_KEYS, type FramingKey } from "@/components/new/framings"
import { COMMA_PATH, COMMA_VIEW_BOX } from "@answerable/ui/lib/logo"
import { cn } from "@answerable/ui/lib/utils"

/**
 * Measures the scrollbar's gutter (kept by `scrollbar-gutter: stable` on the
 * root, and left out of `100vw`, so CSS cannot see it) into `--gutter`, and the
 * frame into `--frame`. It reads the body's laid-out width, not
 * `clientWidth`, which reports no gutter while the page fits the window even
 * though the gutter is kept. The scrollbar may not exist yet when it first
 * runs, so it measures again once the page has loaded, and on resize, since
 * zoom changes the gutter.
 */
export const FRAME_SCRIPT = `(function(){var r=document.documentElement;function f(){var g=innerWidth-document.body.getBoundingClientRect().width;r.style.setProperty("--gutter",g+"px");r.style.setProperty("--frame",(g||16)+"px")}f();addEventListener("DOMContentLoaded",f);addEventListener("load",f);addEventListener("resize",f)})()`

const MARK = "pointer-events-none absolute z-10 size-2 bg-white"

/**
 * The sticky image column from lg: every framing stacked, the active one
 * opaque. The rest stay mounted, so a crossfade never waits for a download.
 *
 * A white frame as wide as the scrollbar's gutter sits above and below the
 * image, and to its right the gutter itself does the job. Where scrollbars
 * overlay the page the gutter is zero, so the frame is 16px and the right
 * padding makes it up. `FRAME_SCRIPT` sets both before first paint; without JS
 * the frame is 16px all round, plus any gutter on the right.
 */
export function ImageColumn({ active }: { active: FramingKey }) {
  return (
    <div className="sticky top-0 h-svh py-[var(--frame,16px)] pr-[calc(var(--frame,16px)-var(--gutter,0px))]">
      <div className="relative h-full overflow-hidden">
        {FRAMING_KEYS.map((key) => (
          <div
            key={key}
            aria-hidden={key !== active}
            className={cn(
              "absolute inset-0 transition-opacity duration-[400ms] ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none",
              key === active ? "opacity-100" : "opacity-0",
            )}
          >
            <FramedImage
              framing={key}
              eager={key === "hero"}
              decorative={key !== active}
            />
          </div>
        ))}
        {/* The old logotype's corner marks, once: three squares and the comma. */}
        <span aria-hidden="true" className={cn(MARK, "top-6 left-6")} />
        <span aria-hidden="true" className={cn(MARK, "top-6 right-6")} />
        <span aria-hidden="true" className={cn(MARK, "bottom-6 left-6")} />
        <svg
          aria-hidden="true"
          viewBox={COMMA_VIEW_BOX}
          className="pointer-events-none absolute right-6 bottom-6 z-10 h-auto w-2 fill-white"
        >
          <path d={COMMA_PATH} />
        </svg>
      </div>
    </div>
  )
}
