import Image, { type StaticImageData } from "next/image"

import { cn } from "@answerable/ui/lib/utils"

type FramedImageProps = {
  image: StaticImageData
  /** Focal point: `object-position` x, in percent. */
  x: number
  alt: string
  eager?: boolean
  /** Empty alt text for a frame a screen reader should skip. */
  decorative?: boolean
  className?: string
}

/**
 * One crop of one photograph, filling its positioned parent. `sizes` is the
 * same everywhere, so every use asks for the same URL and the browser fetches
 * each file once, however many crops show it.
 */
export function FramedImage({
  image,
  x,
  alt,
  eager = false,
  decorative = false,
  className,
}: FramedImageProps) {
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
