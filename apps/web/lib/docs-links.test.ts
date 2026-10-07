// Every link in the docs reaches a page, and every #anchor a heading on it; every link from the repository's Markdown
// into the docs' sources reaches a file. A moved page or a renamed heading fails here, not in a reader's browser.
import { expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import GithubSlugger from "github-slugger"

const web = join(import.meta.dir, "..")
const repo = join(web, "../..")
const content = join(web, "content/docs")

const read = (path: string) => readFileSync(path, "utf8")
const scan = (pattern: string, cwd: string) =>
  [...new Bun.Glob(pattern).scanSync({ cwd })].sort()

// Markdown outside fenced code blocks: code is not a link and a `#` comment is not a heading.
const prose = (source: string) =>
  source.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[ \t]*$/gm, "")

const urlOf = (file: string) =>
  `/docs/${file.replace(/\.mdx$/, "").replace(/(^|\/)index$/, "")}`.replace(
    /\/$/,
    "",
  )

// Heading ids as remarkHeading makes them: GitHub's slugger over the heading's text.
function anchorsOf(source: string) {
  const slugger = new GithubSlugger()

  return new Set(
    [...prose(source).matchAll(/^#{1,6}\s+(.+?)\s*$/gm)].map(([, heading]) =>
      slugger.slug(
        heading!
          .replace(/`([^`]*)`/g, "$1")
          .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
          .replace(/\*/g, ""),
      ),
    ),
  )
}

const pages = new Map<string, Set<string> | null>()
for (const file of scan("**/*.mdx", content)) {
  pages.set(urlOf(file), anchorsOf(read(join(content, file))))
}

// OpenAPI pages: /docs/id/<api|admin-api>/<tag, slugified>/<operationId>, as fumadocs-openapi names them.
for (const [base, contract] of [
  ["/docs/id/api", "apps/id/openapi.json"],
  ["/docs/id/admin-api", "apps/id/openapi.admin.json"],
] as const) {
  const document = JSON.parse(read(join(repo, contract))) as {
    paths: Record<
      string,
      Record<string, { operationId?: string; tags?: string[] }>
    >
  }
  for (const operation of Object.values(document.paths).flatMap((item) =>
    Object.values(item),
  )) {
    for (const tag of operation.tags ?? []) {
      const slug = tag.replace(/\s+/g, "-").toLowerCase()
      pages.set(`${base}/${slug}/${operation.operationId}`, null)
    }
  }
}

function links(file: string, source: string) {
  const text = prose(source)

  return [
    ...text.matchAll(/\]\((\/docs[^)\s]*|#[^)\s]+)\)/g),
    ...text.matchAll(/href="(\/docs[^"]*)"/g),
  ].map(([, link]) => ({ file, link: link! }))
}

const sources = [
  ...scan("**/*.mdx", content).map((file) => join(content, file)),
  join(web, "lib/docs/error-codes.ts"),
  join(web, "components/docs/generated.tsx"),
  join(web, "app/llms.txt/route.ts"),
]

test("every docs link reaches a page and every anchor a heading on it", () => {
  const broken: string[] = []

  for (const path of sources) {
    const file = relative(web, path)
    const self = path.endsWith(".mdx") ? urlOf(relative(content, path)) : ""
    for (const { link } of links(file, read(path))) {
      const [target, anchor] = link.startsWith("#")
        ? [self, link.slice(1)]
        : link.split("#")
      if (!pages.has(target!)) {
        broken.push(`${file}: ${link} (no such page)`)
        continue
      }
      const anchors = pages.get(target!)
      if (anchor && anchors && !anchors.has(anchor)) {
        broken.push(`${file}: ${link} (no such heading)`)
      }
    }
  }

  expect(broken).toEqual([])
})

test("every link from the repository's Markdown into the docs' sources reaches a file", () => {
  const broken: string[] = []
  const markdown = scan("**/*.md", repo).filter(
    (file) =>
      !/(^|\/)(node_modules|\.next|\.turbo|coverage|\.claude)\//.test(file),
  )

  for (const file of markdown) {
    for (const [, link] of read(join(repo, file)).matchAll(
      /\]\(([^)#\s]*apps\/web\/content\/docs\/[^)#\s]+)/g,
    )) {
      const target = join(repo, file, "..", link!)
      if (!existsSync(target)) broken.push(`${file}: ${link}`)
    }
  }

  expect(broken).toEqual([])
})

test("the checker sees the pages it must: MDX pages and OpenAPI operations", () => {
  expect(pages.has("/docs")).toBe(true)
  expect(pages.has("/docs/mcp/reference")).toBe(true)
  expect(pages.has("/docs/id/api/token/issueToken")).toBe(true)
  expect(anchorsOf("## The `sub` rule\n\n```sh\n# not a heading\n```")).toEqual(
    new Set(["the-sub-rule"]),
  )
})
