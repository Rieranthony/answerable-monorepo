// What every command of bun mcp receives, how it refuses, and how it prints: one line per step, then Next, or one JSON object with --json.
import type { Readable, Writable } from "node:stream"
import type * as clack from "@clack/prompts"
import type { Definition } from "./definitions"

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

/**
 * What a command runs with: its arguments, where it runs, its streams, whether a person is at a terminal, how it asks and runs commands, and the
 * machine around it: HTTP, whether something listens on a port, how to start a server and when the person stops it (Ctrl-C or SIGTERM).
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
  start: Start
  /** Start listening for Ctrl-C and SIGTERM; the signal aborts when one arrives. A command that runs until it is stopped calls it first. */
  interrupt(): AbortSignal
}

/** What is wrong with one answer: a stable kebab-case `code`, one per rule, and the message that says what to do. */
export type Problem = { code: string; message: string }

/**
 * A refusal before anything is written: exit code 2. `problems` are every answer refused, in the order the questions come; `code` is the
 * first one's and `message` all of theirs, a line each. `fix` is the one command to run next, with a placeholder in place of every answer
 * missing or refused.
 */
export class Refusal extends Error {
  readonly problems: readonly Problem[]
  constructor(readonly code: string, message: string, readonly fix: string, problems?: readonly Problem[]) {
    super(message)
    this.problems = problems ?? [{ code, message }]
  }
}

/** One refusal for every problem in `problems`, with `fix`; `note` is a last line of the message, said once for them all. */
export const refusal = (problems: readonly Problem[], fix: string, note?: string) =>
  new Refusal(problems[0]!.code, [...problems.map(problem => problem.message), ...(note ? [note] : [])].join("\n"), fix, problems.map(({ code, message }) => ({ code, message })))

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

/** The CLI itself, which a step runs as a process of its own for the database steps. */
export const cli = Bun.fileURLToPath(new URL("cli.ts", import.meta.url))

/** A value as one shell word: as it is when it is plain, else in single quotes. A placeholder, `<…>` or `"<…>"`, stays as it is, to be replaced. */
export const shellWord = (value: string) => (/^([\w.,:/@=+-]+|<[^>]*>|"<[^>]*>")$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`)

const write = (stream: Writable, text: string) => void stream.write(text)

/**
 * Print a refusal, or a failure's message and its fix, as text on stderr (the fix under `label`, when given) or as the JSON error on stdout:
 * `{ ok: false, error: { code, message, fix, problems: [{ code, message }] } }`, with one problem for a failure.
 */
export function printError(io: Io, json: boolean, { code, message, fix, problems }: Problem & { fix: string; problems?: readonly Problem[] }, label = "") {
  if (json) return write(io.stdout, `${JSON.stringify({ ok: false, error: { code, message, fix, problems: problems ?? [{ code, message }] } }, null, 2)}\n`)
  write(io.stderr, `${message}\n\n${label && `${label}\n`}  ${fix}\n`)
}

/** One step of a command: its name, what it does (the detail it prints) and the command that finishes the job when it fails. */
export type Step = { name: string; fix: string; run: () => Promise<string> }

const duration = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`)

/**
 * Run `steps` in order, printing a line for each: `ok   <name>  <detail> (<time>)`. The first that throws stops the run: it prints `failed`, the
 * reason and the command that finishes the job, and returns 1 (code `<name>-failed`). Otherwise it prints `next()`, the commands that come
 * next once the steps have run, and returns 0. With `json`, it prints one object instead: `{ ok, steps: [{ name, ok, ms }], next }`, or
 * `{ ok: false, error }`.
 */
export async function runSteps(io: Io, json: boolean, steps: Step[], next: () => string[]): Promise<number> {
  const done: { name: string; ok: boolean; ms: number }[] = []
  for (const step of steps) {
    const started = performance.now()
    try {
      const detail = await step.run()
      const ms = Math.round(performance.now() - started)
      done.push({ name: step.name, ok: true, ms })
      if (!json) write(io.stdout, `ok      ${step.name.padEnd(10)} ${detail} (${duration(ms)})\n`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!json) write(io.stdout, `failed  ${step.name.padEnd(10)} (${duration(Math.round(performance.now() - started))})\n`)
      printError(io, json, { code: `${step.name}-failed`, message: `${step.name} failed: ${message}`, fix: step.fix }, "Finish the job with:")
      return 1
    }
  }
  const then = next()
  if (json) write(io.stdout, `${JSON.stringify({ ok: true, steps: done, next: then }, null, 2)}\n`)
  else if (then.length) write(io.stdout, `\nNext:\n${then.map(line => `  ${line}\n`).join("")}`)
  return 0
}

/** Steps with the command that finishes the job from each: the commands to run again (`redo`) from that step on, each once, in order. */
export function finishing(steps: (Omit<Step, "fix"> & { redo: string })[]): Step[] {
  return steps.map(({ name, run }, index) => ({ name, run, fix: [...new Set(steps.slice(index).map(later => later.redo).reverse())].reverse().join(" && ") }))
}

/** Print `text` on stdout, unless the command answers in JSON. */
export const say = (io: Io, json: boolean, text: string) => json || write(io.stdout, `${text}\n`)

/** What a command was given: its positional arguments, and its flags, each a value or `true`. */
export type Args = { positionals: string[]; flags: Record<string, string | true> }

/** A command of bun mcp: its definition (definitions.ts), which `bun mcp help` and the docs read, and what runs it. */
export type Command = Definition & { run(io: Io, args: Args): Promise<number> }
