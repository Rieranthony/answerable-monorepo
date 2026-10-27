// bun mcp <command>: the root script and every MCP's "mcp" script. It parses the arguments, refuses what it does not know, and dispatches
// to one of commands/*.ts; tests call main with their own streams, prompts and exec.
import { parseArgs } from "node:util"
import * as clack from "@clack/prompts"
import { addTool } from "./commands/add-tool"
import { check } from "./commands/check"
import { db } from "./commands/db"
import { dev } from "./commands/dev"
import { help, helpText, unknownCommand } from "./commands/help"
import { list } from "./commands/list"
import { newMcp } from "./commands/new"
import { setup } from "./commands/setup"
import { helpFlag, type Flag } from "./definitions"
import { migrateLocal } from "./database"
import { printError, Refusal, spawn, type Args, type Command, type Io } from "./io"
import { interrupt, listening, processStarter } from "./machine"

const made = [newMcp, addTool, list, check, db, setup, dev]

/** Every command of bun mcp: its definition with what runs it. `bun mcp help` prints them. */
export const commands: readonly Command[] = [...made, help(made)]

/** The flags and positional arguments of `argv` for `command`, by `node:util`'s `parseArgs`: a flag given twice takes its last value; an unknown flag, or a value missing or given to a flag that takes none, is refused. */
export function parse(command: Command, argv: readonly string[]): Args {
  const known: Record<string, Flag> = { ...command.flags, ...helpFlag }
  const options = Object.fromEntries(Object.entries(known).map(([name, flag]) => [name, { type: flag.value ? "string" : "boolean" } as const]))
  try {
    const { values, positionals } = parseArgs({ args: [...argv], options, allowPositionals: true, strict: true })
    return { positionals, flags: values as Args["flags"] }
  } catch (error) {
    // parseArgs names the flag in quotes: Unknown option '--force', Option '--serve <value>' argument missing, Option '--mutation' does not take an argument.
    const { code, message } = error as { code?: string; message: string }
    const flag = /'(-[^' ]*)/.exec(message)?.[1] ?? ""
    if (code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
      throw new Refusal("unknown-flag", `bun mcp ${command.name} has no flag ${flag}; its flags are ${Object.keys(known).map(name => `--${name}`).join(", ")}`, command.usage)
    }
    const value = known[flag.slice(2)]?.value
    if (code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE") throw new Refusal("flag-value", value ? `${flag} takes a value, ${value}` : `${flag} takes no value`, command.usage)
    throw error
  }
}

/** Run the command `io.argv` names, or print help: its exit code, 0 when done and 1 when a step failed. A refusal, or any other error, is thrown. */
export async function dispatch(io: Io): Promise<number> {
  const [first, second] = io.argv
  if (first === undefined || first === "--help") return (io.stdout.write(helpText(commands)), 0)
  const named = first === "add" && second === "tool" ? "add tool" : first
  const command = commands.find(candidate => candidate.name === named)
  if (!command) throw unknownCommand(first === "add" ? `add ${second ?? ""}`.trim() : first, commands)
  const args = parse(command, io.argv.slice(named.split(" ").length))
  if (args.flags.help) return (io.stdout.write(helpText(commands, command.name)), 0)
  return command.run(io, args)
}

/** Print what `dispatch` threw and answer its exit code: 2 for a refusal, before anything was written, and 1 for any other error. */
export function report(io: Io, error: unknown): number {
  if (error instanceof Refusal) return (printError(io, error), 2)
  printError(io, { message: `bun mcp failed: ${(error as Error).message}`, fix: "bun mcp help" })
  return 1
}

/** Run bun mcp with `io.argv`: 0 when done, 1 when a step failed after files were written, 2 when refused before anything was written. */
export const main = (io: Io): Promise<number> => dispatch(io).catch(error => report(io, error))

if (import.meta.main) process.exitCode = await main({ argv: process.argv.slice(2), cwd: process.cwd(), stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY), prompts: clack, exec: spawn, fetch, listening, migrate: migrateLocal, start: processStarter(1000), interrupt })
