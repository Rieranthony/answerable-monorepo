// The e2e MCP: the reference MCP, served in the Toolbox and on its own URL, with its records in Postgres. bun mcp add tool adds a tool
// above each "bun mcp: tools" line.
import { defineProvider } from "@answerable/mcp"
import { fixtureGuide, fixtureWalkthrough } from "./guide"
import { database } from "./mcp"
import { identityGet } from "./tools/identity-get"
import { recordsCreate } from "./tools/records-create"
import { recordsDelete } from "./tools/records-delete"
import { recordsList } from "./tools/records-list"
import { recordsShow } from "./tools/records-show"
// bun mcp: tools

export const provider = defineProvider({
  id: "e2e",
  description: "The reference MCP: your organisation's test records, to list, show in an interactive view, create and delete, with a prompt and a guide.",
  version: "2026-09-29",
  database,
  tools: [
    identityGet,
    recordsList,
    recordsShow,
    recordsCreate,
    recordsDelete,
    // bun mcp: tools
  ],
  prompts: [fixtureWalkthrough],
  resources: [fixtureGuide],
})
