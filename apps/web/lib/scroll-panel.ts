/** Where the trigger line starts, in pixels from the top of the window. */
const LINE_START = 200
/** Where it ends at the bottom of the page, as a share of the window's height. */
const LINE_END = 0.6

/**
 * Which section the page is on: the last whose top has passed a line that
 * travels down the window as the page scrolls. A fixed line skips panels: on a
 * tall window the page cannot scroll far enough for the last sections to reach
 * it, and on most windows the first section starts past it. Returns -1 before
 * the first section.
 */
export function activeSectionIndex({
  tops,
  scrollY,
  maxScroll,
  viewportHeight,
}: {
  /** Each section's top, in the window's coordinates. */
  tops: number[]
  scrollY: number
  maxScroll: number
  viewportHeight: number
}): number {
  const progress = maxScroll > 0 ? Math.min(scrollY / maxScroll, 1) : 0
  const line =
    LINE_START +
    (viewportHeight * LINE_END - LINE_START) * Math.max(progress, 0)
  return tops.findLastIndex((top) => top <= line)
}
