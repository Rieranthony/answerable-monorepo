// The names the templates give an MCP's files and TypeScript bindings, chosen so that every legal MCP and tool name makes code that compiles.

/** Where an MCP runs: in the Toolbox, on its own URL in the standalone server, or both. */
export type Serve = "toolbox" | "standalone" | "both"
/** Where an MCP's tables live: a schema in the shared database, or a database of its own. */
export type DatabaseMode = "shared" | "own"
/** A tool to write: its name, `<domain>.<operation>`, its description, and whether it is a mutation. */
export type ToolAnswers = { name: string; description: string; mutation: boolean }
/** Every answer `bun mcp new` needs. Without `tool`, the first tool is `<name>.status`, which reports who is calling. */
export type Answers = { name: string; description: string; serve: Serve; database: DatabaseMode; date: string; tool?: ToolAnswers }

/** Words a lowercase domain may be that cannot name a binding in a module, and `pg`, the schema file's import of drizzle's column builders. */
export const unusable = new Set([
  "arguments", "await", "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete", "do", "else", "enum", "eval",
  "export", "extends", "false", "finally", "for", "function", "if", "implements", "import", "in", "instanceof", "interface", "let", "new", "null",
  "package", "pg", "private", "protected", "public", "return", "static", "super", "switch", "this", "throw", "true", "try", "typeof", "undefined",
  "var", "void", "while", "with", "yield",
])

/** The bindings the templates import beside a tool's own, which a tool's binding must never be. */
export const importedBindings = ["defineMutation", "defineProvider", "defineTool"]

/** The binding of an MCP's Postgres schema in `src/db/schema.ts`: `acmeSchema`. Never a domain's table binding, which has no capital S. */
export const schemaBinding = (name: string) => `${name}Schema`

/** The binding of a domain's table in `src/db/schema.ts`: the domain, or `<domain>Table` where the domain cannot name a binding. */
export const tableBinding = (domain: string) => (unusable.has(domain) ? `${domain}Table` : domain)

/** A tool's binding, `notesList` for `notes.list`. It has a capital letter, so it is never a table's binding. */
export function toolBinding(tool: string) {
  const [domain, operation] = tool.split(".") as [string, string]
  return `${domain}${operation[0]!.toUpperCase()}${operation.slice(1)}`
}

/** A tool's module in `src/tools`, `notes-list` for `notes.list`. */
export const toolModule = (tool: string) => tool.replace(".", "-")

/** A tool's file, `src/tools/notes-list.ts` for `notes.list`; its test is beside it, `.test.ts`. */
export const toolPath = (tool: string) => `src/tools/${toolModule(tool)}.ts`

/** A tool's name on the wire, served alone: `notes_list`. In the Toolbox it is prefixed with the MCP's name. */
export const wireName = (tool: string) => tool.replace(".", "_")
