import { expect, test } from "bun:test"
import { pgSchema, text, uuid } from "drizzle-orm/pg-core"
import { z } from "zod"
import { defineMutation, defineTool, withDatabase } from "./index"

// The type checks are the point: `bun run typecheck` fails when a `@ts-expect-error` below stops being an error.
const acme = pgSchema("acme")
const notes = acme.table("notes", { id: uuid().primaryKey(), body: text().notNull() })
const schema = { acme, notes }
const typed = withDatabase({ schema })
const description = "A fixture for the database types: it reads the notes of the caller's organisation."

test("withDatabase's definitions give every handler context.db typed by the schema; the plain ones give no db", () => {
  const list = typed.defineTool({
    name: "notes.list", description, input: z.object({}), output: z.object({ bodies: z.array(z.string()) }),
    async execute(_input, { db }) {
      const rows = await db.query.notes.findMany()
      // @ts-expect-error: the schema has no table named projects
      void db.query.projects
      // @ts-expect-error: a note has no title
      void rows[0]?.title
      return { bodies: rows.map(row => row.body) }
    },
  })
  const add = typed.defineMutation({
    name: "notes.add", description: `${description} Prepare it, then commit the intent.`, input: z.object({ body: z.string() }), output: z.object({}),
    async prepare({ body }, { db }) {
      await db.select({ id: notes.id }).from(notes)
      return { targets: [], preview: { summary: `Add “${body}”` }, plan: { body } }
    },
    async commit({ plan }, { db }) {
      await db.insert(notes).values({ id: crypto.randomUUID(), body: plan.body })
      return { results: {}, applied_changes: [], effects_performed: [] }
    },
  })
  const plain = defineTool({
    name: "notes.count", description, input: z.object({}), output: z.object({}),
    async execute(_input, context) {
      // @ts-expect-error: a plain defineTool's context has no db
      void context.db
      return {}
    },
  })
  const plainMutation = defineMutation({
    name: "notes.clear", description: `${description} Prepare it, then commit the intent.`, input: z.object({}), output: z.object({}),
    async prepare(_input, context) {
      // @ts-expect-error: a plain defineMutation's context has no db
      void context.db
      return { targets: [], preview: { summary: "Clear the notes" } }
    },
    async commit() { return { results: {}, applied_changes: [], effects_performed: [] } },
  })
  for (const definition of [list, add, plain, plainMutation]) expect(Object.isFrozen(definition)).toBe(true)
  expect([list.kind, add.kind]).toEqual(["read", "mutate"])
})
