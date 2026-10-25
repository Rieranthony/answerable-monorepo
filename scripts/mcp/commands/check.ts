// bun mcp check [mcp]: the MCP's typecheck, lint and tests, then its manifest, the generated files, the role-switching scan and the
// connection budget.
import { join } from "node:path"
import { budget, connectionsAtCeilings } from "../connections"
import { generate } from "../generate"
import { jsonFlag, Refusal, runSteps, sh, type Command, type Io, type Step } from "../io"
import { roleSwitching } from "../role-switching"
import { declarations, findRoot, resolveMcp } from "../workspace"

// What a test run reports: its counts, and the coverage of every file when the workspace gates it.
function testSummary(output: string) {
  const [pass, fail] = [/(\d+) pass/, /(\d+) fail/].map(count => output.match(count)?.[1] ?? "0")
  const coverage = output.match(/All files\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)/)
  return `${pass} pass, ${fail} fail${coverage ? `, ${Number(coverage[1])}% functions, ${Number(coverage[2])}% lines` : ""}`
}

/**
 * The steps that check MCP `name`, and the commands that come next once they ran. The tests run with `UPDATE_MANIFEST=1`, so a stale manifest is
 * rewritten rather than failed; the manifest step then says so, and the generated files are rewritten the same way: both to commit.
 */
function checkSteps(io: Io, root: string, name: string): { steps: Step[]; next: () => string[] } {
  const dir = join(root, "mcps", name)
  const manifest = Bun.file(join(dir, "manifest.json"))
  const fix = `bun mcp check ${name}`
  const rewritten: string[] = []
  let before: string | undefined
  const run = (script: string, env?: Record<string, string>) => sh(io, [process.execPath, "run", script], dir, env)
  const sources = async () => `${(await Array.fromAsync(new Bun.Glob("src/**/*.ts").scan({ cwd: dir }))).length} files`
  const read = async () => ((await manifest.exists()) ? manifest.text() : undefined)
  return {
    next: () => (rewritten.length ? [`git add ${rewritten.join(" ")}`] : []),
    steps: [
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
          rewritten.push(...stale)
          return stale.length ? `rewritten: commit ${stale.join(", ")}` : "current"
        },
      },
      {
        name: "scan", fix, run: async () => {
          const { files, found } = await roleSwitching(root, `mcps/${name}/src/**/*.ts`)
          if (found.length) throw new Error(`an MCP's code may not switch role or set the caller's organisation; mcpDatabase does both:\n${found.join("\n")}`)
          return `${files} files, no role switch`
        },
      },
      { name: "budget", fix, run: async () => budgetOf(io, await declarations(root)) },
    ],
  }
}

/**
 * The connection budget, with every MCP declared: nothing to say while none has a database of its own, since the shared ones add no pool;
 * otherwise each environment's connections at the autoscalers' ceilings, and a warning on stderr, which --json leaves alone, past the limit.
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

/** The check, as one step of a bigger command: each of its steps in turn, their details joined; the first failure names its step. */
export const checkStep = (io: Io, root: string, name: string): Omit<Step, "fix"> => ({
  name: "check",
  run: async () => {
    const details: string[] = []
    for (const step of checkSteps(io, root, name).steps) {
      details.push(`${step.name} ${await step.run().catch((error: Error) => { throw new Error(`${step.name}: ${error.message}`) })}`)
    }
    return details.join("; ")
  },
})

const usage = "bun mcp check [mcp] [--json]"

export const check: Command = {
  name: "check",
  usage,
  summary: "Typecheck, lint and test an MCP, with the conformance kit and its coverage gate; rewrite a stale manifest and the generated files, to commit; scan its code for role switches",
  flags: { json: jsonFlag },
  example: "bun mcp check acme",
  async run(io, { positionals, flags }) {
    if (positionals.length > 1) throw new Refusal("unexpected-argument", `bun mcp check takes one MCP; it was given ${positionals.join(", ")}`, usage)
    const root = findRoot(io.cwd)
    const { name } = await resolveMcp(root, io.cwd, positionals[0], "bun mcp check <mcp>")
    const { steps, next } = checkSteps(io, root, name)
    return runSteps(io, flags.json === true, steps, next)
  },
}
