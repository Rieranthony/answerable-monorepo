// Test support for bun mcp: a repository in a temporary directory, and an Io with stand-in prompts, captured output and a recorded exec.
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { Readable, Writable } from "node:stream"
import type { Exec, Io, Prompts } from "../io"

/** A writable that keeps what it was given. */
function capture() {
  let text = ""
  const stream = new Writable({ write(chunk, _encoding, done) { text += String(chunk); done() } })
  return { stream, text: () => text }
}

/** A prompt as the stand-ins saw it: which, its message, and its choices and default for a select, or what its check refused for a text. */
export type Asked = { kind: "text" | "select"; message: string; placeholder?: string; initialValue?: unknown; options?: unknown[]; refused: string[] }

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

/** An Io for `argv` in `cwd`, without a terminal unless `isTTY`, with its output captured. */
export function testIo(argv: string[], cwd: string, { isTTY = false, answers = [], exec = recorder().exec }: { isTTY?: boolean; answers?: (string | symbol)[]; exec?: Exec } = {}) {
  const [stdout, stderr] = [capture(), capture()]
  const asking = prompts(answers)
  const io: Io = { argv, cwd, stdin: Readable.from([]), stdout: stdout.stream, stderr: stderr.stream, isTTY, prompts: asking.prompts, exec }
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
