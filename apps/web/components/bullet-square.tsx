/**
 * A square from the logo frame, used as a list bullet: a 6px square
 * optically centered inside a 6×24 box so it aligns with a 24px line box.
 */
export function BulletSquare() {
  return (
    <span aria-hidden="true" className="flex h-6 w-1.5 shrink-0 items-center">
      <svg viewBox="0 0 48 48" fill="currentColor" className="size-1.5">
        <rect width="48" height="48" />
      </svg>
    </span>
  )
}
