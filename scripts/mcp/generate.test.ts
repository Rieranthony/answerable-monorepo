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
