import { defineProvider, withDatabase } from "@answerable/mcp"
import { asc } from "drizzle-orm"
import { z } from "zod"
import * as schema from "./mpgfixa"
import { projects } from "./mpgfixa"

// A fixture MCP with a database, as an MCP's src/mcp.ts and tool files write it: its handlers reach mpgfixa through context.db.
const { defineTool, defineMutation } = withDatabase({ schema })

const projectsList = defineTool({
  name: "projects.list", description: "List the projects of the caller's organisation by name. A fixture MCP with a database.",
  input: z.object({}), output: z.object({ names: z.array(z.string()) }), example: {},
  async execute(_input, { db }) {
    return { names: (await db.query.projects.findMany({ orderBy: [asc(projects.name)] })).map(project => project.name) }
  },
})

const projectsAdd = defineMutation({
  name: "projects.add", risk: "low", description: "Prepare adding a project to the caller's organisation; commit the intent to add it. A fixture MCP with a database.",
  input: z.object({ name: z.string().min(1) }), output: z.object({ id: z.uuid() }), example: { name: "Tower" },
  async prepare({ name }) {
    return { targets: [], preview: { summary: `Add project “${name}”`, changes: [{ path: "projects[]", to: { name } }] }, plan: { name } }
  },
  async commit({ plan }, { db, organisation }) {
    const [added] = await db.insert(projects).values({ organisation_id: organisation.id, name: plan.name }).returning({ id: projects.id })
    return { results: added!, applied_changes: [{ path: "projects[]", to: { name: plan.name } }], effects_performed: [] }
  },
})

export const provider = defineProvider({
  id: "mpgfixa", description: "A fixture MCP with a database: the projects of the caller's organisation, in schema mpgfixa.", version: "2026-10-25",
  database: { schema, migrations: new URL("mpgfixa", import.meta.url) }, tools: [projectsList, projectsAdd],
})
