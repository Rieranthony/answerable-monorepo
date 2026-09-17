import type { ComponentProps } from "react"

import { MICROSOFT_LOGO } from "@answerable/ui/lib/directory-logos"

import { cn } from "@answerable/ui/lib/utils"

/**
 * The Microsoft four-square symbol in its brand colours. Decorative by
 * default; to use it alone, pass aria-hidden={false}, role="img" and a label.
 */
function MicrosoftLogo({ className, ...props }: ComponentProps<"svg">) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={MICROSOFT_LOGO.viewBox}
      aria-hidden="true"
      data-slot="microsoft-logo"
      className={cn("size-4 shrink-0", className)}
      {...props}
    >
      {MICROSOFT_LOGO.paths.map((path) => (
        <path key={path.d} fill={path.fill} d={path.d} />
      ))}
    </svg>
  )
}

export { MicrosoftLogo }
