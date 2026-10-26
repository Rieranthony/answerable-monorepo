// bun mcp <command>: the root script and every MCP's "mcp" script. It parses the arguments, refuses what it does not know, and dispatches
// to one of commands/*.ts; tests call main with their own streams, prompts and exec.
import * as clack from "@clack/prompts"
import { addTool } from "./commands/add-tool"
import { check } from "./commands/check"
import { db } from "./commands/db"
import { dev } from "./commands/dev"
import { help, helpText } from "./commands/help"
import { list } from "./commands/list"
import { newMcp } from "./commands/new"
import { setup } from "./commands/setup"
import type { Flag } from "./definitions"
import { printError, Refusal, spawn, type Args, type Command, type Io } from "./io"
import { interrupt, listening, processStarter } from "./machine"

const made = [newMcp, addTool, list, check, db, setup, dev]

/** Every command of bun mcp, as data: `bun mcp help` prints them, and the docs read them. */
export const commands: readonly Command[] = [...made, help(made)]

/** The flags and positional arguments of `argv` for `command`: an unknown flag, a flag given twice or a value missing is refused. */
export function parse(command: Command, argv: readonly string[]): Args {
  const known: Record<string, Flag> = { ...command.flags, help: { description: "This text" } }
  const args: Args = { positionals: [], flags: {} }
  for (let index = 0; index < argv.length; index += 1) {
    const word = argv[index]!
    if (!word.startsWith("-")) {
      args.positionals.push(word)
      continue
    }
    const [flag, inline] = word.slice(2).split(/=(.*)/s) as [string, string | undefined]
    const definition = word.startsWith("--") ? known[flag] : undefined
    if (!definition) {
      const names = Object.keys(known).map(name => `--${name}`).join(", ")
      throw new Refusal("unknown-flag", `bun mcp ${command.name} has no flag ${word.split("=")[0]}; its flags are ${names}`, command.usage)
    }
    if (flag in args.flags) throw new Refusal("repeated-flag", `--${flag} is given twice; give it once`, command.usage)
    if (!definition.value) {
      if (inline !== undefined) throw new Refusal("flag-value", `--${flag} takes no value`, command.usage)
      args.flags[flag] = true
      continue
    }
    const value = inline ?? argv[(index += 1)]
    if (value === undefined || (inline === undefined && value.startsWith("--"))) throw new Refusal("flag-value", `--${flag} takes a value, ${definition.value}`, command.usage)
    args.flags[flag] = value
  }
  return args
}

/** Run bun mcp with `io.argv`: 0 when done, 1 when a step failed after files were written, 2 when refused before anything was written. */
export async function main(io: Io): Promise<number> {
  const json = io.argv.includes("--json")
  try {
    const [first, second] = io.argv
    if (first === undefined || first === "--help") return (io.stdout.write(helpText(commands)), 0)
    const named = first === "add" && second === "tool" ? "add tool" : first
    const command = commands.find(candidate => candidate.name === named)
    if (!command) {
      const known = commands.map(candidate => candidate.name).join(", ")
      throw new Refusal("unknown-command", `bun mcp has no command ${first === "add" ? `add ${second ?? ""}`.trim() : first}; its commands are ${known}`, "bun mcp help")
    }
    const args = parse(command, io.argv.slice(named.split(" ").length))
    if (args.flags.help) return (io.stdout.write(helpText(commands, command.name)), 0)
    return await command.run(io, args)
  } catch (error) {
    if (error instanceof Refusal) return (printError(io, json, error), 2)
    printError(io, json, { code: "failed", message: `bun mcp failed: ${(error as Error).message}`, fix: "bun mcp help" })
    return 1
  }
}

if (import.meta.main) process.exitCode = await main({ argv: process.argv.slice(2), cwd: process.cwd(), stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY), prompts: clack, exec: spawn, fetch, listening, start: processStarter(1000), interrupt })
