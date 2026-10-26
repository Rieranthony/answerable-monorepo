// bun mcp end to end, as a coding agent runs it: in a copy of the working tree as it is (untracked files included, never HEAD), without a
// terminal, with a random name, against the development Postgres on 47432, as bun run mcp:test uses it. No ID. Whatever happens, the MCP's
// schemas and the copy are removed.
import { expect, test } from "bun:test"
import { existsSync, lstatSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { forget, randomName, traces } from "@answerable/scripts/postgres"
import { step } from "../step"

const repo = new URL("../../../../", import.meta.url).pathname
const name = randomName()
let copy: string | undefined

// A command run to its end in the copy: its exit code and its output, stdout then stderr.
async function run(command: string[], cwd = copy!) {
  const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" })
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  return { code, output: `${stdout}${stderr}` }
}
const bun = (...argv: string[]) => run([process.execPath, ...argv])
const steps = (output: string) => [...output.matchAll(/^(ok|failed) +(\S+) .*\((\d+(?:\.\d+)? m?s)\)$/gm)].map(([, status, step]) => `${status} ${step}`)

// The copy, with its own install as CI makes one; inside the test, which has the time it needs.
async function copyWorkingTree() {
  copy = await mkdtemp(join(tmpdir(), "bun-mcp-end-to-end-"))
  const listed = await run(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], repo)
  for (const path of listed.output.split("\0").filter(Boolean)) {
    // A tracked file deleted in the working tree is listed but gone; a link is copied as the file it points to.
    if (!existsSync(join(repo, path)) || lstatSync(join(repo, path)).isDirectory()) continue
    await Bun.write(join(copy, path), Bun.file(join(repo, path)))
  }
  const install = await bun("install", "--frozen-lockfile")
  if (install.code) throw new Error(`bun install --frozen-lockfile failed in the copy:\n${install.output}`)
}

test("bun mcp new, check, add tool for a read and a mutation, list and a second new, without a terminal", async () => {
  try {
    step(`bun mcp end to end in a copy of the working tree, with the MCP ${name}`)
    await copyWorkingTree()
    const description = "An end-to-end test's MCP, made and removed by packages/acceptance/src/journeys/scaffold.journeys.test.ts."
    const made = await bun("mcp", "new", name, "--description", description, "--serve", "toolbox")
    expect(made.code, made.output).toBe(0)
    expect(steps(made.output)).toEqual(["ok write", "ok generate", "ok install", "ok migration", "ok database", "ok check"])
    expect(made.output).toContain(`it has no tool yet.\n`)
    expect(made.output).toContain(`Next:\n  bun mcp add tool ${name} <domain.operation>`)

    const checked = await bun("mcp", "check", name)
    expect(checked.code, checked.output).toBe(0)
    expect(steps(checked.output)).toEqual(["ok guard", "ok typecheck", "ok lint", "ok test", "ok manifest", "ok generated", "ok budget"])

    const listed = await bun("mcp", "add", "tool", name, "notes.list", "--description", "List the notes of the caller's organisation, newest first, 20 per page.")
    expect(listed.code, listed.output).toBe(0)
    expect(steps(listed.output)).toEqual(["ok write", "ok migration", "ok check"])
    const added = await bun("mcp", "add", "tool", name, "notes.add", "--mutation", "--description", "Prepare a new note; commit the intent to save it. Use notes.list first to avoid duplicates.")
    expect(added.code, added.output).toBe(0)
    expect(steps(added.output)).toEqual(["ok write", "ok migration", "ok check"])

    const all = await bun("mcp", "list")
    const lines = all.output.split("\n")
    const row = lines.findIndex(line => line.startsWith(`${name} `))
    expect(lines[row]!.split(/ {2,}/)).toEqual([name, "toolbox", "shared", "2 tools", "An end-to-end test's MCP, made and removed by packages/acceptance/src/journeys/scaffold.journeys.test.ts.", "http://localhost:47400/mcp"])
    expect(lines[row + 1]).toBe("  staging https://toolbox.answerable-staging.uk/mcp  production https://toolbox.answerable.org/mcp")
    const again = await bun("mcp", "new", name, "--description", description, "--serve", "toolbox")
    expect(again.code).toBe(2)
    expect(again.output).toContain(`${name} is taken by mcps/${name}; choose another name`)
    // Its schema in the shared database and in the test database, and no role.
    expect(await traces(name)).toEqual([`answerable_mcps.${name}`, `answerable_mcps_test.${name}`])
  } finally {
    // Removing an installed copy and the MCP's schemas can outlast Bun's 5-second hook timeout, and Bun 1.3.1 gives a hook no timeout of its own.
    await forget(name)
    if (copy) await rm(copy, { recursive: true, force: true })
  }
}, 300_000)
