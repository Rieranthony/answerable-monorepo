/**
 * Where to scroll so a header that is about to open stays on screen.
 *
 * Opening one section collapses the one already open. When that section
 * sits above the tapped header, the header drifts up by the collapsing
 * height and can leave the viewport. Both motions take about the same time,
 * so aiming at the header's final position lands it in one movement.
 *
 * Returns null when the header will still be visible without help.
 */
export function scrollTargetForOpeningHeader({
  headerTop,
  collapsingHeightAbove,
  scrollY,
  margin,
}: {
  headerTop: number
  collapsingHeightAbove: number
  scrollY: number
  margin: number
}): number | null {
  const finalTop = headerTop - collapsingHeightAbove
  if (finalTop >= margin) return null
  return Math.max(0, scrollY + finalTop - margin)
}
