// bun mcp db [mcp] generate|migrate: an MCP's migration for a change to its schema, or its local development schema provisioned and migrated.
import { assertTablesInSchema, generateMigration, migrateLocal } from "../database"
import { jsonFlag, Refusal, runSteps, type Command } from "../io"
import { findRoot, resolveMcp } from "../workspace"

const usage = "bun mcp db [mcp] generate|migrate [--name <change>] [--json]"

export const db: Command = {
  name: "db",
  usage,
  summary: "generate: write the migration for a change to an MCP's src/db/schema.ts, without drizzle-kit's schema line. migrate: provision and migrate its local development schema",
  flags: { name: { value: "<change>", description: "generate only: the migration's name, drizzle/<number>_<change>.sql; default: drizzle-kit's" }, json: jsonFlag },
  example: "bun mcp db acme generate --name notes",
  async run(io, { positionals, flags }) {
    const action = positionals.at(-1)
    if (positionals.length > 2 || (action !== "generate" && action !== "migrate")) {
      throw new Refusal("unknown-action", `bun mcp db takes generate or migrate, after the MCP's name${action ? `, not ${positionals.join(" ")}` : ""}`, usage)
    }
    if (action === "migrate" && flags.name) throw new Refusal("unexpected-flag", "--name names the migration bun mcp db generate writes; migrate takes none", usage)
    const root = findRoot(io.cwd)
    const mcp = await resolveMcp(root, io.cwd, positionals.length === 2 ? positionals[0] : undefined, `bun mcp db <mcp> ${action}`)
    const json = flags.json === true
    if (action === "migrate") return runSteps(io, json, [{ name: "database", fix: `bun mcp db ${mcp.name} migrate`, run: () => migrateLocal(root, mcp) }], () => [])
    await assertTablesInSchema(root, mcp.name)
    let written: string[] = []
    return runSteps(io, json, [{
      name: "migration",
      fix: `bun mcp db ${mcp.name} generate`,
      run: async () => {
        written = await generateMigration(io.exec, root, mcp.name, typeof flags.name === "string" ? flags.name : undefined)
        return written.join(", ") || "no change to src/db/schema.ts"
      },
    }], () => (written.length ? [`bun mcp db ${mcp.name} migrate`, `git add mcps/${mcp.name}/drizzle`] : []))
  },
}
