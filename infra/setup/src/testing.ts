import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { Context, Fetch } from "./context"
import type { RunOptions, RunResult, Runner } from "./run"

/** One command the fake runner was asked to run. */
export type RecordedCall = { argv: string[]; options: RunOptions }

/** A fake runner and what it saw. */
export type FakeRunner = {
  run: Runner
  calls: RecordedCall[]
  /** Every command as one space-joined line. */
  commands(): string[]
}

/**
 * A runner for tests: `reply` decides what each command leaves behind (exit code 0 and no output when it answers
 * nothing), and may write files as the real command would. The reply's output reaches `onOutput`.
 */
export function createFakeRunner(
  reply: (call: RecordedCall) => Partial<RunResult> | undefined | Promise<Partial<RunResult> | undefined>,
): FakeRunner {
  const calls: RecordedCall[] = []
  const run: Runner = async (argv, options = {}) => {
    const call = { argv: [...argv], options }
    calls.push(call)
    const result = { exitCode: 0, stdout: "", stderr: "", ...(await reply(call)) }
    if (result.stdout) options.onOutput?.(result.stdout)
    if (result.stderr) options.onOutput?.(result.stderr)
    return result
  }
  return { run, calls, commands: () => calls.map((call) => call.argv.join(" ")) }
}

/** A disposable directory holding the given files. */
export async function createRoot(files: Record<string, string> = {}): Promise<{ path: string; remove(): Promise<void> }> {
  const path = await mkdtemp(join(tmpdir(), "answerable-setup-"))
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(path, name)), { recursive: true })
    await writeFile(join(path, name), content)
  }
  return { path, remove: () => rm(path, { recursive: true, force: true }) }
}

/** One request the fake fetch saw. */
export type RecordedRequest = { method: string; url: string; headers: Record<string, string>; body: unknown }

/** A fake `fetch` for tests: `reply` answers each request; every request is kept, its body parsed as JSON. */
export function createFakeFetch(reply: (request: RecordedRequest) => Response | Promise<Response>) {
  const requests: RecordedRequest[] = []
  const fetch: Fetch = async (input, init = {}) => {
    const headers: Record<string, string> = {}
    new Headers(init.headers).forEach((value, name) => {
      headers[name] = value
    })
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined
    const request = { method: init.method ?? "GET", url: input, headers, body }
    requests.push(request)
    return reply(request)
  }
  return { fetch, requests }
}

/** A JSON response. */
export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } })
}

/** A context with no outside world: the given runner and fetch, a fake clock, and the output collected. */
export function createContext(overrides: Partial<Context> = {}) {
  const lines: string[] = []
  let time = 0
  const context: Context = {
    run: createFakeRunner(() => undefined).run,
    fetch: async () => new Response("no fetch in this test", { status: 599 }),
    sleep: async (ms) => {
      time += ms
    },
    now: () => time,
    env: {},
    out: (text) => lines.push(text),
    readStdin: async () => "",
    ask: async () => null,
    ...overrides,
  }
  return { context, output: () => lines.join("") }
}
