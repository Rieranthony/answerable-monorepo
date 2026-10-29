import { COMMA_PATH, COMMA_VIEW_BOX } from "@answerable/ui/lib/logo"

/**
 * The comma, then the word as live text, in the proportions of the brand
 * banners (measured at 4×): the comma is 1.26 cap heights tall, its top 0.09
 * cap above the capitals and its tail 0.17 cap below the baseline, with a 0.45
 * cap gap. `cap` units keep the ratio at any font size.
 */
export function Lockup() {
  return (
    <a href="/new" className="text-[20px]/none font-bold whitespace-nowrap">
      <svg
        aria-hidden="true"
        viewBox={COMMA_VIEW_BOX}
        className="mr-[0.45cap] inline-block h-[1.26cap] w-auto fill-current align-[-0.17cap]"
      >
        <path d={COMMA_PATH} />
      </svg>
      Answerable
    </a>
  )
}
