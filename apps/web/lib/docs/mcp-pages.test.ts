// The MCP guides say what the code says: the messages their error tables quote are the messages the code produces; the deploy page's
// smoke table is the smoke test's.
import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { hostsFor } from "../../../../infra/pipeline/src/environments"
import { runSmoke } from "../../../../infra/pipeline/src/smoke"

const web = join(import.meta.dir, "../..")
const repo = join(web, "../..")
const content = join(web, "content/docs")
const page = (name: string) =>
  readFileSync(join(content, `${name}.mdx`), "utf8")

// What the rows of a page's Errors table say they see: the first cell, its code spans.
function seen(source: string) {
  const [, table] = /\n## Errors\n([\s\S]*?)(?=\n## |$)/.exec(source) ?? []
  const rows = (table ?? "")
    .split("\n")
    .filter(
      (line) =>
        line.startsWith("| ") &&
        !line.startsWith("| ---") &&
        !line.startsWith("| You see"),
    )

  return rows.map((row) =>
    [...row.split(" | ")[0]!.matchAll(/`([^`]+)`/g)].map(([, code]) => code!),
  )
}

// The text between a message's placeholders: `…` and `<…>` stand for what the code interpolates.
const fragments = (message: string) =>
  message
    .split(/…|<[^>]+>/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 8)

// What the code says: the workflows and the sources of the services and the CLI, their tests too: ID answers some codes through its OAuth library, which only its tests name.
const sources = (() => {
  const roots = [
    "apps/id/src",
    "infra/pipeline/src",
    "packages/mcp/src",
    "mcps/admin/src",
    "mcps/toolbox/src",
    "scripts/mcp",
  ]
  const files = [
    ...new Bun.Glob(".github/workflows/*.yml").scanSync({
      cwd: repo,
      dot: true,
    }),
    ...roots.flatMap((root) => [
      ...new Bun.Glob(`${root}/**/*.ts`).scanSync({ cwd: repo }),
    ]),
  ]

  return files.map((file) => readFileSync(join(repo, file), "utf8")).join("\n")
})()

test.each(["mcp/deploy", "mcp/sign-in"])(
  "every message %s quotes in its Errors table is in the code that says it, up to what the code interpolates",
  (name) => {
    const missing: string[] = []
    const rows = seen(page(name))

    expect(rows.length).toBeGreaterThan(3)
    for (const spans of rows) {
      for (const span of spans) {
        for (const part of fragments(span)) {
          if (!sources.includes(part))
            missing.push(`${name}: "${part}" of ${span}`)
        }
      }
    }
    expect(missing).toEqual([])
  },
)

test("the deploy page's smoke table lists the checks the smoke test runs, in its order", async () => {
  const hosts = hostsFor("staging")
  const issuer = `https://${hosts.id}`
  const results = await runSmoke(hosts, [{ name: "acme", serve: "both" }], {
    sleep: async () => {},
    now: () => 0,
    timeoutMs: 0,
    intervalMs: 0,
    fetch: async (target) => {
      const url = new URL(target)

      if (url.pathname === "/.well-known/openid-configuration")
        return Response.json({ issuer, jwks_uri: `${issuer}/auth/jwks` })
      if (url.pathname === "/auth/jwks")
        return Response.json({ keys: [{ kid: "one" }] })
      if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
        return Response.json({
          resource: `https://${url.host}${url.pathname.replace("/.well-known/oauth-protected-resource", "")}`,
          authorization_servers: [issuer],
        })
      }
      if (url.host === hosts.toolbox && url.pathname === "/health")
        return Response.json({ status: "ok", providers: ["acme"] })

      return Response.json({ status: "ok" })
    },
  })
  const [, table] =
    /\| Check \| Passes when \|\n\| --- \| --- \|\n([\s\S]*?)\n\n/.exec(
      page("mcp/deploy"),
    ) ?? []
  const listed = table!
    .split("\n")
    .map((row) => /^\| `([^`]+)`/.exec(row)![1]!.replace("<name>", "acme"))

  expect(results.every((result) => result.ok)).toBe(true)
  expect(listed).toEqual(results.map((result) => result.name))
})
