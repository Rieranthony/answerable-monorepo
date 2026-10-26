// bun mcp check [mcp]: the organisation guard, the MCP's typecheck, lint and tests, then its manifest, the generated files and the connection budget.
import { join } from "node:path"
import { budget, connectionsAtCeilings } from "../connections"
import { definitions } from "../definitions"
import { generate } from "../generate"
import { Refusal, runSteps, sh, type Command, type Io, type Step } from "../io"
import { declarations, findRoot, resolveMcp } from "../workspace"

// The files `bun run env:inventory` writes (scripts/env-inventory.ts), from every service's configuration, which a generated list can change.
const inventories = [".env.example", "packages/config/inventory.json"]

// The setting the platform sets to the caller's organisation on every query (@answerable/mcp-postgres, organisation.ts), which a tool never sets.
const organisationSetting = /answerable\.organisation_id/gi

/**
 * The files of the MCP's `src`, and each place in them that names the organisation setting, as `src/<path>:<line>`, sorted. A guard against a
 * mistake, not a boundary: a name built at run time gets past it.
 */
async function settingsIn(dir: string) {
  const found: string[] = []
  let files = 0
  for await (const path of new Bun.Glob("src/**/*").scan({ cwd: dir })) {
    const text = await Bun.file(join(dir, path)).text()
    files += 1
    for (const match of text.matchAll(organisationSetting)) found.push(`${path}:${text.slice(0, match.index).split("\n").length}`)
  }
  return { files, found: found.sort() }
}

// What a test run reports: its counts, and the coverage of every file when the workspace gates it.
function testSummary(output: string) {
  const [pass, fail] = [/(\d+) pass/, /(\d+) fail/].map(count => output.match(count)?.[1] ?? "0")
  const coverage = output.match(/All files\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)/)
  return `${pass} pass, ${fail} fail${coverage ? `, ${Number(coverage[1])}% functions, ${Number(coverage[2])}% lines` : ""}`
}

/**
 * The steps that check MCP `name`, and the files they rewrote, to commit. The tests run with `UPDATE_MANIFEST=1`, so a stale manifest is
 * rewritten rather than failed; the manifest step then says so, and the generated files, with the inventories the lists can change, are
 * rewritten the same way.
 */
function checkSteps(io: Io, root: string, name: string): { steps: Step[]; rewritten: string[] } {
  const dir = join(root, "mcps", name)
  const fix = `bun mcp check ${name}`
  const rewritten: string[] = []
  let before: string | undefined
  const run = (script: string, env?: Record<string, string>) => sh(io, [process.execPath, "run", script], dir, env)
  const sources = async () => `${(await Array.fromAsync(new Bun.Glob("src/**/*.ts").scan({ cwd: dir }))).length} files`
  // A file of its own each time: a Bun.file made before the file exists keeps answering that it does not (Bun 1.3.1), and new makes the steps first.
  const read = async () => {
    const manifest = Bun.file(join(dir, "manifest.json"))
    return (await manifest.exists()) ? manifest.text() : undefined
  }
  return {
    rewritten,
    steps: [
      {
        name: "guard", fix, run: async () => {
          const { files, found } = await settingsIn(dir)
          if (found.length) {
            throw new Error(`mcps/${name} names answerable.organisation_id, which the platform sets to the caller's organisation on every query and a tool never sets: ${found.join(", ")}`)
          }
          return `${files} files; none names answerable.organisation_id`
        },
      },
      { name: "typecheck", fix, run: async () => (await run("typecheck"), sources()) },
      { name: "lint", fix, run: async () => (await run("lint"), sources()) },
      { name: "test", fix, run: async () => ((before = await read()), testSummary(await run("test", { UPDATE_MANIFEST: "1" }))) },
      {
        name: "manifest", fix, run: async () => {
          if ((await read()) === before) return "current"
          rewritten.push(`mcps/${name}/manifest.json`)
          return `rewritten: commit mcps/${name}/manifest.json`
        },
      },
      {
        name: "generated", fix, run: async () => {
          const stale = await generate(root, { write: true })
          // The inventories are written by a process of their own, which reads the lists just written.
          const texts = () => Promise.all(inventories.map(async path => ((await Bun.file(join(root, path)).exists()) ? Bun.file(join(root, path)).text() : undefined)))
          const held = await texts()
          await sh(io, [process.execPath, "scripts/env-inventory.ts"], root)
          const written = await texts()
          stale.push(...inventories.filter((_, index) => held[index] !== written[index]))
          rewritten.push(...stale)
          return stale.length ? `rewritten: commit ${stale.join(", ")}` : "current"
        },
      },
      { name: "budget", fix, run: async () => budgetOf(io, await declarations(root)) },
    ],
  }
}

/**
 * The connection budget, with every MCP declared: nothing to say while none has a database of its own, since the shared ones add no pool;
 * otherwise each environment's connections at the autoscalers' ceilings, and a warning on stderr past the limit.
 */
function budgetOf(io: Io, mcps: Awaited<ReturnType<typeof declarations>>) {
  const own = mcps.filter(mcp => mcp.database === "own").length
  if (!own) return "no MCP has a database of its own"
  const at = (["staging", "production"] as const).map(environment => ({ environment, ...connectionsAtCeilings(mcps, environment) }))
  const over = at.filter(({ total }) => total > budget.maxConnections)
  const figures = at.map(({ environment, total, own: theirs }) => `${environment} ${total} (${theirs} theirs)`).join(", ")
  if (over.length) {
    io.stderr.write(`Warning: with ${own} MCP${own === 1 ? "" : "s"} of their own database, the servers' pools at the autoscalers' ceilings reach ${figures} connections, past the ${budget.maxConnections} of PostgreSQL's default max_connections; Civo's limit is not measured yet. Prefer database shared, or see docs/12-deployment.md (Database)\n`)
  }
  return `${own} own MCP${own === 1 ? "" : "s"}: ${figures} connections at the ceilings, ${over.length ? "past" : "within"} ${budget.maxConnections}`
}

/** The check, as one step of a bigger command: each of its steps in turn, their details joined, and the files they rewrote; the first failure names its step. */
export function checkStep(io: Io, root: string, name: string): Omit<Step, "fix"> & { rewritten: readonly string[] } {
  const { steps, rewritten } = checkSteps(io, root, name)
  return {
    name: "check",
    rewritten,
    run: async () => {
      const details: string[] = []
      for (const step of steps) details.push(`${step.name} ${await step.run().catch((error: Error) => { throw new Error(`${step.name}: ${error.message}`) })}`)
      return details.join("; ")
    },
  }
}

const { usage } = definitions.check

export const check: Command = {
  ...definitions.check,
  async run(io, { positionals }) {
    if (positionals.length > 1) throw new Refusal("unexpected-argument", `bun mcp check takes one MCP; it was given ${positionals.join(", ")}`, usage)
    const root = findRoot(io.cwd)
    const { name } = await resolveMcp(root, io.cwd, positionals[0], "bun mcp check <mcp>")
    const { steps, rewritten } = checkSteps(io, root, name)
    return runSteps(io, steps, () => (rewritten.length ? [`git add ${rewritten.join(" ")}`] : []))
  },
}
