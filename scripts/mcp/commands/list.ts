// bun mcp list: one line per MCP, sorted by name: where it runs, its database mode, its tools, what it is for and its local URL, then its
// staging and production URLs.
import { hostsFor } from "../../../infra/pipeline/src/environments"
import { definitions } from "../definitions"
import { Refusal, type Command } from "../io"
import { local } from "../local"
import { declarations, findRoot, manifestOf, type Declaration } from "../workspace"

/** Where an MCP is reached: the Toolbox's hub, and its own path on the origin where the Toolbox serves it alone. */
const urlsOf = ({ name, serve }: Pick<Declaration, "name" | "serve">, { toolbox, standalone }: { toolbox: string; standalone: string }) => [
  ...(serve === "standalone" ? [] : [toolbox]),
  ...(serve === "toolbox" ? [] : [`${standalone}/${name}/mcp`]),
]
const here = { toolbox: local.toolboxResource, standalone: local.toolbox }
/** An environment's Toolbox hub and the origin of the MCPs it serves alone, as the deployment names them (infra/pipeline/src/environments.ts). */
const deployed = (environment: "staging" | "production") => {
  const hosts = hostsFor(environment)
  return { toolbox: `https://${hosts.toolbox}/mcp`, standalone: `https://${hosts.mcp}` }
}

const firstSentence = (text: string) => text.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? text

export const list: Command = {
  ...definitions.list,
  async run(io, { positionals, flags }) {
    if (positionals.length) throw new Refusal("unexpected-argument", `bun mcp list takes no argument; it was given ${positionals.join(", ")}`, "bun mcp list")
    const root = findRoot(io.cwd)
    const mcps = await Promise.all((await declarations(root)).map(async ({ name, serve, database }) => {
      const manifest = await manifestOf(root, name)
      const tools = manifest?.tools.filter(tool => tool.kind !== "commit").map(tool => tool.identity.slice(name.length + 1)) ?? []
      const urls = { local: urlsOf({ name, serve }, here), staging: urlsOf({ name, serve }, deployed("staging")), production: urlsOf({ name, serve }, deployed("production")) }
      return { name, serve, database, description: manifest?.description ?? "", tools, urls }
    }))
    if (flags.json === true) {
      io.stdout.write(`${JSON.stringify({ ok: true, mcps }, null, 2)}\n`)
      return 0
    }
    const rows = mcps.map(mcp => [mcp.name, mcp.serve, mcp.database, `${mcp.tools.length} tool${mcp.tools.length === 1 ? "" : "s"}`, firstSentence(mcp.description), mcp.urls.local.join(" ")])
    const widths = rows.reduce((max, row) => row.map((cell, index) => Math.max(max[index] ?? 0, cell.length)), [] as number[])
    const deployedLine = (mcp: (typeof mcps)[number]) => `  staging ${mcp.urls.staging.join(" ")}  production ${mcp.urls.production.join(" ")}\n`
    io.stdout.write(rows.length ? rows.map((row, index) => `${row.map((cell, column) => (column < row.length - 1 ? cell.padEnd(widths[column]!) : cell)).join("  ")}\n${deployedLine(mcps[index]!)}`).join("") : "No MCP has an mcp.json yet: bun mcp new <name> makes one\n")
    return 0
  },
}
