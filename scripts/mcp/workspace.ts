// The repository as bun mcp sees it: its root, every MCP's declaration (mcps/<name>/mcp.json) and manifest, and the MCP a command is about.
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { dirname, join, relative, sep } from "node:path"
import { z } from "zod"
import { Refusal } from "./io"

/** `mcp.json`: an MCP's declaration, which `mcp.schema.json` publishes for editors and a test keeps equal to this. */
export const declaration = z.strictObject({
  $schema: z.string().optional(),
  name: z.string().describe("The MCP's name: its provider id and the name of its directory, schema and roles"),
  serve: z.enum(["toolbox", "standalone", "both"]).describe("Where it runs: in the Toolbox, on its own URL, or both"),
  database: z.enum(["shared", "own"]).describe("Where its tables live: a schema in the shared database answerable_mcps, or a database of its own"),
}).meta({ title: "An MCP's declaration, mcps/<name>/mcp.json", description: "Written by bun mcp new; serve and database may be changed by hand" })

export type Declaration = z.output<typeof declaration>

/** What `bun mcp` reads of a manifest: the provider's description and its tools, with their kind and scopes. */
const manifestShape = z.object({
  description: z.string(),
  tools: z.array(z.object({ name: z.string(), identity: z.string(), kind: z.string(), scopes: z.array(z.string()) })),
  prompts: z.array(z.object({ scopes: z.array(z.string()) })),
  resources: z.array(z.object({ scopes: z.array(z.string()) })),
})
export type Manifest = z.output<typeof manifestShape>

/** A JSON file parsed by `schema`, or refused naming the file and what is wrong (`invalid-file`). */
async function readJson<Schema extends z.ZodType>(root: string, path: string, schema: Schema): Promise<z.output<Schema>> {
  const parsed = schema.safeParse(await Bun.file(join(root, path)).json().catch(() => undefined))
  if (parsed.success) return parsed.data
  throw new Refusal("invalid-file", `${path} is not valid: ${z.prettifyError(parsed.error).replace(/\s+/g, " ")}`, `git diff ${path}`)
}

/** The repository's root: the nearest directory at or above `cwd` whose package.json has the `mcps/*` workspaces. */
export function findRoot(cwd: string): string {
  for (let dir = cwd; ; dir = dirname(dir)) {
    const pkg = join(dir, "package.json")
    if (existsSync(pkg) && (JSON.parse(readFileSync(pkg, "utf8")) as { workspaces?: string[] }).workspaces?.includes("mcps/*")) return dir
    if (dir === dirname(dir)) throw new Refusal("not-in-repository", `bun mcp runs in the Answerable monorepo; no package.json with the mcps/* workspaces is at or above ${cwd}`, "cd <the repository>")
  }
}

/** Every MCP with a declaration, sorted by name: the directories of `mcps/` with an `mcp.json`, each checked against its directory's name. */
export async function declarations(root: string): Promise<Declaration[]> {
  const names = readdirSync(join(root, "mcps")).filter(name => existsSync(join(root, "mcps", name, "mcp.json"))).sort()
  return Promise.all(names.map(async name => {
    const path = `mcps/${name}/mcp.json`
    const read = await readJson(root, path, declaration)
    if (read.name !== name) throw new Refusal("invalid-file", `${path} names "${read.name}"; the name is the directory's, ${name}`, `git diff ${path}`)
    return read
  }))
}

/** An MCP's manifest, or `undefined` before its first test run writes it. */
export async function manifestOf(root: string, name: string): Promise<Manifest | undefined> {
  const path = `mcps/${name}/manifest.json`
  return existsSync(join(root, path)) ? readJson(root, path, manifestShape) : undefined
}

/** The names `mcps/retired.json` lists: MCPs that were removed, whose names are never used again. */
export const retired = (root: string) => readJson(root, "mcps/retired.json", z.array(z.string()))

/**
 * The MCP a command is about: `given`, which must be declared, else the one whose directory `cwd` is in. `usage` is the command to show when
 * neither names one.
 */
export async function resolveMcp(root: string, cwd: string, given: string | undefined, usage: string): Promise<Declaration> {
  const [top, inside] = relative(root, cwd).split(sep)
  const name = given ?? (top === "mcps" ? inside : undefined)
  if (!name) throw new Refusal("mcp-required", "Name the MCP, or run the command from inside mcps/<name>", usage)
  const found = (await declarations(root)).find(mcp => mcp.name === name)
  if (!found) throw new Refusal("mcp-not-found", `No MCP is named ${name}: mcps/${name}/mcp.json does not exist; bun mcp list names every MCP`, "bun mcp list")
  return found
}
