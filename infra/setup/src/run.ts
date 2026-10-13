/** Receives text as a command produces it. */
export type Output = (text: string) => void

/** How to run one command. */
export type RunOptions = {
  /** Working directory of the command. */
  cwd?: string
  /** Variables added to the command's environment, on top of this process's own. They reach this command only. */
  env?: Readonly<Record<string, string>>
  /** Text sent to the command's standard input. It is never echoed. Leave it out and standard input is closed. */
  input?: string
  /** Receives the command's output as it arrives. Leave it out to keep the output private. */
  onOutput?: Output
  /**
   * Hand the command this terminal: its output goes straight to the operator and it may ask a question (Terraform's
   * "Enter a value"). Nothing is captured, so use it only for commands whose output carries no secret.
   */
  interactive?: boolean
  /** Kill the command after this many milliseconds. */
  timeoutMs?: number
}

/** What a command left behind. An interactive command leaves no output. */
export type RunResult = { exitCode: number; stdout: string; stderr: string }

/**
 * The one door to every external program (`terraform`, `sops`, `age-keygen`, `openssl`, `gh`).
 * Tests pass a fake; the command line passes {@link systemRunner}.
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
  const env = { ...process.env, ...options.env }
  try {
    if (options.interactive) {
      const child = Bun.spawn([...argv], {
        cwd: options.cwd,
        env,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
        timeout: options.timeoutMs,
      })
      return { exitCode: await child.exited, stdout: "", stderr: "" }
    }
    const child = Bun.spawn([...argv], {
      cwd: options.cwd,
      env,
      stdin: new TextEncoder().encode(options.input ?? ""),
      stdout: "pipe",
      stderr: "pipe",
      timeout: options.timeoutMs,
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      drain(child.stdout, options.onOutput),
      drain(child.stderr, options.onOutput),
      child.exited,
    ])
    return { exitCode, stdout, stderr }
  } catch (error) {
    return { exitCode: 127, stdout: "", stderr: `${argv[0]}: ${error instanceof Error ? error.message : String(error)}\n` }
  }
}

/** A command as one line for a log: arguments with spaces or quotes are single-quoted. */
export function commandLine(argv: readonly string[]): string {
  return argv.map((part) => (/^[\w@%+=:,./-]+$/.test(part) ? part : `'${part.replaceAll("'", "'\\''")}'`)).join(" ")
}
