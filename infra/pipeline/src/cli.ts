import { parseArgs } from "node:util"
import { join, resolve } from "node:path"
import { deploy, parseDigests, parseJob, runJob, type Deps } from "./deploy"
import { CHART, hostsFor, parseEnvironment } from "./environments"
import { PipelineError, UsageError } from "./errors"
import { systemRunner, type Output, type Runner } from "./run"
import { formatReport, runSmoke, smokePassed, type DeclaredMcp, type Fetch } from "./smoke"

/** Everything the command line touches outside itself. Tests pass fakes; {@link systemDeps} passes the real ones. */
export type CliDeps = {
  run: Runner
  fetch: Fetch
  sleep: (ms: number) => Promise<void>
  now: () => number
  env: Readonly<Record<string, string | undefined>>
  /** The repository root. */
  root: string
  /** Standard output: results a script reads. */
  out: Output
  /** Standard error: progress and errors for people. */
  err: Output
}

/** The real thing: processes, the network, the clock and the terminal. */
export function systemDeps(): CliDeps {
  return {
    run: systemRunner,
    fetch,
    sleep: Bun.sleep,
    now: Date.now,
    env: process.env,
    root: resolve(import.meta.dir, "../../.."),
    out: process.stdout.write.bind(process.stdout),
    err: process.stderr.write.bind(process.stderr),
  }
}

const USAGE = `Usage:
  bun infra/pipeline/src/cli.ts deploy --environment <staging|production> --image-tag <sha-commit> [--image-digest <image>=sha256:<hex> for each image] [--timeout <10m>]
  bun infra/pipeline/src/cli.ts run-job <bootstrap|register|make-admin> --environment <staging|production> [--email <address>] [--timeout <10m>]
  bun infra/pipeline/src/cli.ts smoke --environment <staging|production> [--wait <seconds>] [--interval <seconds>]

deploy pins the images of infra/pipeline/images.json (id, mcps, ops) by manifest digest: given with --image-digest for
every one, or looked up with docker buildx from the tag. It writes the Secret id-env from BETTER_AUTH_SECRET
and ROOT_ADMIN_SECRET, the MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET pair and the
GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET pair when set, and BETTER_AUTH_SECRETS when set. run-job runs one ops Job on
the release's own values, with the chart of the commit the release runs, and prints revision=<commit> on standard
output; make-admin needs --email. deploy and run-job read the cluster from KUBE_SERVER, KUBE_CA and KUBE_TOKEN and
report on standard error. smoke checks the MCPs of the checkout's charts/answerable/mcps.json and prints its table on
standard output. Exit codes: 0 done, 1 failed, 2 wrong usage.
`

function parse<const Options extends NonNullable<Parameters<typeof parseArgs>[0]>["options"]>(args: readonly string[], options: Options) {
  try {
    return parseArgs({ args: [...args], options, allowPositionals: true, strict: true })
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error))
  }
}

function require_(value: string | undefined, option: string): string {
  if (value === undefined) throw new UsageError(`${option} is required`)
  return value
}

function noPositionals(positionals: string[], command: string): void {
  if (positionals.length > 0) throw new UsageError(`${command} takes no arguments, got "${positionals.join(" ")}"`)
}

function seconds(value: string | undefined, option: string, fallback: number): number {
  if (value === undefined) return fallback
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0) throw new UsageError(`${option} must be a number of seconds`)
  return number
}

function deployDeps(deps: CliDeps): Deps {
  return { run: deps.run, log: deps.err, env: deps.env, root: deps.root }
}

async function runCommand(command: string, args: readonly string[], deps: CliDeps): Promise<number> {
  switch (command) {
    case "deploy": {
      const { values, positionals } = parse(args, {
        environment: { type: "string" },
        "image-tag": { type: "string" },
        "image-digest": { type: "string", multiple: true },
        timeout: { type: "string" },
      })
      noPositionals(positionals, command)
      await deploy(
        {
          environment: parseEnvironment(values.environment),
          imageTag: require_(values["image-tag"], "--image-tag"),
          digests: parseDigests(values["image-digest"] ?? []),
          timeout: values.timeout,
        },
        deployDeps(deps),
      )
      return 0
    }
    case "run-job": {
      const { values, positionals } = parse(args, {
        environment: { type: "string" },
        email: { type: "string" },
        timeout: { type: "string" },
      })
      if (positionals.length !== 1) throw new UsageError("run-job takes exactly one job name")
      const revision = await runJob(
        {
          environment: parseEnvironment(values.environment),
          job: parseJob(positionals[0]),
          email: values.email,
          timeout: values.timeout,
        },
        deployDeps(deps),
      )
      deps.out(`revision=${revision}\n`)
      return 0
    }
    case "smoke": {
      const { values, positionals } = parse(args, {
        environment: { type: "string" },
        wait: { type: "string" },
        interval: { type: "string" },
      })
      noPositionals(positionals, command)
      const environment = parseEnvironment(values.environment)
      const hosts = hostsFor(environment)
      const { mcps } = (await Bun.file(join(deps.root, CHART, "mcps.json")).json()) as { mcps: DeclaredMcp[] }
      const results = await runSmoke(hosts, mcps, {
        fetch: deps.fetch,
        sleep: deps.sleep,
        now: deps.now,
        timeoutMs: seconds(values.wait, "--wait", 120) * 1000,
        intervalMs: seconds(values.interval, "--interval", 5) * 1000,
      })
      deps.out(formatReport(environment, hosts, results))
      return smokePassed(results) ? 0 : 1
    }
    default:
      throw new UsageError(`unknown command "${command}"`)
  }
}

/** Run the command line and answer the exit code: 0 done, 1 a step failed, 2 wrong usage. */
export async function main(argv: readonly string[], deps: CliDeps): Promise<number> {
  const [command, ...args] = argv
  if (command === "--help" || command === "help") {
    deps.out(USAGE)
    return 0
  }
  try {
    if (command === undefined) throw new UsageError("a command is required")
    return await runCommand(command, args, deps)
  } catch (error) {
    if (error instanceof UsageError) {
      deps.err(`error: ${error.message}\n\n${USAGE}`)
      return 2
    }
    if (error instanceof PipelineError) {
      deps.err(`error: ${error.message}\n`)
      return 1
    }
    // Bun 1.3.1 sometimes gives a stack without its first line, the message, so the message is printed on its own.
    const text = error instanceof Error ? (error.stack?.includes(error.message) ? error.stack : `${error.message}\n${error.stack ?? ""}`) : String(error)
    deps.err(`unexpected error: ${text}\n`)
    return 1
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2), systemDeps())
