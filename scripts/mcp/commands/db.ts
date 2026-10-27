// bun mcp db [mcp] generate|migrate: an MCP's migration for a change to its schema, or its local development schema provisioned and migrated.
import { assertTablesInSchema, generateMigration } from "../database"
import { definitions } from "../definitions"
import { Refusal, runSteps, valueOf, type Command } from "../io"
import { findRoot, resolveMcp } from "../workspace"

const { usage } = definitions.db

export const db: Command = {
  ...definitions.db,
  async run(io, { positionals, flags }) {
    const action = positionals.at(-1)
    if (positionals.length > 2 || (action !== "generate" && action !== "migrate")) {
      throw new Refusal("unknown-action", `bun mcp db takes generate or migrate, after the MCP's name${action ? `, not ${positionals.join(" ")}` : ""}`, usage)
    }
    if (action === "migrate" && flags.name) throw new Refusal("unexpected-flag", "--name names the migration bun mcp db generate writes; migrate takes none", usage)
    const root = findRoot(io.cwd)
    const mcp = await resolveMcp(root, io.cwd, positionals.length === 2 ? positionals[0] : undefined, `bun mcp db <mcp> ${action}`)
    if (action === "migrate") return runSteps(io, [{ name: "database", fix: `bun mcp db ${mcp.name} migrate`, run: async () => (await io.migrate(root, [mcp]))[0]! }], () => [])
    await assertTablesInSchema(root, mcp.name)
    let written: string[] = []
    return runSteps(io, [{
      name: "migration",
      fix: `bun mcp db ${mcp.name} generate`,
      run: async () => {
        written = await generateMigration(io.exec, root, mcp.name, valueOf(flags.name))
        return written.join(", ") || "no change to src/db/schema.ts"
      },
    }], () => (written.length ? [`bun mcp db ${mcp.name} migrate`, `git add mcps/${mcp.name}/drizzle`] : []))
  },
}
