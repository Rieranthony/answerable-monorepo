import type { Metadata } from "next"

export const SITE = {
  name: "Answerable",
  origin: "https://answerable.org",
  description:
    "Answerable trains, equips and accredits the AI Lead: the named professional who answers for how AI is used in high-stakes professional work.",
} as const

export type MetadataImage = {
  url: string
  width: number
  height: number
  alt: string
}

export const DEFAULT_OG_IMAGE: MetadataImage = {
  url: "/og/default.png",
  width: 1200,
  height: 630,
  alt: "Answerable logo in white on black",
}

/** Canonical URLs never carry tracking or authentication parameters. */
export function canonicalUrl(pathname: string) {
  const url = new URL(pathname, SITE.origin)
  return new URL(url.pathname, SITE.origin).href
}

export function createMetadata({
  pathname,
  title = SITE.name,
  description = SITE.description,
  absoluteTitle = false,
  titleSuffix = SITE.name,
  image = DEFAULT_OG_IMAGE,
  index = false,
}: {
  pathname: string
  title?: string
  description?: string
  absoluteTitle?: boolean
  titleSuffix?: string
  image?: MetadataImage
  index?: boolean
}): Metadata {
  const fullTitle =
    absoluteTitle || title === titleSuffix ? title : `${title} · ${titleSuffix}`
  const url = canonicalUrl(pathname)
  const images = [{ ...image, url: new URL(image.url, SITE.origin).href }]

  return {
    title: { absolute: fullTitle },
    description,
    alternates: { canonical: url },
    robots: { index, follow: true },
    openGraph: {
      type: "website",
      locale: "en_GB",
      siteName: SITE.name,
      title: fullTitle,
      description,
      url,
      images,
    },
    twitter: {
      card: "summary_large_image",
      title: fullTitle,
      description,
      images,
    },
  }
}
