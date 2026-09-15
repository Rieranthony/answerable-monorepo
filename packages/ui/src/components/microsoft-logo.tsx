import type { ComponentProps } from "react"

import { cn } from "@answerable/ui/lib/utils"

/**
 * The Microsoft four-square symbol in its brand colours. Decorative by
 * default; to use it alone, pass aria-hidden={false}, role="img" and a label.
 */
function MicrosoftLogo({ className, ...props }: ComponentProps<"svg">) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 21 21"
      aria-hidden="true"
      data-slot="microsoft-logo"
      className={cn("size-4 shrink-0", className)}
      {...props}
    >
      <rect x="1" y="1" width="9" height="9" fill="#F25022" />
      <rect x="11" y="1" width="9" height="9" fill="#7FBA00" />
      <rect x="1" y="11" width="9" height="9" fill="#00A4EF" />
      <rect x="11" y="11" width="9" height="9" fill="#FFB900" />
    </svg>
  )
}

export { MicrosoftLogo }
