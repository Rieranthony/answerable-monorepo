import Image from "next/image"

import { FRAMINGS, type FramingKey } from "@/components/new/framings"
import { cn } from "@answerable/ui/lib/utils"

type FramedImageProps = {
  framing: FramingKey
  eager?: boolean
  /** Empty alt text for a frame a screen reader should skip. */
  decorative?: boolean
  className?: string
}

/**
 * One framing of one photograph, filling its positioned parent. `sizes` is the
 * same everywhere, so every use asks for the same URL and the browser fetches
 * each file once, however many framings show it.
 */
export function FramedImage({
  framing,
  eager = false,
  decorative = false,
  className,
}: FramedImageProps) {
  const { image, x, alt } = FRAMINGS[framing]
  return (
    <Image
      src={image}
      alt={decorative ? "" : alt}
      fill
      sizes="100vw"
      placeholder="blur"
      loading={eager ? "eager" : "lazy"}
      fetchPriority={eager ? "high" : undefined}
      className={cn("object-cover", className)}
      style={{ objectPosition: `${x}% 50%` }}
    />
  )
}
