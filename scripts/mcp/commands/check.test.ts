import { afterEach, beforeEach, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { main } from "../cli"
import { generatedFiles } from "../generate"
import { mcpFiles } from "../templates"
import { recorder, tempRepository, testIo } from "../test/io"

const acme = mcpFiles({ name: "acme", description: "Notes for construction projects: list, read and add notes on a project.", serve: "toolbox", database: "shared", date: "2026-10-25" })
const manifest = (scopes: string[]) => `${JSON.stringify({ description: "Notes.", tools: [{ name: "notes_list", identity: "acme/notes.list", kind: "read", scopes }], prompts: [], resources: [] })}\n`
const passing = " 6 pass\n 0 fail\nAll files |  100.00 |   98.50 |\n"
let repository: Awaited<ReturnType<typeof tempRepository>>
beforeEach(async () => {
  repository = await tempRepository(Object.fromEntries(Object.entries(acme).map(([path, text]) => [`mcps/acme/${path}`, text])))
  await Bun.write(join(repository.root, "mcps/acme/manifest.json"), manifest([]))
  for (const [path, text] of Object.entries(await generatedFiles(repository.root))) await Bun.write(join(repository.root, path), text)
})
afterEach(() => repository.remove())

const run = async (argv: string[], exec = recorder(() => ({ code: 0, output: passing })).exec, cwd = repository.root) => {
  const io = testIo(["check", ...argv], cwd, { exec })
  return { ...io, code: await main(io.io) }
}
const lines = (text: string) => text.split("\n").map(line => line.replace(/ \(\d+ ms\)$/, ""))

test("it runs the guard, the typecheck, lint and tests in the workspace, the manifest, the generated files and the budget, one line each with counts", async () => {
  const { exec, ran } = recorder(() => ({ code: 0, output: passing }))
  const { code, stdout } = await run(["acme"], exec)
  expect(code).toBe(0)
  expect(ran.map(({ command, cwd, env }) => [command.slice(1).join(" "), cwd.slice(repository.root.length), env])).toEqual([
    ["run typecheck", "/mcps/acme", undefined], ["run lint", "/mcps/acme", undefined], ["run test", "/mcps/acme", { UPDATE_MANIFEST: "1" }],
    ["scripts/env-inventory.ts", "", undefined],
  ])
  expect(lines(stdout())).toEqual([
    "ok      guard      4 files; none names answerable.organisation_id",
    "ok      typecheck  4 files",
    "ok      lint       4 files",
    "ok      test       6 pass, 0 fail, 100% functions, 98.5% lines",
    "ok      manifest   current",
    "ok      generated  current",
    "ok      budget     no MCP has a database of its own",
    "",
  ])
})

test("with MCPs of their own database it gives each environment's connections at the ceilings, and warns on stderr past the limit", async () => {
  await Bun.write(join(repository.root, "mcps/acme/mcp.json"), JSON.stringify({ serve: "both", database: "own" }))
  for (const path of Object.keys(await generatedFiles(repository.root))) await Bun.write(join(repository.root, path), (await generatedFiles(repository.root))[path]!)
  const { code, stdout, stderr } = await run(["acme"])
  expect(code).toBe(0)
  expect(lines(stdout())).toContain("ok      budget     1 own MCP: staging 200 (30 theirs), production 280 (40 theirs) connections at the ceilings, past 100")
  expect(stderr()).toBe("Warning: with 1 MCP of their own database, the servers' pools at the autoscalers' ceilings reach staging 200 (30 theirs), production 280 (40 theirs) connections, past the 100 of PostgreSQL's default max_connections; Civo's limit is not measured yet. Prefer database shared, or see docs/12-deployment.md (Database)\n")
})

test("a stale manifest and stale generated files are rewritten, the check passes, and Next says to commit them", async () => {
  const { exec } = recorder(command => {
    if (command.at(-1) === "test") writeFileSync(join(repository.root, "mcps/acme/manifest.json"), manifest(["acme:read"]))
    return { code: 0, output: passing }
  })
  await Bun.write(join(repository.root, "charts/answerable/mcps.json"), "{}\n")
  const { code, stdout } = await run(["acme"], exec)
  expect(code).toBe(0)
  expect(stdout()).toEndWith("Next:\n  git add mcps/acme/manifest.json charts/answerable/mcps.json\n")
  expect(await Bun.file(join(repository.root, "charts/answerable/mcps.json")).text()).toBe(Object.values(await generatedFiles(repository.root))[0]!)
})

test("the generated step also runs bun run env:inventory's script, and an inventory it rewrote is listed to commit with the generated files", async () => {
  const { exec, ran } = recorder(command => {
    if (command.at(-1)?.endsWith("env-inventory.ts")) writeFileSync(join(repository.root, ".env.example"), "# written by the inventory\n")
    return { code: 0, output: passing }
  })
  const { code, stdout } = await run(["acme"], exec)
  expect(code).toBe(0)
  expect(ran.filter(({ command }) => command.at(-1)?.endsWith("env-inventory.ts")).map(({ command, cwd }) => [command.slice(1), cwd])).toEqual([[["scripts/env-inventory.ts"], repository.root]])
  expect(stdout()).toEndWith("Next:\n  git add .env.example\n")
  expect((await run(["acme"], exec)).stdout()).toContain("ok      generated  current")
})

test("from inside the MCP's directory it needs no name; a failing step stops the check and exits 1", async () => {
  const { code, stdout, stderr } = await run([], recorder(command => ({ code: command.at(-1) === "lint" ? 1 : 0, output: "src/provider.ts\n  1:1  error  no-unused-vars\n" })).exec, join(repository.root, "mcps/acme"))
  expect(code).toBe(1)
  expect(lines(stdout())).toEqual(["ok      guard      4 files; none names answerable.organisation_id", "ok      typecheck  4 files", "failed  lint      ", ""])
  expect(stderr()).toBe("lint failed: src/provider.ts\n  1:1  error  no-unused-vars\n\nFinish the job with:\n  bun mcp check acme\n")
})

test("a test run without a coverage table still reports its counts, and check takes one MCP at most", async () => {
  expect(lines((await run(["acme"], recorder(() => ({ code: 0, output: "" })).exec)).stdout())[3]).toBe("ok      test       0 pass, 0 fail")
  expect((await run(["acme", "beta"])).stderr().split("\n")[0]).toBe("bun mcp check takes one MCP; it was given acme, beta")
  expect((await run([])).stderr().split("\n")).toEqual(["Name the MCP, or run the command from inside mcps/<name>", "", "  bun mcp check <mcp>", ""])
})

test("the guard fails on every place the MCP's src names the organisation setting, in any case and any file, before anything runs", async () => {
  await Bun.write(join(repository.root, "mcps/acme/src/tools/raw.ts"), "// set_config('answerable.organisation_id', …)\nexport const raw = 'ANSWERABLE.ORGANISATION_ID'\n")
  await Bun.write(join(repository.root, "mcps/acme/src/views/page.tsx"), "export const page = 'answerable.organisation_id'\n")
  const { exec, ran } = recorder(() => ({ code: 0, output: passing }))
  const { code, stdout, stderr } = await run(["acme"], exec)
  expect([code, ran]).toEqual([1, []])
  expect(lines(stdout())).toEqual(["failed  guard     ", ""])
  expect(stderr()).toBe("guard failed: mcps/acme names answerable.organisation_id, which the platform sets to the caller's organisation on every query and a tool never sets: src/tools/raw.ts:1, src/tools/raw.ts:2, src/views/page.tsx:1\n\nFinish the job with:\n  bun mcp check acme\n")
})
