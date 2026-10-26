// bun mcp add tool [mcp] <domain.operation>: a tool's file and test, its import and entry in src/provider.ts, its domain's table when missing,
// the migration, the manifest, the generated list and the check. Every check runs before the first file is written.
import { existsSync } from "node:fs"
import { join } from "node:path"
import { askTool, askToolDescription } from "../ask"
import { definitions } from "../definitions"
import { generate } from "../generate"
import { cli, finishing, Refusal, refusal, runSteps, sh, shellWord, valueOf, type Command, type Problem } from "../io"
import { listed, toolDescriptionProblem, toolNameProblem } from "../rules"
import { isolationImport, tableTs, toolBinding, toolFiles, toolModule, toolsMarker, type ToolAnswers } from "../templates"
import { findRoot, manifestOf, resolveMcp } from "../workspace"
import { checkStep } from "./check"

// The command that adds this tool, a placeholder for each answer missing or refused.
function commandFor(mcp: string | undefined, tool: string | undefined, description: string | undefined, { mutation, noCheck, json }: { mutation: boolean; noCheck: boolean; json: boolean }) {
  const words = ["bun", "mcp", "add", "tool", mcp ?? "<mcp>", tool ?? "<domain.operation>", "--description", description ?? "\"<what it does, when to use it, its limits>\""]
  for (const [flag, on] of [["--mutation", mutation], ["--no-check", noCheck], ["--json", json]] as const) if (on) words.push(flag)
  return words.map(shellWord).join(" ")
}

// Refuse an MCP whose files bun mcp new did not lay out, which add tool cannot edit.
async function assertMadeByNew(root: string, name: string) {
  const dir = join(root, "mcps", name)
  const provider = join(dir, "src/provider.ts")
  const markers = existsSync(provider) ? (await Bun.file(provider).text()).split("\n").filter(line => line.trim() === toolsMarker).length : 0
  const layout = ["src/mcp.ts", "src/db/schema.ts"].filter(path => !existsSync(join(dir, path)))
  if (layout.length || markers !== 2) {
    const lacks = [...layout, ...(markers === 2 ? [] : [`the two "${toolsMarker}" lines of src/provider.ts, among its imports and in its tools array`])]
    throw new Refusal("not-made-by-new", `mcps/${name} lacks ${listed(lacks, "and")}, which bun mcp new writes and add tool edits; add the tool by hand`, "bun mcp help add tool")
  }
}

const isolationImported = /^import \{[^}]*\borganisationIsolation\b[^}]*\} from "@answerable\/mcp-postgres"$/m

export const addTool: Command = {
  ...definitions["add tool"],
  async run(io, { positionals, flags }) {
    const options = { mutation: flags.mutation === true, noCheck: flags["no-check"] === true, json: flags.json === true }
    const given = { description: valueOf(flags.description) }
    const [tools, others] = [positionals.filter(word => word.includes(".")), positionals.filter(word => !word.includes("."))]
    if (tools.length > 1 || others.length > 1) {
      throw new Refusal("unexpected-argument", `bun mcp add tool takes an MCP and one tool, <domain.operation>; it was given ${positionals.join(", ")}`, commandFor(others[0], tools[0], given.description, options))
    }
    const root = findRoot(io.cwd)
    // Every answer is checked before anything is refused: the MCP, the tool's name and its description, and without a terminal each one
    // missing. Whether the tool is new to the MCP or a commit tool's name needs the MCP, so without one only the tool name's rule is checked.
    const found: (Problem & { field: "mcp" | "tool" | "description" })[] = []
    const mcp = await resolveMcp(root, io.cwd, others[0], "").catch((error: Error) => {
      if (!(error instanceof Refusal)) throw error
      found.push({ field: "mcp", code: error.code, message: error.message })
    })
    if (mcp) await assertMadeByNew(root, mcp.name)
    const identities = mcp ? (await manifestOf(root, mcp.name))?.tools.map(tool => tool.identity) ?? [] : []
    const interactive = io.isTTY && !options.json
    const [named, described] = [tools[0], given.description]
    const report = (field: "tool" | "description", problem: Problem | undefined) => problem && found.push({ field, ...problem })
    if (named !== undefined) report("tool", toolNameProblem(mcp?.name, named, root, identities))
    else if (!interactive) report("tool", { code: "missing-argument", message: "Missing the tool: <domain.operation>, such as notes.list" })
    if (described !== undefined) report("description", toolDescriptionProblem(mcp?.name ?? "<mcp>", named ?? "<domain.operation>", described, options.mutation))
    else if (!interactive) report("description", { code: "missing-argument", message: "Missing --description: what the tool does, when to use it and its limits, 40 to 1,000 characters" })
    if (found.length) {
      const refused = new Set(found.map(problem => problem.field))
      const fix = commandFor(refused.has("mcp") ? undefined : mcp!.name, refused.has("tool") ? undefined : named, refused.has("description") ? undefined : described, options)
      const missing = found.some(problem => problem.code === "missing-argument")
      throw refusal(found, fix, missing ? "Without a terminal, bun mcp add tool asks nothing: run it again with every answer." : undefined)
    }

    // In a terminal, what is missing is asked: the tool, its description, then read or change unless --mutation says.
    const { name } = mcp!
    const command = commandFor(name, named, described, options)
    const tool: ToolAnswers = named
      ? { name: named, description: described ?? (await askToolDescription(io, command, name, named, options.mutation)), mutation: options.mutation }
      : (await askTool(io, command, { mcp: name, root, identities, optional: false, ...given, ...(options.mutation ? { mutation: true as const } : {}) }))!
    return add(io, root, name, tool, options)
  },
}

// Write the tool, its test, its provider entry and its table, then the migration, the manifest, the generated list and the check.
async function add(io: Parameters<Command["run"]>[0], root: string, name: string, tool: ToolAnswers, options: { noCheck: boolean; json: boolean }) {
  const dir = join(root, "mcps", name)
  const domain = tool.name.split(".")[0]!
  const steps = finishing([
    {
      name: "write", redo: `bun mcp check ${name}`,
      run: async () => {
        const files = toolFiles(name, tool)
        for (const [path, content] of Object.entries(files)) await Bun.write(join(dir, path), content)
        const provider = Bun.file(join(dir, "src/provider.ts"))
        const lines = (await provider.text()).split("\n")
        const [imports, entries] = lines.flatMap((line, index) => (line.trim() === toolsMarker ? [index] : []))
        lines.splice(entries!, 0, `    ${toolBinding(tool.name)},`)
        lines.splice(imports!, 0, `import { ${toolBinding(tool.name)} } from "./tools/${toolModule(tool.name)}"`)
        await Bun.write(provider, lines.join("\n"))
        const schema = Bun.file(join(dir, "src/db/schema.ts"))
        const tables = await schema.text()
        const missing = !tables.includes(`.table("${domain}"`)
        if (missing) await Bun.write(schema, `${isolationImported.test(tables) ? "" : isolationImport}${tables}${tableTs(name, domain)}`)
        return `${Object.keys(files).join(", ")}, src/provider.ts${missing ? `, the ${domain} table in src/db/schema.ts` : ""}`
      },
    },
    {
      name: "migration", redo: `bun mcp db ${name} generate --name ${domain}`,
      run: async () => {
        const output = await sh(io, [process.execPath, cli, "db", name, "generate", "--name", domain], root)
        return output.match(/drizzle\/\S+\.sql/)?.[0] ?? "no change to src/db/schema.ts"
      },
    },
    {
      name: "manifest", redo: `bun mcp check ${name}`,
      run: async () => `mcps/${name}/manifest.json: ${(await sh(io, [process.execPath, "test"], dir, { UPDATE_MANIFEST: "1" })).match(/(\d+) pass/)?.[1]} tests pass`,
    },
    {
      name: "generate", redo: `bun mcp check ${name}`,
      run: async () => {
        const stale = await generate(root, { write: true })
        return stale.length ? `rewrote ${stale.join(", ")}` : "charts/answerable/mcps.json current"
      },
    },
    ...(options.noCheck ? [] : [{ ...checkStep(io, root, name), redo: `bun mcp check ${name}` }]),
  ])
  return runSteps(io, options.json, steps, () => [
    ...(options.noCheck ? [`bun mcp check ${name}`] : []),
    `git add mcps/${name} charts/answerable/mcps.json`,
  ])
}
