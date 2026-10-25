// One tool's file and its test: a read that lists its domain's table, a mutation that adds a row to it, or the status tool `bun mcp new` writes
// when the first tool is skipped. Each file opens with the guidance the design gives (docs/goals/mcp-cli/design.md).
import { tableBinding, toolBinding, wireName, type ToolAnswers } from "./names"

/** The status tool's description: the first tool when `bun mcp new` is not given one. */
export const statusDescription = (name: string) => `Report that ${name} is running and who is calling: your name and your organisation's. Replace it with the MCP's first real tool.`

const naming = (name: string, tool: string) => `// One tool = one thing the caller can do. Hosts call this tool ${name}_${wireName(tool)} in the Toolbox, ${wireName(tool)} alone.
//
// name: <domain>.<operation>, from the caller's side: notes.list, projects.search, rfis.create.
//   Never the vendor or the transport (sharepoint_query), never a mode switch (manage_notes).
//   Unique in this MCP; the CLI and defineProvider refuse a second one.
//`

const readGuidance = (name: string, tool: string) => `${naming(name, tool)}
// description: the model reads only this to choose the tool. Say what it does, when to use it,
//   its limits (page size, what it cannot see) and what the ids mean. 40 to 1,000 characters.
//   Good: "List the notes of a project, newest first, 20 per page. Use projects.search first to find the project id."
//   Bad: "Gets notes."
//
// input and output: Zod objects. Describe every field (.describe("…")): hosts show it to the model.
//   A list takes limit and cursor and returns items, next_cursor and has_more (the conformance kit checks it).
//
// execute: gets the checked input and the caller: person, organisation and db. Row-level security (D19) limits every query to
//   the caller's organisation, so no query filters on it by hand. Throw ToolError for a failure the caller can fix.
`

const mutationGuidance = (name: string, tool: string) => `${naming(name, tool)}
// description: the model reads only this to choose the tool. Say what it changes, that it prepares an intent to commit, when to use it
//   and its limits. 40 to 1,000 characters, with the word "prepare" or "intent" (the conformance kit checks it).
//   Good: "Prepare a new note on a project; commit it to save it. Use notes.list first to avoid duplicates."
//   Bad: "Adds notes."
//
// input and output: Zod objects. Describe every field (.describe("…")): hosts show it to the model. output is the receipt's results.
//
// risk: low lets the agent commit on its own; normal, the default, shows the person the preview's summary first; high needs a
//   person's approval.
//
// prepare: computes the preview and changes nothing. It checks the input, reads nothing that changes, and returns the summary the
//   person confirms, naming their organisation.
//
// commit: applies exactly what was prepared, from plan. Row-level security (D19) limits it to the caller's organisation, so it
//   sets organisation_id from organisation.id and filters on nothing by hand. Throw ToolError for a failure the caller can fix.
`

const status = (name: string) => `${readGuidance(name, `${name}.status`)}import { z } from "zod"
import { defineTool } from "../mcp"

export const ${toolBinding(`${name}.status`)} = defineTool({
  name: "${name}.status",
  description: ${JSON.stringify(statusDescription(name))},
  input: z.object({}),
  output: z.object({
    status: z.string().describe("ok while the MCP runs"),
    person: z.string().describe("Your name"),
    organisation: z.string().describe("Your organisation's name"),
  }),
  example: {},
  async execute(_input, { person, organisation }) {
    return { status: "ok", person: person.name, organisation: organisation.name }
  },
})
`

const read = (name: string, { name: tool, description }: ToolAnswers) => `${readGuidance(name, tool)}import { desc, lt } from "drizzle-orm"
import { z } from "zod"
import * as schema from "../db/schema"
import { defineTool } from "../mcp"

const item = z.object({
  id: z.uuid().describe("The row's id"),
  title: z.string(),
  created_at: z.iso.datetime().describe("When it was added"),
})

export const ${toolBinding(tool)} = defineTool({
  name: "${tool}",
  description: ${JSON.stringify(description)},
  input: z.object({
    limit: z.number().int().min(1).max(100).default(20).describe("Items per page, 1 to 100"),
    cursor: z.uuid().optional().describe("next_cursor from the previous page; omit it for the first page"),
  }),
  output: z.object({
    items: z.array(item).describe("Newest first"),
    next_cursor: z.uuid().nullable().describe("The cursor of the next page, or null on the last"),
    has_more: z.boolean(),
  }),
  example: { limit: 5 },
  async execute({ limit, cursor }, { db }) {
    const table = schema.${tableBinding(tool.split(".")[0]!)}
    const rows = await db.select().from(table).where(cursor ? lt(table.id, cursor) : undefined).orderBy(desc(table.id)).limit(limit + 1)
    const items = rows.slice(0, limit).map(row => ({ id: row.id, title: row.title, created_at: row.created_at.toISOString() }))
    const has_more = rows.length > limit
    return { items, next_cursor: has_more ? items.at(-1)!.id : null, has_more }
  },
})
`

const mutation = (name: string, { name: tool, description }: ToolAnswers) => {
  const domain = tool.split(".")[0]!
  return `${mutationGuidance(name, tool)}import { z } from "zod"
import * as schema from "../db/schema"
import { defineMutation } from "../mcp"

export const ${toolBinding(tool)} = defineMutation({
  name: "${tool}",
  description: ${JSON.stringify(description)},
  risk: "normal",
  input: z.object({ title: z.string().trim().min(1).max(200).describe("The title, 1 to 200 characters") }),
  output: z.object({ id: z.uuid(), title: z.string(), created_at: z.iso.datetime() }),
  example: { title: "First" },
  async prepare({ title }, { organisation }) {
    return {
      targets: [],
      preview: { summary: \`Add “\${title}” to the ${domain} of \${organisation.name}\`, changes: [{ path: "${domain}[]", to: { title } }] },
      plan: { title },
    }
  },
  async commit({ plan }, { db, organisation }) {
    const [row] = await db.insert(schema.${tableBinding(domain)}).values({ organisation_id: organisation.id, title: plan.title }).returning()
    const added = { id: row!.id, title: row!.title, created_at: row!.created_at.toISOString() }
    return { results: added, applied_changes: [{ path: "${domain}[]", to: added }], effects_performed: [] }
  },
})
`
}

/** A tool's file, `src/tools/<domain>-<operation>.ts`; without `tool`, the status tool of MCP `name`. */
export const toolTs = (name: string, tool?: ToolAnswers) => (!tool ? status(name) : tool.mutation ? mutation(name, tool) : read(name, tool))

const statusTest = (name: string) => `import { expect, test } from "bun:test"
import { createTestMcp } from "@answerable/mcp-postgres/testing"
import { provider } from "../provider"

test("${name}_status says who is calling and from which organisation", async () => {
  const mcp = await createTestMcp(provider)
  try {
    const client = await mcp.connect({ person: { name: "Ada Lovelace" }, organisation: { name: "Acme" } })
    const result = await client.callTool({ name: "${name}_status", arguments: {} })
    expect(result.structuredContent).toEqual({ status: "ok", person: "Ada Lovelace", organisation: "Acme" })
  } finally {
    await mcp.close()
  }
})
`

const readTest = ({ name: tool }: ToolAnswers) => {
  const table = `schema.${tableBinding(tool.split(".")[0]!)}`
  return `import { expect, test } from "bun:test"
import { createTestMcp } from "@answerable/mcp-postgres/testing"
import * as schema from "../db/schema"
import { provider } from "../provider"

type Page = { items: { title: string }[]; next_cursor: string | null; has_more: boolean }

test("${wireName(tool)} lists the caller's organisation's rows only, newest first, a page at a time", async () => {
  const mcp = await createTestMcp(provider)
  try {
    const [mine, theirs] = [crypto.randomUUID(), crypto.randomUUID()]
    for (const title of ["First", "Second", "Third"]) await mcp.asOrganisation(mine, () => mcp.db.insert(${table}).values({ organisation_id: mine, title }))
    await mcp.asOrganisation(theirs, () => mcp.db.insert(${table}).values({ organisation_id: theirs, title: "Theirs" }))
    const client = await mcp.connect({ organizationId: mine })
    const first = (await client.callTool({ name: "${wireName(tool)}", arguments: { limit: 2 } })).structuredContent as Page
    expect(first.items.map(item => item.title)).toEqual(["Third", "Second"])
    expect(first.has_more).toBe(true)
    const second = await client.callTool({ name: "${wireName(tool)}", arguments: { limit: 2, cursor: first.next_cursor } })
    expect(second.structuredContent).toMatchObject({ items: [{ title: "First" }], next_cursor: null, has_more: false })
    const other = await mcp.connect({ organizationId: theirs })
    expect((await other.callTool({ name: "${wireName(tool)}", arguments: {} })).structuredContent).toMatchObject({ items: [{ title: "Theirs" }] })
  } finally {
    await mcp.close()
  }
})
`
}

const mutationTest = ({ name: tool }: ToolAnswers) => {
  const domain = tool.split(".")[0]!
  const table = `schema.${tableBinding(domain)}`
  return `import { expect, test } from "bun:test"
import { createTestMcp } from "@answerable/mcp-postgres/testing"
import * as schema from "../db/schema"
import { provider } from "../provider"

type Intent = { intent_id: string; commit_token: string; commit_tool: string; preview: { summary: string } }

test("${wireName(tool)} prepares a row, and the commit tool its intent names adds it to the caller's organisation only", async () => {
  const mcp = await createTestMcp(provider)
  try {
    const [mine, theirs] = [crypto.randomUUID(), crypto.randomUUID()]
    const client = await mcp.connect({ organizationId: mine, organisation: { name: "Acme" } })
    const intent = (await client.callTool({ name: "${wireName(tool)}", arguments: { title: "First" } })).structuredContent as Intent
    expect(intent.preview.summary).toBe("Add “First” to the ${domain} of Acme")
    const { intent_id, commit_token, preview } = intent
    const committed = await client.callTool({ name: intent.commit_tool, arguments: { intent_id, commit_token, preview_summary: preview.summary } })
    expect(committed.structuredContent).toMatchObject({ status: "committed", results: { title: "First" } })
    expect(await mcp.asOrganisation(mine, () => mcp.db.select({ title: ${table}.title }).from(${table}))).toEqual([{ title: "First" }])
    expect(await mcp.asOrganisation(theirs, () => mcp.db.select().from(${table}))).toEqual([])
  } finally {
    await mcp.close()
  }
})
`
}

/** A tool's test, beside its file; without `tool`, the status tool's test of MCP `name`. */
export const toolTest = (name: string, tool?: ToolAnswers) => (!tool ? statusTest(name) : tool.mutation ? mutationTest(tool) : readTest(tool))
