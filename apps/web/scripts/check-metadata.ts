import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import sharp from "sharp"

// Run against a production build: bun scripts/check-metadata.ts http://localhost:47101
const base = process.argv[2] ?? "http://localhost:47101"
const origin = "https://answerable.org"
const manifest = JSON.parse(
  await readFile(".next/prerender-manifest.json", "utf8"),
)
const apiPage = Object.keys(manifest.routes).find(
  (path) => path.startsWith("/docs/id/admin-api/") && !path.endsWith(".md"),
)!
assert.ok(apiPage, "An API reference page must be generated")

function tags(html: string) {
  const values = new Map<string, string>()
  for (const tag of html.matchAll(/<(?:meta|link)\b[^>]*>/g)) {
    const attrs = Object.fromEntries(
      [...tag[0].matchAll(/([\w:-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]),
    )
    const name = attrs.name ?? attrs.property ?? attrs.rel
    if (name) values.set(name, attrs.content ?? attrs.href)
  }
  return values
}

for (const agent of [
  "Mozilla/5.0",
  "Twitterbot/1.0",
  "facebookexternalhit/1.1",
  "LinkedInBot/1.0",
]) {
  for (const path of [
    "/",
    "/docs",
    "/docs/id/sign-in",
    apiPage,
    "/login?login_hint=private%40example.org",
    "/consent?client_id=secret",
    "/error?error=unknown",
  ]) {
    const response = await fetch(base + path, {
      headers: { "User-Agent": agent },
    })
    assert.equal(response.status, 200, path)
    const html = await response.text()
    const meta = tags(html)
    const pathname = path.split("?")[0]
    assert.equal(new URL(meta.get("canonical")!).href, origin + pathname, path)
    assert.equal(new URL(meta.get("og:url")!).href, origin + pathname, path)
    assert.equal(meta.get("og:site_name"), "Answerable")
    assert.equal(meta.get("twitter:card"), "summary_large_image")
    assert.equal(meta.get("og:title"), meta.get("twitter:title"))
    assert.equal(meta.get("og:description"), meta.get("description"))
    assert.equal(meta.get("og:image"), meta.get("twitter:image"))
    assert.equal(meta.get("og:image:width"), "1200")
    assert.equal(meta.get("og:image:height"), "630")
    assert.ok(meta.get("og:image:alt"))
    assert.equal(
      meta.get("robots"),
      pathname === "/" ? "index, follow" : "noindex, follow",
    )
    assert.ok(
      meta
        .get("og:image")
        ?.endsWith(
          pathname.startsWith("/docs") ? "/image.png" : "/og/default.png",
        ),
    )
    if (pathname === "/") {
      assert.equal(
        meta.get("og:title"),
        "Answerable · AI Lead training and accreditation",
      )
      const json = JSON.parse(
        html.match(/<script type="application\/ld\+json">(.*?)<\/script>/)![1],
      )
      assert.deepEqual(
        json["@graph"].map((item: { "@type": string }) => item["@type"]),
        ["Organization", "WebSite"],
      )
    }
  }
}

for (const [path, accept] of [
  ["/docs.md", "text/markdown"],
  ["/docs/id/sign-in.md", "text/markdown"],
  ["/docs/id/sign-in.md", "*/*"],
  ["/docs/id/sign-in", "text/markdown"],
  ["/llms.mdx/docs/id/sign-in", "text/markdown"],
  ["/llms.txt", "text/plain"],
  ["/llms-full.txt", "text/plain"],
  ["/api/search?query=sign", "application/json"],
]) {
  const response = await fetch(base + path, { headers: { Accept: accept } })
  assert.equal(response.status, 200, path)
  assert.ok(
    response.headers.get("x-robots-tag")?.includes("noindex"),
    `${path}: noindex header`,
  )
  assert.ok((await response.text()).length > 0)
}

const sitemap = await (await fetch(base + "/sitemap.xml")).text()
assert.deepEqual(
  [...sitemap.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1]),
  [origin + "/"],
)
const robots = await (await fetch(base + "/robots.txt")).text()
assert.ok(robots.includes(`Sitemap: ${origin}/sitemap.xml`))
assert.ok(!robots.includes("Disallow:"))

for (const path of [
  "/og/default.png",
  "/og/docs/image.png",
  "/og/docs/id/sign-in/image.png",
  "/og/docs/id/sign-in/image.webp",
]) {
  const response = await fetch(base + path)
  assert.equal(response.status, 200)
  assert.equal(
    response.headers.get("content-type"),
    path.endsWith("png") ? "image/png" : "image/webp",
  )
  const buffer = Buffer.from(await response.arrayBuffer())
  const decoded = sharp(buffer)
  const metadata = await decoded.metadata()
  assert.equal(metadata.width, 1200)
  assert.equal(metadata.height, 630)
  const { data, info } = await decoded
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  if (path === "/og/default.png") {
    let count = 0,
      minX = 1200,
      minY = 630,
      maxX = 0,
      maxY = 0
    for (let y = 0; y < info.height; y++)
      for (let x = 0; x < info.width; x++) {
        const index = (y * info.width + x) * info.channels
        assert.equal(data[index], data[index + 1])
        assert.equal(data[index], data[index + 2])
        if (data[index] > 128) {
          count++
          minX = Math.min(minX, x)
          maxX = Math.max(maxX, x)
          minY = Math.min(minY, y)
          maxY = Math.max(maxY, y)
        }
      }
    assert.ok(count > 10000, "Logo must be visible")
    assert.ok(Math.abs(minX - 240) <= 1 && Math.abs(maxX - 959) <= 1)
    assert.ok(Math.abs(minY - 225) <= 1 && Math.abs(maxY - 404) <= 1)
  }
}
for (const path of [
  "/og/docs/id/sign-in/wrong.png",
  "/og/docs/does-not-exist/image.png",
  "/docs/does-not-exist",
]) {
  assert.equal((await fetch(base + path)).status, 404, path)
}
for (const path of ["/favicon.ico", "/apple-icon.png", "/icon.svg"]) {
  assert.equal((await fetch(base + path)).status, 200, path)
}
console.log(
  "Metadata, indexing, structured data, icons and OG images verified against the production server.",
)
