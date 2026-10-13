import { homedir } from "node:os"
import { resolve } from "node:path"
import { parseArgs } from "node:util"
import { ageInit } from "./age"
import type { Context } from "./context"
import { databaseCa } from "./database-ca"
import { parseEnvironment, pathsFor } from "./environments"
import { SetupError, UsageError } from "./errors"
import { firstApply } from "./first-apply"
import { publishEnv } from "./github"
import { idFirstRun, idMakeAdmin } from "./id"
import { originPull } from "./origin-pull"
import { systemRunner, type Output } from "./run"
import { initSecrets } from "./secrets"

/** Everything the command line touches outside itself. Tests pass fakes; {@link systemDeps} passes the real ones. */
export type CliDeps = Context & {
  /** The repository root. */
  root: string
  /** The operator's home directory, where `~/.config/sops/age` is. */
  home: string
  /** Standard error: errors. */
  err: Output
}

/** Print a question and answer the next line of `lines`, or `null` when they have ended. */
export async function ask(lines: AsyncIterable<string>, out: Output, question: string): Promise<string | null> {
  out(question)
  for await (const line of lines) return line
  return null
}

/** The real thing: processes, the network, the clock, the terminal and the operator's home directory. */
export function systemDeps(): CliDeps {
  const out: Output = process.stdout.write.bind(process.stdout)
  return {
    run: systemRunner,
    fetch,
    sleep: Bun.sleep,
    now: Date.now,
    env: process.env,
    out,
    err: process.stderr.write.bind(process.stderr),
    readStdin: Bun.stdin.text.bind(Bun.stdin),
    ask: ask.bind(undefined, console, out),
    root: resolve(import.meta.dir, "../../.."),
    home: homedir(),
  }
}

const USAGE = `Usage: bun run setup <command> --environment <staging|production> [options]

Once per environment, in this order (infra/setup/README.md):
  age-init                      the environment's age key (~/.config/sops/age/answerable-<env>.txt) and its .sops.yaml rule
  first-apply [--yes]           infra/civo/README.md's first apply: state bucket, state migration, cluster, then the rest
              [--resume]        continue at the cluster step once the CA files exist (needs AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY)
  origin-pull --zone <zone>     the origin-pull CA and client certificate; uploads the client pair, writes edge-ca/ca.pem
              [--force]         rotate: trust both CAs while you apply, upload, keep the new CA
              [--wait <s>]      how long to wait for Cloudflare to deploy it (default 300)
  database-ca [--from-stdin]    the database's CA certificate, trust-on-first-use, to database-ca.pem
              [--force]         replace an existing database-ca.pem
  init-secrets                  the three Secrets, encrypted with sops, to secrets.enc.yaml
              [--force]         replace the whole file
              [--rotate <key>]  replace one value: ROOT_ADMIN_SECRET, UPSTREAM_TOKEN_SECRETS, OPS_DATABASE_ADMIN_URL, api-token,
                                or a platform application pair (MICROSOFT_CLIENT_SECRET, GOOGLE_CLIENT_SECRET, ...)
  publish-env [--enable]        GitHub environments and secrets; --enable sets DEPLOY_STAGING=true (staging)
              [--force]         replace secrets that exist
  id-first-run --domain <domain> --entra-tenant <tenant id>
                                ID's first run with the root secret: staff domain, Entra provider, connectivity test
  id-make-admin --email <address>
                                put a signed-in staff member in platform-admins; root locks itself

Every command also takes --sops-config <file> (default .sops.yaml) and --key-dir <dir> (default ~/.config/sops/age).
Variables: CIVO_TOKEN and CLOUDFLARE_API_TOKEN (first-apply, publish-env; origin-pull needs the second),
AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY (the state bucket's credential, once first-apply has moved the state),
ALLOWED_API_CIDRS (production), CERT_MANAGER_CLOUDFLARE_TOKEN (init-secrets), MICROSOFT_CLIENT_ID and
MICROSOFT_CLIENT_SECRET, GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (init-secrets, optional, in pairs).
No command prints a secret. Exit codes: 0 done, 1 a step failed, 2 wrong usage.
`

type Options = NonNullable<NonNullable<Parameters<typeof parseArgs>[0]>["options"]>

const COMMON: Options = {
  environment: { type: "string" },
  "sops-config": { type: "string" },
  "key-dir": { type: "string" },
}

const COMMANDS: Record<string, Options> = {
  "age-init": { force: { type: "boolean" } },
  "first-apply": { yes: { type: "boolean" }, resume: { type: "boolean" } },
  "origin-pull": { zone: { type: "string" }, force: { type: "boolean" }, wait: { type: "string" } },
  "database-ca": { "from-stdin": { type: "boolean" }, force: { type: "boolean" } },
  "init-secrets": { force: { type: "boolean" }, rotate: { type: "string" } },
  "publish-env": { enable: { type: "boolean" }, force: { type: "boolean" } },
  "id-first-run": { domain: { type: "string" }, "entra-tenant": { type: "string" } },
  "id-make-admin": { email: { type: "string" } },
}

function required(value: string | boolean | undefined, option: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new UsageError(`--${option} is required`)
  return value
}

function seconds(value: string | boolean | undefined): number | undefined {
  if (typeof value !== "string") return undefined
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0) throw new UsageError("--wait must be a number of seconds")
  return number
}

async function runCommand(command: string, args: readonly string[], deps: CliDeps): Promise<void> {
  const options = Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : undefined
  if (!options) throw new UsageError(`unknown command "${command}"`)
  let values: Record<string, string | boolean | undefined>
  try {
    values = parseArgs({ args: [...args], options: { ...COMMON, ...options }, allowPositionals: false, strict: true })
      .values as typeof values
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error))
  }
  const environment = parseEnvironment(values.environment as string | undefined)
  const paths = pathsFor(environment, {
    root: deps.root,
    home: deps.home,
    sopsConfig: values["sops-config"] === undefined ? undefined : resolve(String(values["sops-config"])),
    keyDir: values["key-dir"] === undefined ? undefined : resolve(String(values["key-dir"])),
  })
  const flag = (name: string) => values[name] === true
  switch (command) {
    case "age-init":
      return ageInit({ environment, paths, force: flag("force") }, deps)
    case "first-apply":
      return firstApply({ environment, paths, yes: flag("yes"), resume: flag("resume") }, deps)
    case "origin-pull":
      return originPull(
        { environment, paths, zone: required(values.zone, "zone"), force: flag("force"), waitSeconds: seconds(values.wait) },
        deps,
      )
    case "database-ca":
      return databaseCa({ environment, paths, fromStdin: flag("from-stdin"), force: flag("force") }, deps)
    case "init-secrets":
      return initSecrets({ environment, paths, force: flag("force"), rotate: values.rotate as string | undefined }, deps)
    case "publish-env":
      return publishEnv({ environment, paths, enable: flag("enable"), force: flag("force") }, deps)
    case "id-first-run":
      return idFirstRun(
        { environment, paths, domain: required(values.domain, "domain"), entraTenant: required(values["entra-tenant"], "entra-tenant") },
        deps,
      )
    case "id-make-admin":
      return idMakeAdmin({ environment, paths, email: required(values.email, "email") }, deps)
  }
}

/** Run the command line and answer the exit code: 0 done, 1 a step failed, 2 wrong usage. */
export async function main(argv: readonly string[], deps: CliDeps): Promise<number> {
  const [command, ...args] = argv
  if (command === "--help" || command === "help" || command === "-h") {
    deps.out(USAGE)
    return 0
  }
  try {
    if (command === undefined) throw new UsageError("a command is required")
    await runCommand(command, args, deps)
    return 0
  } catch (error) {
    if (error instanceof UsageError) {
      deps.err(`error: ${error.message}\n\n${USAGE}`)
      return 2
    }
    if (error instanceof SetupError) {
      deps.err(`error: ${error.message}\n`)
      return 1
    }
    deps.err(`unexpected error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
    return 1
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2), systemDeps())
