import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { RunOptions, RunResult, Runner } from "./run"

/** One command the fake runner was asked to run. */
export type RecordedCall = {
  argv: string[]
  options: RunOptions
  /** The kubeconfig file's text at the moment the command ran, if the command was given one. */
  kubeconfig: string | undefined
}

/** A fake runner and what it saw. */
export type FakeRunner = {
  run: Runner
  calls: RecordedCall[]
  /** Every command as one space-joined line. */
  commands(): string[]
}

/**
 * A runner for tests: `reply` decides what each command leaves behind (exit code 0 and no output when it
 * answers nothing). The reply's output reaches `onOutput`, as a real command's would.
 */
export function createFakeRunner(reply: (call: RecordedCall) => Partial<RunResult> | undefined): FakeRunner {
  const calls: RecordedCall[] = []
  const run: Runner = async (argv, options = {}) => {
    const path = options.env?.KUBECONFIG
    const kubeconfig = path ? await Bun.file(path).text().catch(() => undefined) : undefined
    const call = { argv: [...argv], options, kubeconfig }
    calls.push(call)
    const result = { exitCode: 0, stdout: "", stderr: "", ...reply(call) }
    if (result.stdout) options.onOutput?.(result.stdout)
    if (result.stderr) options.onOutput?.(result.stderr)
    return result
  }
  return { run, calls, commands: () => calls.map((call) => call.argv.join(" ")) }
}

/** A disposable repository root holding the given files. */
export async function createRoot(files: Record<string, string>): Promise<{ path: string; remove(): Promise<void> }> {
  const path = await mkdtemp(join(tmpdir(), "answerable-pipeline-"))
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(path, name)), { recursive: true })
    await writeFile(join(path, name), content)
  }
  return { path, remove: () => rm(path, { recursive: true, force: true }) }
}
