// bun mcp help [command]: every command in a line, or one command's usage, flags and example, from the commands' own definitions.
import { Refusal, type Command, type Flag } from "../io"

const intro = "bun mcp makes and checks the MCPs of this repository. In a terminal it asks for what is missing; without one, as in a coding agent's shell, it never waits: a missing answer exits with code 2 and prints the command to run, with placeholders. Exit codes: 0 done, 1 a step failed after files were written, 2 refused before anything was written."

/** The text `bun mcp help` prints: the introduction and every command, or with `name`, that command's usage, flags and example. */
export function helpText(commands: readonly Command[], name?: string) {
  if (!name) {
    const width = Math.max(...commands.map(command => command.name.length))
    return `${intro}\n\nCommands:\n${commands.map(command => `  ${command.name.padEnd(width)}  ${command.summary}\n`).join("")}\nbun mcp help <command> shows a command's flags and an example; every command takes --help.\n`
  }
  const command = commands.find(candidate => candidate.name === name)
  if (!command) throw new Refusal("unknown-command", `bun mcp has no command ${name}; its commands are ${commands.map(candidate => candidate.name).join(", ")}`, "bun mcp help")
  const flags = Object.entries<Flag>({ ...command.flags, help: { description: "This text" } }).map(([flag, { value, description }]) => [`--${flag}${value ? ` ${value}` : ""}`, description])
  const width = Math.max(...flags.map(([flag]) => flag!.length))
  return `${command.usage}\n\n${command.summary}.\n\nFlags:\n${flags.map(([flag, description]) => `  ${flag!.padEnd(width)}  ${description}\n`).join("")}\nExample:\n  ${command.example}\n`
}

/** The help command, over `commands` and itself. */
export function help(commands: readonly Command[]): Command {
  const self: Command = {
    name: "help",
    usage: "bun mcp help [command]",
    summary: "Every command, or one command's usage, flags and example",
    flags: {},
    example: "bun mcp help add tool",
    async run(io, { positionals }) {
      io.stdout.write(helpText([...commands, self], positionals.length ? positionals.join(" ") : undefined))
      return 0
    },
  }
  return self
}
