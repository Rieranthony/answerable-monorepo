import { FramedImage } from "@/components/new/framed-image"
import type { FramingKey } from "@/components/new/framings"

/**
 * The section's framing at the top of its panel on phones. From lg the sticky
 * image column shows it instead; the lazy image inside a hidden box never loads.
 */
export function PanelImage({ framing }: { framing: FramingKey }) {
  return (
    <div className="relative aspect-[3/2] w-full lg:hidden">
      <FramedImage framing={framing} />
    </div>
  )
}
