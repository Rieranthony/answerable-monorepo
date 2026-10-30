import { COMMA_PATH, COMMA_VIEW_BOX } from "@answerable/ui/lib/logo"
import { cn } from "@answerable/ui/lib/utils"

/**
 * Short text in the old logotype's frame: three squares at the top-left,
 * top-right and bottom-left corners and the comma at the bottom-right, in the
 * text's colour. `em` units keep Laura's proportions at any size: marks 0.4em,
 * text padded so the marks sit at the corners without touching the letters.
 */
export function GridFrame({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  const square = "absolute size-[0.4em] bg-current"
  return (
    <span
      className={cn("relative inline-block px-[0.6em] py-[0.45em]", className)}
    >
      {children}
      <span aria-hidden="true" className={cn(square, "top-0 left-0")} />
      <span aria-hidden="true" className={cn(square, "top-0 right-0")} />
      <span aria-hidden="true" className={cn(square, "bottom-0 left-0")} />
      <svg
        aria-hidden="true"
        viewBox={COMMA_VIEW_BOX}
        className="absolute right-0 bottom-0 h-auto w-[0.4em] fill-current"
      >
        <path d={COMMA_PATH} />
      </svg>
    </span>
  )
}
