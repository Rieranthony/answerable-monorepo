// What every command of bun mcp receives, how it refuses, and how it prints: one line per step, then Next.
import type { Readable, Writable } from "node:stream"
import type * as clack from "@clack/prompts"
import type { Definition, ErrorCode } from "./definitions"
import type { Declaration } from "./workspace"

/** The prompts a command asks in a terminal: @clack/prompts' own, so a test passes stand-ins. A cancelled prompt answers a symbol. */
export type Prompts = Pick<typeof clack, "text" | "select" | "password">

/** Run a command to its end: its exit code and its output, stdout then stderr. */
export type Exec = (command: string[], options: { cwd: string; env?: Record<string, string> }) => Promise<{ code: number; output: string }>

/** The HTTP client a command calls with: the global `fetch`, or a fake of the service it calls. */
export type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

/** A server a command started: it ends with an exit code, or when `stop()` has stopped it. */
export type Running = { exited: Promise<number>; stop(): Promise<void> }

/** Start a long-running command, whose output goes to the terminal, with exactly `env` as its environment. */
export type Start = (command: string[], options: { cwd: string; env: Record<string, string> }) => Running

/** Provision and migrate the local schemas of `mcps` on the development Postgres, in this process: a line of what it did for each. */
export type Migrate = (root: string, mcps: readonly Declaration[]) => Promise<string[]>

/**
 * What a command runs with: its arguments, where it runs, its streams, whether a person is at a terminal, how it asks and runs commands, and the
 * machine around it: HTTP, whether something listens on a port, the development Postgres, how to start a server and when the person stops it
 * (Ctrl-C or SIGTERM).
 */
export type Io = {
  argv: string[]
  cwd: string
  stdin: Readable
  stdout: Writable
  stderr: Writable
  isTTY: boolean
  prompts: Prompts
  exec: Exec
  fetch: Fetch
  /** Whether something accepts connections at `host:port`. */
  listening(host: string, port: number): Promise<boolean>
  migrate: Migrate
  start: Start
  /** Start listening for Ctrl-C and SIGTERM; the signal aborts when one arrives. A command that runs until it is stopped calls it first. */
  interrupt(): AbortSignal
}

/** What is wrong with one answer: its code, one per rule (errors.ts gives each a row), and the message that says what to do. */
export type Problem = { code: ErrorCode; message: string }

/**
 * A refusal before anything is written: exit code 2. `code` is the first problem's, and `message` every problem's, a line each, in the order the
 * questions come. `fix` is the one command to run next, with a placeholder in place of every answer missing or refused.
 */
export class Refusal extends Error {
  constructor(readonly code: ErrorCode, message: string, readonly fix: string) {
    super(message)
  }
}

/** One refusal for every problem in `problems`, with `fix`; `note` is a last line of the message, said once for them all. */
export const refusal = (problems: readonly Problem[], fix: string, note?: string) =>
  new Refusal(problems[0]!.code, [...problems.map(problem => problem.message), ...(note ? [note] : [])].join("\n"), fix)

/** The command spawned to its end, with the environment it runs in plus `env`. */
export const spawn: Exec = async (command, { cwd, env }) => {
  const child = Bun.spawn(command, { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" })
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  return { code, output: `${stdout}${stderr}` }
}

/** The last `count` non-empty lines of a command's output: the why of a failed step. */
export const tail = (output: string, count = 20) => output.trim().split("\n").slice(-count).join("\n")

/** Run `command` in `cwd` and return its output, or throw the end of it: a step's work. */
export async function sh(io: Io, command: string[], cwd: string, env?: Record<string, string>) {
  const { code, output } = await io.exec(command, { cwd, env })
  if (code) throw new Error(tail(output))
  return output
}

/** The CLI itself, which a step runs as a process of its own to write a migration. */
export const cli = Bun.fileURLToPath(new URL("cli.ts", import.meta.url))

/** A value as one shell word: as it is when it is plain, else in single quotes. A placeholder, `<…>` or `"<…>"`, stays as it is, to be replaced. */
export const shellWord = (value: string) => (/^([\w.,:/@=+-]+|<[^>]*>|"<[^>]*>")$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`)

const write = (stream: Writable, text: string) => void stream.write(text)

/** Print a refusal, or a failure's message, then its fix, on stderr: the fix under `label`, when given. */
export function printError(io: Io, { message, fix }: { message: string; fix: string }, label = "") {
  write(io.stderr, `${message}\n\n${label && `${label}\n`}  ${fix}\n`)
}

/** One step of a command: its name, what it does (the detail it prints) and the command that finishes the job when it fails. */
export type Step = { name: string; fix: string; run: () => Promise<string> }

const duration = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`)

/**
 * Run `steps` in order, printing a line for each: `ok   <name>  <detail> (<time>)`. The first that throws stops the run: it prints `failed`, the
 * reason, `<name> failed: …` (errors.ts's code `<name>-failed`), and the command that finishes the job, and returns 1. Otherwise it prints
 * `next()`, the commands that come next once the steps have run, and returns 0.
 */
export async function runSteps(io: Io, steps: Step[], next: () => string[]): Promise<number> {
  for (const step of steps) {
    const started = performance.now()
    const took = () => duration(Math.round(performance.now() - started))
    try {
      const detail = await step.run()
      write(io.stdout, `ok      ${step.name.padEnd(10)} ${detail} (${took()})\n`)
    } catch (error) {
      write(io.stdout, `failed  ${step.name.padEnd(10)} (${took()})\n`)
      printError(io, { message: `${step.name} failed: ${error instanceof Error ? error.message : String(error)}`, fix: step.fix }, "Finish the job with:")
      return 1
    }
  }
  const then = next()
  if (then.length) write(io.stdout, `\nNext:\n${then.map(line => `  ${line}\n`).join("")}`)
  return 0
}

/** Steps with the command that finishes the job from each: the commands to run again (`redo`) from that step on, each once, in order. */
export function finishing(steps: (Omit<Step, "fix"> & { redo: string })[]): Step[] {
  return steps.map(({ name, run }, index) => ({ name, run, fix: [...new Set(steps.slice(index).map(later => later.redo).reverse())].reverse().join(" && ") }))
}

/** Print `text` on stdout, a line. */
export const say = (io: Io, text: string) => write(io.stdout, `${text}\n`)

/** What a command was given: its positional arguments, and its flags, each a value or `true`. */
export type Args = { positionals: string[]; flags: Record<string, string | true> }

/** A flag's value, or `undefined` when it was left out. */
export const valueOf = (flag: string | true | undefined) => (typeof flag === "string" ? flag : undefined)

/** A command of bun mcp: its definition (definitions.ts), which `bun mcp help` and the docs read, and what runs it. */
export type Command = Definition & { run(io: Io, args: Args): Promise<number> }
