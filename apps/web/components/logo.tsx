import type { SVGProps } from "react"

import { LOGO_PATHS, LOGO_VIEW_BOX } from "@answerable/ui/lib/logo"

export { COMMA_PATH } from "@answerable/ui/lib/logo"

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
      {LOGO_PATHS.map((path) => (
        <path key={path.id} d={path.d} />
      ))}
    </svg>
  )
}
