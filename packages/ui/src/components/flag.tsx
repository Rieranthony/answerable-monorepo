import { flagUrl } from "@answerable/countries"
import { cn } from "@answerable/ui/lib/utils"

export function Flag({
  code,
  className,
}: {
  code: string
  className?: string
}) {
  return (
    <img
      src={flagUrl(code)}
      alt=""
      width={20}
      height={15}
      loading="lazy"
      decoding="async"
      data-slot="flag"
      className={cn("h-3.5 w-5 shrink-0 object-contain", className)}
    />
  )
}
