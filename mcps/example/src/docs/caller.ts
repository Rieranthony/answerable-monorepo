// A snippet the docs include: typechecked and linted with this server, never served.
import { defineTool } from "@answerable/mcp"
import { z } from "zod"

export const notesWhoami = defineTool({
  name: "notes.whoami",
  description: "Say who you are to the notes server: your name, your organisation and the groups you are in. Changes nothing.",
  input: z.object({}),
  output: z.object({ name: z.string(), organisation: z.string(), groups: z.array(z.string()) }),
  example: {},
  async execute(_input, { person, organisation }) {
    return { name: person.name, organisation: organisation.name, groups: person.groups.map(group => group.slug) }
  },
})
