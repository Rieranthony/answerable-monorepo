import { afterEach, beforeEach, expect, test } from "bun:test"
import { main } from "../cli"
import { tempRepository, testIo } from "../test/io"

const manifest = (id: string, description: string, names: string[]) => JSON.stringify({
  description, prompts: [], resources: [],
  tools: [...names.map(name => ({ name, identity: `${id}/${name}`, kind: "read", scopes: [`${id}:read`] })), { name: `${id}_commit`, identity: `${id}/commit`, kind: "commit", scopes: [`${id}:write`] }],
})
let repository: Awaited<ReturnType<typeof tempRepository>>
beforeEach(async () => {
  repository = await tempRepository({
    "mcps/zeta/mcp.json": '{ "$schema": "../../scripts/mcp/mcp.schema.json", "name": "zeta", "serve": "standalone", "database": "own" }\n',
    "mcps/zeta/manifest.json": manifest("zeta", "Reads the weather. It has one tool.", ["weather.get"]),
    "mcps/acme/mcp.json": '{ "name": "acme", "serve": "both", "database": "shared" }\n',
    "mcps/acme/manifest.json": manifest("acme", "Notes for construction projects: list, read and add notes on a project", ["notes.add", "notes.list"]),
    "mcps/beta/mcp.json": '{ "name": "beta", "serve": "toolbox", "database": "shared" }\n',
    "mcps/toolbox/package.json": "{}\n",
  })
})
afterEach(() => repository.remove())

const run = async (argv: string[]) => {
  const io = testIo(["list", ...argv], repository.root)
  return { ...io, code: await main(io.io) }
}

test("one line per MCP with an mcp.json, sorted by name: where it runs, its database, its tools, its first sentence and its local URLs, then its deployed URLs", async () => {
  const { code, stdout } = await run([])
  expect(code).toBe(0)
  expect(stdout()).toBe([
    "acme  both        shared  2 tools  Notes for construction projects: list, read and add notes on a project  http://localhost:47400/mcp http://localhost:47510/acme/mcp",
    "  staging https://toolbox.answerable-staging.uk/mcp https://mcp.answerable-staging.uk/acme/mcp  production https://toolbox.answerable.org/mcp https://mcp.answerable.org/acme/mcp",
    "beta  toolbox     shared  0 tools                                                                          http://localhost:47400/mcp",
    "  staging https://toolbox.answerable-staging.uk/mcp  production https://toolbox.answerable.org/mcp",
    "zeta  standalone  own     1 tool   Reads the weather.                                                      http://localhost:47510/zeta/mcp",
    "  staging https://mcp.answerable-staging.uk/zeta/mcp  production https://mcp.answerable.org/zeta/mcp",
    "",
  ].join("\n"))
})

test("--json names every MCP and its tools, commit tools aside", async () => {
  const { stdout } = await run(["--json"])
  expect(JSON.parse(stdout())).toEqual({
    ok: true,
    mcps: [
      {
        name: "acme", serve: "both", database: "shared", description: "Notes for construction projects: list, read and add notes on a project", tools: ["notes.add", "notes.list"],
        urls: {
          local: ["http://localhost:47400/mcp", "http://localhost:47510/acme/mcp"],
          staging: ["https://toolbox.answerable-staging.uk/mcp", "https://mcp.answerable-staging.uk/acme/mcp"],
          production: ["https://toolbox.answerable.org/mcp", "https://mcp.answerable.org/acme/mcp"],
        },
      },
      { name: "beta", serve: "toolbox", database: "shared", description: "", tools: [], urls: { local: ["http://localhost:47400/mcp"], staging: ["https://toolbox.answerable-staging.uk/mcp"], production: ["https://toolbox.answerable.org/mcp"] } },
      {
        name: "zeta", serve: "standalone", database: "own", description: "Reads the weather. It has one tool.", tools: ["weather.get"],
        urls: { local: ["http://localhost:47510/zeta/mcp"], staging: ["https://mcp.answerable-staging.uk/zeta/mcp"], production: ["https://mcp.answerable.org/zeta/mcp"] },
      },
    ],
  })
})

test("with no MCP it says how to make one, and it takes no argument", async () => {
  const empty = await tempRepository()
  try {
    const io = testIo(["list"], empty.root)
    expect([await main(io.io), io.stdout()]).toEqual([0, "No MCP has an mcp.json yet: bun mcp new <name> makes one\n"])
  } finally {
    await empty.remove()
  }
  expect([(await run(["acme"])).code, (await run(["acme"])).stderr().split("\n")[0]]).toEqual([2, "bun mcp list takes no argument; it was given acme"])
})

test("an mcp.json that is not a declaration, or names another directory, is refused naming the file", async () => {
  await Bun.write(`${repository.root}/mcps/beta/mcp.json`, '{ "name": "beta", "serve": "everywhere", "database": "shared" }\n')
  expect((await run([])).stderr()).toStartWith('mcps/beta/mcp.json is not valid: ✖ Invalid option: expected one of "toolbox"|"standalone"|"both" → at serve')
  await Bun.write(`${repository.root}/mcps/beta/mcp.json`, '{ "name": "gamma", "serve": "toolbox", "database": "shared" }\n')
  const { code, stdout } = await run(["--json"])
  const message = 'mcps/beta/mcp.json names "gamma"; the name is the directory\'s, beta'
  expect([code, JSON.parse(stdout()).error]).toEqual([2, { code: "invalid-file", message, fix: "git diff mcps/beta/mcp.json", problems: [{ code: "invalid-file", message }] }])
})
