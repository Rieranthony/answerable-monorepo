import { parseArgs } from "node:util"
import { resolve } from "node:path"
import { currentTag, deploy, parseDigests, parseJob, runJob, type Deps } from "./deploy"
import { hostsFor, parseEnvironment } from "./environments"
import { PipelineError, UsageError } from "./errors"
import { systemRunner, type Output, type Runner } from "./run"
import { formatReport, runSmoke, smokePassed, type Fetch } from "./smoke"

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
  bun infra/pipeline/src/cli.ts deploy --environment <staging|production> --image-tag <sha-commit> [--image-digest <image>=sha256:<hex> x4] [--bootstrap] [--values <file>] [--secrets <file>] [--timeout <10m>]
  bun infra/pipeline/src/cli.ts run-job <bootstrap|register> --environment <staging|production> [--image-tag <sha-commit> [--image-digest <image>=sha256:<hex> x4]] [--values <file>] [--timeout <10m>]
  bun infra/pipeline/src/cli.ts current-tag
  bun infra/pipeline/src/cli.ts smoke --environment <staging|production> [--wait <seconds>] [--interval <seconds>]

deploy and run-job pin the four images (id, toolbox, admin-mcp, ops) by manifest digest: given with
--image-digest for all four, or looked up with docker buildx from the tag (run-job without a tag keeps the digests
the release runs). deploy, run-job and current-tag read the cluster from KUBE_SERVER, KUBE_CA and KUBE_TOKEN;
deploy also needs SOPS_AGE_KEY. current-tag prints the tag the release runs on standard output; everything else reports on
standard error. smoke prints its table on standard output. Exit codes: 0 done, 1 failed, 2 wrong usage.
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
        bootstrap: { type: "boolean" },
        values: { type: "string" },
        secrets: { type: "string" },
        timeout: { type: "string" },
      })
      noPositionals(positionals, command)
      await deploy(
        {
          environment: parseEnvironment(values.environment),
          imageTag: require_(values["image-tag"], "--image-tag"),
          digests: parseDigests(values["image-digest"] ?? []),
          bootstrap: values.bootstrap,
          valuesFile: values.values,
          secretsFile: values.secrets,
          timeout: values.timeout,
        },
        deployDeps(deps),
      )
      return 0
    }
    case "run-job": {
      const { values, positionals } = parse(args, {
        environment: { type: "string" },
        "image-tag": { type: "string" },
        "image-digest": { type: "string", multiple: true },
        values: { type: "string" },
        timeout: { type: "string" },
      })
      if (positionals.length !== 1) throw new UsageError("run-job takes exactly one job name")
      await runJob(
        {
          environment: parseEnvironment(values.environment),
          job: parseJob(positionals[0]),
          imageTag: values["image-tag"],
          digests: parseDigests(values["image-digest"] ?? []),
          valuesFile: values.values,
          timeout: values.timeout,
        },
        deployDeps(deps),
      )
      return 0
    }
    case "current-tag": {
      const { positionals } = parse(args, {})
      noPositionals(positionals, command)
      deps.out(`${await currentTag(deployDeps(deps))}\n`)
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
      const results = await runSmoke(hosts, {
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
    deps.err(`unexpected error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
    return 1
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2), systemDeps())
