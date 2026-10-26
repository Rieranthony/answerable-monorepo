import { expect, test } from "bun:test"
import { generate, generatedFiles } from "./generate"
import { tempRepository } from "./test/io"

const repo = new URL("../../", import.meta.url).pathname

test("the generated files are what bun mcp writes: run bun mcp check <mcp>, which rewrites them, and commit them", async () => {
  const stale = await generate(repo, { write: false })
  expect(stale, `stale: ${stale.join(", ")}; run bun mcp check <mcp>, which rewrites them, and commit them`).toEqual([])
})

test("an MCP is listed with its scopes and grant strings, commit tools aside, and one without a manifest yet with none", async () => {
  const tools = [
    { name: "acme_commit", identity: "acme/commit", kind: "commit", scopes: ["acme:write"] },
    { name: "notes_add", identity: "acme/notes.add", kind: "mutate", scopes: ["acme:write"] },
    { name: "files_list", identity: "acme/files.list", kind: "read", scopes: ["acme:read"] },
  ]
  const repository = await tempRepository({
    "mcps/acme/mcp.json": '{ "name": "acme", "serve": "both", "database": "shared" }\n',
    "mcps/acme/manifest.json": JSON.stringify({ description: "Notes.", tools, prompts: [{ scopes: ["acme:prompts"] }], resources: [] }),
    "mcps/beta/mcp.json": '{ "name": "beta", "serve": "standalone", "database": "own" }\n',
  })
  try {
    expect(JSON.parse(Object.values(await generatedFiles(repository.root))[0]!).mcps).toEqual([
      { name: "acme", serve: "both", database: "shared", scopes: ["acme:prompts", "acme:read", "acme:write"], grants: ["acme", "acme/files", "acme/files.list", "acme/notes", "acme/notes.add"] },
      { name: "beta", serve: "standalone", database: "own", scopes: [], grants: [] },
    ])
  } finally {
    await repository.remove()
  }
})

test("each server's list imports the provider of every MCP it serves, with its database mode and an own MCP's variable, and its dependencies follow", async () => {
  const declare = (name: string, serve: string, database = "shared") => ({ [`mcps/${name}/mcp.json`]: JSON.stringify({ name, serve, database }) })
  const server = (name: string, dependencies: Record<string, string>) => ({ [`mcps/${name}/package.json`]: JSON.stringify({ name: `@answerable/mcp-${name}`, private: true, dependencies }) })
  const repository = await tempRepository({
    ...declare("acme", "toolbox"), ...declare("beta", "standalone", "own"), ...declare("gamma", "both"),
    "mcps/retired.json": '["old"]\n',
    // A dependency on a retired MCP and one on an MCP the server no longer serves go; every other dependency stays.
    ...server("toolbox", { zod: "4.6.7", "@answerable/mcp-old": "workspace:*", "@answerable/mcp-beta": "workspace:*", "@answerable/mcp-platform": "workspace:*" }),
    ...server("standalone", {}),
  })
  try {
    const files = await generatedFiles(repository.root)
    expect(files["mcps/toolbox/src/mounted.generated.ts"]).toBe(`// Written by bun mcp from mcps/*/mcp.json (scripts/mcp/generate.ts): every MCP the Toolbox mounts, serve toolbox or both. Never edit it by hand.
import type { Declared } from "@answerable/mcp-platform"
import { provider as acmeProvider } from "@answerable/mcp-acme/provider"
import { provider as gammaProvider } from "@answerable/mcp-gamma/provider"

/** The MCPs the Toolbox mounts: each provider, and where its tables live. */
export const mounted: readonly Declared[] = [
  { provider: acmeProvider, database: "shared" },
  { provider: gammaProvider, database: "shared" },
]
`)
    expect(files["mcps/standalone/src/served.generated.ts"]).toContain(`  { provider: betaProvider, database: "own", variable: "STANDALONE_MCP_BETA_DATABASE_URL" },
  { provider: gammaProvider, database: "shared" },
]`)
    expect(JSON.parse(files["mcps/toolbox/package.json"]!).dependencies).toEqual({ "@answerable/mcp-acme": "workspace:*", "@answerable/mcp-gamma": "workspace:*", "@answerable/mcp-platform": "workspace:*", zod: "4.6.7" })
    expect(Object.keys(JSON.parse(files["mcps/toolbox/package.json"]!).dependencies)).toEqual(["@answerable/mcp-acme", "@answerable/mcp-gamma", "@answerable/mcp-platform", "zod"])
    expect(JSON.parse(files["mcps/standalone/package.json"]!).dependencies).toEqual({ "@answerable/mcp-beta": "workspace:*", "@answerable/mcp-gamma": "workspace:*" })
    expect(await generate(repository.root, { write: true })).toEqual(Object.keys(files))
    expect(await generate(repository.root, { write: false })).toEqual([])
  } finally {
    await repository.remove()
  }
})

test("a server that serves no MCP gets an empty list", async () => {
  const repository = await tempRepository({ "mcps/acme/mcp.json": '{ "name": "acme", "serve": "toolbox", "database": "shared" }', "mcps/retired.json": "[]", "mcps/standalone/package.json": '{ "dependencies": {} }' })
  try {
    expect((await generatedFiles(repository.root))["mcps/standalone/src/served.generated.ts"]).toEndWith("export const served: readonly Declared[] = []\n")
  } finally {
    await repository.remove()
  }
})

test("an MCP folder deleted before it was ever declared or retired leaves no dependency behind, and the platform's packages stay", async () => {
  const repository = await tempRepository({
    "mcps/acme/mcp.json": '{ "name": "acme", "serve": "toolbox", "database": "shared" }',
    "mcps/retired.json": "[]",
    // mcps/gone was tried out and deleted, as create.mdx's undo says: never declared since, never retired.
    "mcps/toolbox/package.json": JSON.stringify({ dependencies: Object.fromEntries(["mcp", "mcp-acme", "mcp-gone", "mcp-platform", "mcp-postgres", "mcp-admin", "id-admin"].map(name => [`@answerable/${name}`, "workspace:*"])) }),
  })
  try {
    expect(Object.keys(JSON.parse((await generatedFiles(repository.root))["mcps/toolbox/package.json"]!).dependencies)).toEqual([
      "@answerable/id-admin", "@answerable/mcp", "@answerable/mcp-acme", "@answerable/mcp-admin", "@answerable/mcp-platform", "@answerable/mcp-postgres",
    ])
  } finally {
    await repository.remove()
  }
})
