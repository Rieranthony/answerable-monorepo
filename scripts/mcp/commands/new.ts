// bun mcp new [name]: make an MCP. Every answer is checked before the first file is written; then the files, the generated list, the install,
// the local schema, the first migration, the manifest, the generated list again and the check, one line each.
import { mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { ask, askTool, askToolDescription, choose } from "../ask"
import { definitions } from "../definitions"
import { generate } from "../generate"
import { cli, finishing, Refusal, refusal, runSteps, say, sh, shellWord, valueOf, type Command, type Io, type Problem } from "../io"
import { choices, choiceProblem, descriptionProblem, nameProblem, toolDescriptionProblem, toolNameProblem } from "../rules"
import { mcpFiles, type DatabaseMode, type Serve, type ToolAnswers } from "../templates"
import { findRoot, retired } from "../workspace"
import { checkStep } from "./check"

type Given = { name?: string; description?: string; serve?: string; database?: string; tool?: string; toolDescription?: string; mutation: boolean }
type Field = keyof Omit<Given, "mutation">

// The command that makes the MCP with these answers, each missing or refused one a placeholder: what a refusal tells the caller to run.
function commandFor({ name, description, serve, database, tool, toolDescription, mutation }: Given, { noCheck, json }: { noCheck: boolean; json: boolean }) {
  const words = ["bun", "mcp", "new", name ?? "<name>", "--description", description ?? "\"<what the MCP is for, 40 to 1,000 characters>\"", "--serve", serve ?? `<${choices.serve.join("|")}>`]
  if (database && database !== "shared") words.push("--database", database)
  if (tool) words.push("--tool", tool, "--tool-description", toolDescription ?? "\"<what the tool does, when to use it, its limits>\"")
  if (tool && mutation) words.push("--mutation")
  if (noCheck) words.push("--no-check")
  if (json) words.push("--json")
  return words.map(shellWord).join(" ")
}


export const newMcp: Command = {
  ...definitions.new,
  async run(io, { positionals, flags }) {
    const options = { noCheck: flags["no-check"] === true, json: flags.json === true }
    const interactive = io.isTTY && !options.json
    if (positionals.length > 1) throw new Refusal("unexpected-argument", `bun mcp new takes one name; it was given ${positionals.join(", ")}`, commandFor({ name: positionals[0], mutation: false }, options))
    const given: Given = {
      name: positionals[0], description: valueOf(flags.description), serve: valueOf(flags.serve), database: valueOf(flags.database),
      tool: valueOf(flags.tool), toolDescription: valueOf(flags["tool-description"]), mutation: flags.mutation === true,
    }
    const root = findRoot(io.cwd)
    const retiredNames = await retired(root)
    // Every answer given is checked, and without a terminal every answer missing is listed, before anything is asked: one refusal names
    // them all in the order of the questions, and its command keeps the valid answers, with a placeholder in place of each of the others.
    const found: (Problem & { field: Field })[] = []
    const checked = (field: Field, problem: (value: string) => Problem | undefined, missing?: string) => {
      const value = given[field]
      const wrong = value === undefined ? (missing && !interactive ? { code: "missing-argument", message: missing } : undefined) : problem(value)
      if (wrong) found.push({ field, ...wrong })
      return wrong ? undefined : value
    }
    const name = checked("name", value => nameProblem(value, root, retiredNames), "Missing the name: a lowercase letter, then up to 11 lowercase letters or digits, such as acme")
    const description = checked("description", descriptionProblem, "Missing --description: what the MCP is for, 40 to 1,000 characters")
    const serve = checked("serve", value => choiceProblem("serve", value), "Missing --serve: where it runs, toolbox, standalone or both")
    const database = checked("database", value => choiceProblem("database", value)) ?? "shared"
    if (!given.tool && (given.toolDescription !== undefined || given.mutation)) {
      found.push({ field: "tool", code: "flag-needs-tool", message: "--tool-description and --mutation describe the first tool: pass --tool <domain.operation> with them" })
    }
    // Whether the tool's name is a commit tool's needs a valid MCP name: without one, only the tool name's own rule is checked.
    const toolName = checked("tool", value => toolNameProblem(name, value, root, []))
    const toolDescription = given.tool === undefined ? undefined : checked("toolDescription", value => toolDescriptionProblem(name ?? "<name>", given.tool!, value, given.mutation),
      `Missing --tool-description: what ${given.tool} does, when to use it and its limits, 40 to 1,000 characters`)
    if (found.length) {
      const placeholders = Object.fromEntries(found.map(({ field }) => [field, ({ tool: "<domain.operation>", database: "<shared|own>" } as Partial<Given>)[field]]))
      const missing = found.some(problem => problem.code === "missing-argument")
      throw refusal(found, commandFor({ ...given, ...placeholders }, options), missing ? "Without a terminal, bun mcp new asks nothing: run it again with every answer." : undefined)
    }

    // In a terminal, what is missing is asked, in the order of the questions.
    const command = commandFor(given, options)
    const mcp = name ?? (await ask(io, command,
      "Name: a lowercase letter, then up to 11 lowercase letters or digits. It prefixes every tool (acme_notes_list in the Toolbox) and names the database schema.",
      value => nameProblem(value, root, retiredNames), { placeholder: "acme" }))!
    const collision = toolName && toolNameProblem(mcp, toolName, root, [])
    if (collision) throw refusal([collision], commandFor({ ...given, name: mcp, tool: "<domain.operation>" }, options))
    const what = description ?? (await ask(io, command,
      "What is the MCP for, in a sentence or two? 40 to 1,000 characters, for example: Notes for construction projects: list, read and add notes on a project.",
      descriptionProblem))!
    const where = serve ?? (await choose(io, command, "Where does it run?", [
      { value: "toolbox", label: "In the Toolbox", hint: "recommended: clients reach it through the one Toolbox URL" },
      { value: "standalone", label: "On its own", hint: `its own URL, https://mcp.<zone>/${mcp}/mcp` },
      { value: "both", label: "Both", hint: "in the Toolbox and on its own URL" },
    ]))
    // Without --tool, a terminal asks for the first tool, which Enter skips; without either, the first tool is <name>.status.
    const tool: ToolAnswers | undefined = toolName
      ? { name: toolName, description: toolDescription ?? (await askToolDescription(io, command, mcp, toolName, given.mutation)), mutation: given.mutation }
      : interactive ? await askTool(io, command, { mcp, root, identities: [], optional: true }) : undefined
    const answers = { name: mcp, description: what, serve: where as Serve, database: database as DatabaseMode, date: new Date().toISOString().slice(0, 10), tool }
    return make(io, root, answers, options)
  },
}

// Write the MCP's files, then run the steps that make it work, one line each.
async function make(io: Io, root: string, answers: Parameters<typeof mcpFiles>[0], options: { noCheck: boolean; json: boolean }) {
  const { name, serve, database, tool } = answers
  const dir = join(root, "mcps", name)
  const files = mcpFiles(answers)
  const where = { toolbox: "in the Toolbox", standalone: "on its own URL", both: "in the Toolbox and on its own URL" }[serve]
  say(io, options.json, `Making ${name} in mcps/${name}: it runs ${where}; its first tool is ${tool?.name ?? `${name}.status`}.`)
  say(io, options.json, database === "shared"
    ? `Database: schema ${name} in answerable_mcps (shared). Pass --database own for a database of its own.`
    : `Database: schema ${name} in answerable_mcp_${name}, a database of its own (own).`)
  // Every generated file a step rewrote, for the commit the last line suggests.
  const rewritten = new Set<string>()
  const listed = async () => {
    const stale = await generate(root, { write: true })
    for (const path of stale) rewritten.add(path)
    return stale.length ? `rewrote ${stale.join(", ")}` : "charts/answerable/mcps.json current"
  }
  // Making the MCP again does every step, so a failed write is finished by removing what it wrote and running the command again.
  const again = `rm -rf mcps/${name} && ${commandFor({ ...answers, toolDescription: tool?.description, tool: tool?.name, mutation: tool?.mutation ?? false }, options)}`
  const steps = finishing([
    {
      name: "write", redo: again,
      run: async () => {
        for (const [path, content] of Object.entries(files)) {
          await mkdir(dirname(join(dir, path)), { recursive: true })
          await Bun.write(join(dir, path), content)
        }
        return `mcps/${name}: ${Object.keys(files).length} files`
      },
    },
    { name: "generate", redo: `bun mcp check ${name}`, run: listed },
    { name: "install", redo: "bun install", run: async () => (await sh(io, [process.execPath, "install"], root), "bun install") },
    {
      name: "database", redo: `bun mcp db ${name} migrate`,
      run: async () => {
        await sh(io, [process.execPath, cli, "db", name, "migrate"], root)
        return database === "shared" ? `schema ${name} in answerable_mcps, provisioned` : `schema ${name} in answerable_mcp_${name}, provisioned`
      },
    },
    {
      name: "migration", redo: `bun mcp db ${name} generate --name initial`,
      run: async () => (await sh(io, [process.execPath, cli, "db", name, "generate", "--name", "initial"], root), `mcps/${name}/drizzle/0000_initial.sql`),
    },
    {
      name: "manifest", redo: `bun mcp check ${name}`,
      run: async () => `mcps/${name}/manifest.json: ${(await sh(io, [process.execPath, "test"], dir, { UPDATE_MANIFEST: "1" })).match(/(\d+) pass/)?.[1]} tests pass`,
    },
    { name: "generate", redo: `bun mcp check ${name}`, run: listed },
    ...(options.noCheck ? [] : [{ ...checkStep(io, root, name), redo: `bun mcp check ${name}` }]),
  ])
  steps[0]!.fix = again
  return runSteps(io, options.json, steps, () => [
    `bun mcp add tool ${name} <domain.operation> --description "<what it does, when to use it, its limits>"`,
    ...(options.noCheck ? [`bun mcp check ${name}`] : []),
    `git add mcps/${name} ${[...rewritten].join(" ") || "charts/answerable/mcps.json"} bun.lock`,
  ])
}
