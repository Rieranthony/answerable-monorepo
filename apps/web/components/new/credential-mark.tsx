import { COMMA_PATH, COMMA_VIEW_BOX } from "@answerable/ui/lib/logo"
import { cn } from "@answerable/ui/lib/utils"

/**
 * The credential as a square tile with the old logotype's marks inside its
 * corners: three squares and the comma, whose square head takes the fourth
 * corner and whose tail hangs below it. The name in Bold and the letters in
 * Black sit between them. Fill and type only: black on white by default, and
 * the marks follow the text colour, so `bg-black text-white` inverts it. `em`
 * units: the tile is 5em, the marks 0.4em, inset 0.4em, so the mark scales
 * with its font size.
 */
export function CredentialMark({ className }: { className?: string }) {
  const square = "absolute size-[0.4em] bg-current"
  return (
    <span
      className={cn(
        "relative inline-flex size-[5em] flex-col justify-between bg-white p-[1em] text-black",
        className,
      )}
    >
      <span className="text-[0.45em] leading-none font-bold">Answerable</span>
      <span className="text-[1.8em] leading-[0.75] font-black tracking-[-0.04em]">
        AP
      </span>
      <span
        aria-hidden="true"
        className={cn(square, "top-[0.4em] left-[0.4em]")}
      />
      <span
        aria-hidden="true"
        className={cn(square, "top-[0.4em] right-[0.4em]")}
      />
      <span
        aria-hidden="true"
        className={cn(square, "bottom-[0.4em] left-[0.4em]")}
      />
      <svg
        aria-hidden="true"
        viewBox={COMMA_VIEW_BOX}
        className="absolute right-[0.4em] bottom-[0.2em] h-auto w-[0.4em] fill-current"
      >
        <path d={COMMA_PATH} />
      </svg>
    </span>
  )
}
