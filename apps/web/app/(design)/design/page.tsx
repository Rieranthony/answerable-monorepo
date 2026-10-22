import { DesignPane } from "@/components/design/pane"
import { Showcase } from "@/components/design/showcase"
import { loadDesign } from "@/lib/design"
import { publicSans } from "@/lib/fonts"
import { createMetadata } from "@/lib/metadata"

export const metadata = createMetadata({
  pathname: "/design",
  title: "Design",
  description:
    "The Answerable design system, rendered from its DESIGN.md: the palette, the type scale, shape, lines and elevation, and every component, with a pane to change any token live.",
  index: true,
})

export default function DesignPage() {
  return (
    <>
      <Showcase design={loadDesign()} />
      <DesignPane
        font={`${publicSans.style.fontFamily}, system-ui, sans-serif`}
      />
    </>
  )
}
