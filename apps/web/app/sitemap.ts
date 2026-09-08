import type { MetadataRoute } from "next"
import { canonicalUrl } from "@/lib/metadata"

export default function sitemap(): MetadataRoute.Sitemap {
  return [{ url: canonicalUrl("/") }]
}
