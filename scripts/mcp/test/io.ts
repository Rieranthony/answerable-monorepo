// Test support for bun mcp: a repository in a temporary directory, and an Io with stand-in prompts, captured output and a recorded exec.
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { Readable, Writable } from "node:stream"
import type { Exec, Fetch, Io, Prompts, Running, Start } from "../io"

/** A writable that keeps what it was given. */
function capture() {
  let text = ""
  const stream = new Writable({ write(chunk, _encoding, done) { text += String(chunk); done() } })
  return { stream, text: () => text }
}

/** A prompt as the stand-ins saw it: which, its message, and its choices and default for a select, or what its check refused for a text. */
type Asked = { kind: "text" | "select" | "password"; message: string; placeholder?: string; initialValue?: unknown; options?: unknown[]; refused: string[] }

/**
 * Prompts that answer from `answers`, in order. A text answer its check refuses is recorded, and the next answer is tried, as a person retyping
 * would; a symbol answers as a cancel.
 */
function prompts(answers: (string | symbol)[]): { prompts: Prompts; asked: Asked[] } {
  const asked: Asked[] = []
  const stand = {
    async text(options: { message: string; placeholder?: string; validate?: (value: string | undefined) => unknown }) {
      const prompt: Asked = { kind: "text", message: options.message, placeholder: options.placeholder, refused: [] }
      asked.push(prompt)
      for (;;) {
        const answer = answers.shift()
        if (answer === undefined) throw new Error(`No answer left for: ${options.message}`)
        if (typeof answer === "symbol") return answer
        const refusal = options.validate?.(answer)
        if (!refusal) return answer
        prompt.refused.push(String(refusal))
      }
    },
    async password(options: { message: string; validate?: (value: string | undefined) => unknown }) {
      const prompt: Asked = { kind: "password", message: options.message, refused: [] }
      asked.push(prompt)
      for (;;) {
        const answer = answers.shift()
        if (answer === undefined) throw new Error(`No answer left for: ${options.message}`)
        if (typeof answer === "symbol") return answer
        const refusal = options.validate?.(answer)
        if (!refusal) return answer
        prompt.refused.push(String(refusal))
      }
    },
    async select(options: { message: string; options: { value: unknown }[]; initialValue?: unknown }) {
      asked.push({ kind: "select", message: options.message, initialValue: options.initialValue, options: options.options.map(option => option.value), refused: [] })
      const answer = answers.shift()
      if (answer === undefined) throw new Error(`No answer left for: ${options.message}`)
      return answer
    },
  }
  return { prompts: stand as unknown as Prompts, asked }
}

/** A recorded exec: every command it was asked to run, each answered by `answer`, by default exit 0 with "3 pass" as its output. */
export function recorder(answer: (command: string[]) => { code: number; output: string } = () => ({ code: 0, output: " 3 pass\n 0 fail\n" })) {
  const ran: { command: string[]; cwd: string; env?: Record<string, string> }[] = []
  const exec: Exec = async (command, { cwd, env }) => {
    ran.push({ command, cwd, env })
    return answer(command)
  }
  return { exec, ran }
}

/** An HTTP client that reaches nothing, as when the server it calls is down. */
const noFetch: Fetch = async () => { throw new TypeError("Unable to connect") }

/** A server that never started: the stand-in for a command that starts none. */
const noServer: Start = () => { throw new Error("This test starts no server") }

/** The `start` of a test: each server it is asked for is recorded with its command, directory and environment, and runs until stopped, until `end(command, cwd)` ends it at once, or until the test calls its `exit(code)`. */
export function servers(end: (command: string[], cwd: string) => number | undefined = () => undefined) {
  const started: { command: string[]; cwd: string; env: Record<string, string>; stopped: boolean; ended: boolean; exit(code: number): void }[] = []
  const start: Start = (command, { cwd, env }) => {
    let finish: (code: number) => void = () => {}
    const exited = new Promise<number>(resolve => (finish = resolve))
    const record = { command, cwd, env, stopped: false, ended: false, exit: (code: number) => { record.ended = true; finish(code) } }
    started.push(record)
    const code = end(command, cwd)
    if (code !== undefined) record.exit(code)
    const running: Running = { exited, async stop() { record.stopped = true; finish(0) } }
    return running
  }
  return { start, started }
}

/** What a test gives the machine around a command; by default no HTTP answers, nothing listens, no server starts and nobody interrupts. */
type Machine = Partial<Pick<Io, "fetch" | "listening" | "start">> & { signal?: AbortSignal }

/** An Io for `argv` in `cwd`, without a terminal unless `isTTY`, with its output captured. */
export function testIo(argv: string[], cwd: string, { isTTY = false, answers = [], exec = recorder().exec, fetch, listening, start, signal }: { isTTY?: boolean; answers?: (string | symbol)[]; exec?: Exec } & Machine = {}) {
  const [stdout, stderr] = [capture(), capture()]
  const asking = prompts(answers)
  const io: Io = {
    argv, cwd, stdin: Readable.from([]), stdout: stdout.stream, stderr: stderr.stream, isTTY, prompts: asking.prompts, exec,
    fetch: fetch ?? noFetch, listening: listening ?? (async () => false), start: start ?? noServer, interrupt: () => signal ?? new AbortController().signal,
  }
  return { io, stdout: stdout.text, stderr: stderr.text, asked: asking.asked }
}

/** A repository in a temporary directory: its package.json with the mcps/* workspaces, mcps/retired.json, and `files` by path. */
export async function tempRepository(files: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), "bun-mcp-"))
  const all = { "package.json": `{ "workspaces": ["mcps/*"] }\n`, "mcps/retired.json": "[]\n", ...files }
  for (const [path, text] of Object.entries(all)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await Bun.write(join(root, path), text)
  }
  return { root, remove: () => rm(root, { recursive: true, force: true }) }
}

/** What the repository under `root` holds, every file by path, sorted. */
export const filesUnder = async (root: string) => (await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: root, dot: true }))).sort()
