import type { ComponentProps } from "react"

import { GOOGLE_LOGO } from "@answerable/ui/lib/directory-logos"

import { cn } from "@answerable/ui/lib/utils"

/**
 * The Google "G" in its brand colours, as published in Google's sign-in
 * branding guidelines. Decorative by default; to use it alone, pass
 * aria-hidden={false}, role="img" and a label.
 */
function GoogleLogo({ className, ...props }: ComponentProps<"svg">) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={GOOGLE_LOGO.viewBox}
      aria-hidden="true"
      data-slot="google-logo"
      className={cn("size-4 shrink-0", className)}
      {...props}
    >
      {GOOGLE_LOGO.paths.map((path) => (
        <path key={path.d} fill={path.fill} d={path.d} />
      ))}
    </svg>
  )
}

export { GoogleLogo }
