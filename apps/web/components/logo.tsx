import type { SVGProps } from "react"

import { COMMA_PATH, LOGO_PATHS, LOGO_VIEW_BOX } from "@answerable/ui/lib/logo"

export { COMMA_PATH, LOGO_PATHS } from "@answerable/ui/lib/logo"
export type { LogoGroup, LogoPath } from "@answerable/ui/lib/logo"

const FRAME = LOGO_PATHS.filter((path) => path.group === "frame")
const WORDMARK = LOGO_PATHS.filter((path) => path.group === "wordmark")

export function Logo(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox={LOGO_VIEW_BOX}
      fill="currentColor"
      role="img"
      aria-label="Answerable"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <g data-logo-group="frame">
        {FRAME.map((path) => (
          <path key={path.id} data-logo-part={path.id} d={path.d} />
        ))}
      </g>
      <g data-logo-group="wordmark">
        {WORDMARK.map((path) => (
          <path key={path.id} data-logo-part={path.id} d={path.d} />
        ))}
      </g>
    </svg>
  )
}

/** A square from the logo's frame, on its own canvas. */
export function SquareMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 48 48"
      fill="currentColor"
      aria-hidden="true"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <rect width="48" height="48" />
    </svg>
  )
}

/** The comma from the logo's bottom-right corner, on its own 2:3 canvas. */
export function CommaMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="1103.79 215.998 48.21 72.002"
      fill="currentColor"
      aria-hidden="true"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <path d={COMMA_PATH} />
    </svg>
  )
}
