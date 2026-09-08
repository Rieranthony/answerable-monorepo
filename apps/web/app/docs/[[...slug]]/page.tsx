import { createMetadata } from "@/lib/metadata"
import { notFound } from "next/navigation"
import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
} from "fumadocs-ui/layouts/notebook/page"
import { createRelativeLink } from "fumadocs-ui/mdx"

import { OpenAPIPage } from "@/components/api-page"
import { PageActions } from "@/components/docs/page-actions"
import { getMDXComponents } from "@/components/mdx"
import { docs, getPageImageUrl, source } from "@/lib/source"

export default async function Page(props: PageProps<"/docs/[[...slug]]">) {
  const { slug } = await props.params
  const page = source.getPage(slug)

  if (!page) notFound()

  if (page.type === "openapi") {
    return (
      <DocsPage full>
        <DocsTitle>{page.data.title}</DocsTitle>
        <DocsDescription>{page.data.description}</DocsDescription>
        <DocsBody>
          <OpenAPIPage {...page.data.getOpenAPIPageProps()} />
        </DocsBody>
      </DocsPage>
    )
  }

  const data = page.data as (typeof docs.docs)[number]
  const MDX = data.body

  return (
    <DocsPage toc={data.toc} full={data.full}>
      <DocsTitle>{data.title}</DocsTitle>
      <DocsDescription>{data.description}</DocsDescription>
      <PageActions pageUrl={page.url} />
      <DocsBody>
        <MDX
          components={getMDXComponents({
            a: createRelativeLink(source, page),
          })}
        />
      </DocsBody>
    </DocsPage>
  )
}

export function generateStaticParams() {
  return source.generateParams()
}

export async function generateMetadata(props: PageProps<"/docs/[[...slug]]">) {
  const { slug } = await props.params
  const page = source.getPage(slug)

  if (!page) notFound()

  const { title, description } = page.data

  return createMetadata({
    pathname: page.url,
    title,
    absoluteTitle: page.slugs.length === 0,
    titleSuffix: "Answerable docs",
    description,
    image: {
      url: getPageImageUrl(page).url,
      width: 1200,
      height: 630,
      alt: `${title} · Answerable docs`,
    },
  })
}
