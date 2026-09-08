import { describe, expect, test } from "bun:test"
import { createMetadata, SITE, DEFAULT_OG_IMAGE } from "./metadata"

describe("page metadata", () => {
  test("defaults to branded, non-indexable metadata", () => {
    const metadata = createMetadata({ pathname: "/login" })
    expect(metadata.title).toEqual({ absolute: SITE.name })
    expect(metadata.description).toBe(SITE.description)
    expect(metadata.robots).toEqual({ index: false, follow: true })
    expect(metadata.openGraph).toMatchObject({
      siteName: SITE.name,
      type: "website",
      locale: "en_GB",
      url: "https://answerable.org/login",
      images: [
        { ...DEFAULT_OG_IMAGE, url: "https://answerable.org/og/default.png" },
      ],
    })
    expect(metadata.twitter).toMatchObject({
      card: "summary_large_image",
      title: SITE.name,
    })
  })

  test("formats titles once and strips query strings and fragments", () => {
    const metadata = createMetadata({
      title: "Sign in",
      pathname: "/login?login_hint=private@example.org&client_id=secret#form",
    })
    expect(metadata.title).toEqual({ absolute: "Sign in · Answerable" })
    expect(metadata.alternates?.canonical).toBe("https://answerable.org/login")
    expect(metadata.openGraph).toMatchObject({
      title: "Sign in · Answerable",
      url: "https://answerable.org/login",
    })
    expect(JSON.stringify(metadata)).not.toContain("private@example.org")
  })

  test("supports absolute titles, indexable pages and full image overrides", () => {
    const metadata = createMetadata({
      pathname: "/",
      title: "Answerable · AI Lead training and accreditation",
      absoluteTitle: true,
      index: true,
    })
    expect(metadata.title).toEqual({
      absolute: "Answerable · AI Lead training and accreditation",
    })
    expect(metadata.robots).toEqual({ index: true, follow: true })
    const docs = createMetadata({
      pathname: "/docs/id",
      title: "Answerable ID",
      titleSuffix: "Answerable docs",
      description: "Identity docs",
      image: {
        url: "/og/docs/id/image.png",
        width: 1200,
        height: 630,
        alt: "Answerable ID",
      },
    })
    expect(docs.openGraph).toMatchObject({
      title: "Answerable ID · Answerable docs",
      description: "Identity docs",
      siteName: SITE.name,
      images: [
        {
          url: "https://answerable.org/og/docs/id/image.png",
          width: 1200,
          height: 630,
          alt: "Answerable ID",
        },
      ],
    })
    expect(docs.twitter).toMatchObject({
      title: "Answerable ID · Answerable docs",
      description: "Identity docs",
      images: [
        {
          url: "https://answerable.org/og/docs/id/image.png",
          width: 1200,
          height: 630,
          alt: "Answerable ID",
        },
      ],
    })
  })
})
