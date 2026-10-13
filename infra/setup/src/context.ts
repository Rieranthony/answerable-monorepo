import { access } from "node:fs/promises"
import { UsageError } from "./errors"
import type { Output, Runner } from "./run"

/** The subset of `fetch` the commands use, so that tests can answer with a plain function. */
export type Fetch = (input: string, init?: RequestInit) => Promise<Response>

/** Everything a command touches outside itself. Tests pass fakes; `systemContext` in `cli.ts` passes the real ones. */
export type Context = {
  /** Runs `terraform`, `sops`, `age-keygen`, `openssl` and `gh`. */
  run: Runner
  /** Cloudflare's API and Answerable ID's admin API. */
  fetch: Fetch
  sleep: (ms: number) => Promise<void>
  now: () => number
  /** The operator's environment variables: the tokens and the state credential are read from here. */
  env: Readonly<Record<string, string | undefined>>
  /** What the operator reads: what was done, what to check, what comes next. Never a secret. */
  out: Output
  /** The whole of standard input, for `database-ca --from-stdin`. */
  readStdin: () => Promise<string>
  /** Print a question and wait for one line of standard input; `null` when standard input has ended. */
  ask: (question: string) => Promise<string | null>
}

/** Whether a file exists. */
export async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** A variable the command cannot run without, trimmed; its absence is a usage error naming it. */
export function requireVariable(env: Context["env"], name: string, why: string): string {
  const value = env[name]?.trim()
  if (!value) throw new UsageError(`${name} is not set: ${why}`)
  return value
}
