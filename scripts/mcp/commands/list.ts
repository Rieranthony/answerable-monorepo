// bun mcp list: one line per MCP, sorted by name: where it runs, its database mode, its tools, what it is for and its local URL.
import { Refusal, type Command } from "../io"
import { declarations, findRoot, manifestOf, type Declaration } from "../workspace"

/** Where an MCP is reached on this machine: the Toolbox's one URL, and its own path on the standalone server. */
const localUrls = ({ name, serve }: Pick<Declaration, "name" | "serve">) => [
  ...(serve === "standalone" ? [] : ["http://localhost:47400/mcp"]),
  ...(serve === "toolbox" ? [] : [`http://localhost:47510/${name}/mcp`]),
]

const firstSentence = (text: string) => text.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? text

export const list: Command = {
  name: "list",
  usage: "bun mcp list [--json]",
  summary: "Every MCP with an mcp.json, sorted by name: where it runs, its database mode, its tools, the first sentence of its description and its local URL",
  flags: { json: { description: "Print one JSON object: { ok, mcps: [{ name, serve, database, description, tools, urls: { local } }] }" } },
  example: "bun mcp list --json",
  async run(io, { positionals, flags }) {
    if (positionals.length) throw new Refusal("unexpected-argument", `bun mcp list takes no argument; it was given ${positionals.join(", ")}`, "bun mcp list")
    const root = findRoot(io.cwd)
    const mcps = await Promise.all((await declarations(root)).map(async ({ name, serve, database }) => {
      const manifest = await manifestOf(root, name)
      const tools = manifest?.tools.filter(tool => tool.kind !== "commit").map(tool => tool.identity.slice(name.length + 1)) ?? []
      return { name, serve, database, description: manifest?.description ?? "", tools, urls: { local: localUrls({ name, serve }) } }
    }))
    if (flags.json === true) {
      io.stdout.write(`${JSON.stringify({ ok: true, mcps }, null, 2)}\n`)
      return 0
    }
    const rows = mcps.map(mcp => [mcp.name, mcp.serve, mcp.database, `${mcp.tools.length} tool${mcp.tools.length === 1 ? "" : "s"}`, firstSentence(mcp.description), mcp.urls.local.join(" ")])
    const widths = rows.reduce((max, row) => row.map((cell, index) => Math.max(max[index] ?? 0, cell.length)), [] as number[])
    io.stdout.write(rows.length ? rows.map(row => `${row.map((cell, index) => (index < row.length - 1 ? cell.padEnd(widths[index]!) : cell)).join("  ")}\n`).join("") : "No MCP has an mcp.json yet: bun mcp new <name> makes one\n")
    return 0
  },
}
