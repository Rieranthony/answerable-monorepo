/** Receives text as a command produces it. */
export type Output = (text: string) => void

/** How to run one command. */
export type RunOptions = {
  /** Working directory of the command. */
  cwd?: string
  /** Variables added to the command's environment. */
  env?: Readonly<Record<string, string>>
  /** Text sent to the command's standard input. It is never echoed. */
  input?: string
  /** Receives the command's output as it arrives. Leave it out to keep the output private. */
  onOutput?: Output
}

/** What a command left behind. */
export type RunResult = { exitCode: number; stdout: string; stderr: string }

/**
 * The one door to every external program (`sops`, `kubectl`, `helm`).
 * Tests pass a fake; the pipeline passes {@link systemRunner}.
 */
export type Runner = (argv: readonly string[], options?: RunOptions) => Promise<RunResult>

async function drain(stream: ReadableStream<Uint8Array>, onOutput?: Output): Promise<string> {
  const decoder = new TextDecoder()
  const reader = stream.getReader()
  let text = ""
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    const piece = decoder.decode(value, { stream: true })
    text += piece
    onOutput?.(piece)
  }
  const rest = decoder.decode()
  text += rest
  if (rest) onOutput?.(rest)
  return text
}

/** Run a program for real. A program that cannot start answers exit code 127 rather than throwing. */
export const systemRunner: Runner = async (argv, options = {}) => {
  let child: Bun.Subprocess<"ignore" | Uint8Array<ArrayBuffer>, "pipe", "pipe">
  try {
    child = Bun.spawn([...argv], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdin: options.input === undefined ? "ignore" : new TextEncoder().encode(options.input),
      stdout: "pipe",
      stderr: "pipe",
    })
  } catch (error) {
    return { exitCode: 127, stdout: "", stderr: `${argv[0]}: ${error instanceof Error ? error.message : String(error)}\n` }
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    drain(child.stdout, options.onOutput),
    drain(child.stderr, options.onOutput),
    child.exited,
  ])
  return { exitCode, stdout, stderr }
}

/** A command as one line for a log: arguments with spaces or quotes are single-quoted. */
export function commandLine(argv: readonly string[]): string {
  return argv.map((part) => (/^[\w@%+=:,./-]+$/.test(part) ? part : `'${part.replaceAll("'", "'\\''")}'`)).join(" ")
}
