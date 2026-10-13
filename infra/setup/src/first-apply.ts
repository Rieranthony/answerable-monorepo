import { readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { exists, requireVariable, type Context } from "./context"
import { allowedApiCidrs, shown, zoneFor, type EnvironmentName, type Paths } from "./environments"
import { SetupError } from "./errors"
import { commandLine } from "./run"
import { stateEnv, type StateEnv } from "./terraform"

/** What `first-apply` does. */
export type FirstApplyOptions = {
  environment: EnvironmentName
  paths: Paths
  /** Pass `-auto-approve` and `-force-copy`, so Terraform asks nothing. Without it Terraform asks before each change. */
  yes?: boolean
  /** The state is in the bucket already: run the cluster step again (a no-op when it is done) and the full apply. */
  resume?: boolean
}

/** The README's local-backend override for the first apply (`infra/civo/README.md`, First apply, step 2). */
const OVERRIDE = 'terraform {\n  backend "local" {}\n}\n'

type Step = { argv: string[]; env: Record<string, string>; what: string }

async function terraform(context: Context, paths: Paths, step: Step): Promise<void> {
  context.out(`\n$ ${commandLine(step.argv)}\n`)
  const result = await context.run(step.argv, { cwd: paths.envDir, env: step.env, interactive: true })
  if (result.exitCode !== 0) throw new SetupError(`${step.what} failed: ${commandLine(step.argv)} exited with ${result.exitCode}`)
}

async function quietOutput(context: Context, paths: Paths, name: string): Promise<string> {
  const result = await context.run(["terraform", "output", "-raw", name], { cwd: paths.envDir })
  const value = result.stdout.trim()
  if (result.exitCode !== 0 || !value)
    throw new SetupError(`terraform output ${name} failed (exit ${result.exitCode}): ${result.stderr.trim() || "empty"}`)
  return value
}

/** The backend this machine initialised the root with, from `.terraform/terraform.tfstate`, if any. */
async function initialisedBackend(paths: Paths): Promise<string | undefined> {
  const file = join(paths.envDir, ".terraform/terraform.tfstate")
  if (!(await exists(file))) return undefined
  try {
    const type = (JSON.parse(await readFile(file, "utf8")) as { backend?: { type?: unknown } }).backend?.type
    return typeof type === "string" ? type : undefined
  } catch {
    return undefined
  }
}

/** Steps 2 and 3: the state bucket with local state, then the state moved into it. Answers the bucket's credential. */
async function createStateBucket(options: FirstApplyOptions, context: Context, tokens: Record<string, string>): Promise<StateEnv> {
  const { paths } = options
  const approve = options.yes ? ["-auto-approve"] : []
  if ((await initialisedBackend(paths)) === "s3")
    throw new SetupError(
      `${shown(paths, paths.envDir)} already keeps its state in the bucket: the first apply has run. ` +
        "Finish it with --resume (export AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY first)",
    )

  const override = join(paths.envDir, "backend_override.tf")
  context.out(`Step 2: the state bucket, with local state (${shown(paths, override)}, ignored by Git).\n`)
  await writeFile(override, OVERRIDE)
  await terraform(context, paths, { argv: ["terraform", "init", "-input=false"], env: tokens, what: "Step 2 (init with local state)" })
  await terraform(context, paths, {
    argv: ["terraform", "apply", "-target=module.state", ...approve],
    env: tokens,
    what: `Step 2 (the state bucket; ${shown(paths, override)} stays so that a rerun continues)`,
  })

  context.out("\nStep 3: move the state into the bucket.\n")
  const state = {
    AWS_ACCESS_KEY_ID: await quietOutput(context, paths, "state_access_key_id"),
    AWS_SECRET_ACCESS_KEY: await quietOutput(context, paths, "state_secret_access_key"),
  }
  await rm(override)
  await terraform(context, paths, {
    argv: ["terraform", "init", "-input=false", "-migrate-state", ...(options.yes ? ["-force-copy"] : [])],
    env: { ...tokens, ...state },
    what: "Step 3 (the state migration)",
  })
  const listed = await context.run(["terraform", "state", "list"], { cwd: paths.envDir, env: { ...tokens, ...state } })
  if (listed.exitCode !== 0 || !listed.stdout.includes("module.state."))
    throw new SetupError(
      `terraform state list did not read the state from the bucket (exit ${listed.exitCode}): ${listed.stderr.trim()}. ` +
        "The local terraform.tfstate is kept",
    )
  context.out(`terraform state list now reads ${listed.stdout.trim().split("\n").length} resources from the bucket.\n`)
  for (const file of ["terraform.tfstate", "terraform.tfstate.backup"]) await rm(join(paths.envDir, file), { force: true })
  context.out(`Deleted the local terraform.tfstate and its backup: they held the state credential's secret.

The state lives in the bucket answerable-${options.environment}-tfstate now. From here on Terraform, first-apply --resume,
database-ca, init-secrets and publish-env read it with the bucket's credential, which this command has kept in memory
only. Keep it where you keep CIVO_TOKEN and export it before those commands:
  AWS_ACCESS_KEY_ID=${state.AWS_ACCESS_KEY_ID}
  AWS_SECRET_ACCESS_KEY: civo objectstore credential secret -a ${state.AWS_ACCESS_KEY_ID}
    (or the Civo dashboard: Object stores > Credentials > answerable-${options.environment}-tfstate)

Check by hand (infra/civo/README.md, First apply, step 4): the state lock. In ${shown(paths, paths.envDir)}, with the
credential exported, start \`terraform plan\` in two shells at once: the second must stop with "Error acquiring the
state lock". If the first fails writing ${options.environment}.tfstate.tflock instead, set use_lockfile = false in both
backend.tf files and keep to one operator at a time.
`)
  return state
}

/**
 * The README's first apply of an environment's root (`infra/civo/README.md`, First apply, steps 2, 3, 5 and 6): the
 * state bucket with local state, the state moved into it with its credential in Terraform's environment only, the
 * cluster, database and firewalls, and, once both CA files exist, the full apply. Step 4, the lock proof, is printed
 * as a manual check. `--resume` starts again at step 5 with the credential from the operator's environment.
 */
export async function firstApply(options: FirstApplyOptions, context: Context): Promise<void> {
  const { paths, environment } = options
  const tokens: Record<string, string> = {
    CIVO_TOKEN: requireVariable(context.env, "CIVO_TOKEN", `the ${environment} Civo account's API key`),
    CLOUDFLARE_API_TOKEN: requireVariable(context.env, "CLOUDFLARE_API_TOKEN", `Terraform's token for ${zoneFor(environment)}`),
  }
  const cidrs = allowedApiCidrs(context.env, environment)
  if (cidrs) tokens.TF_VAR_allowed_api_cidrs = cidrs
  const state = options.resume ? stateEnv(context.env) : await createStateBucket(options, context, tokens)
  const env = { ...tokens, ...state }
  const approve = options.yes ? ["-auto-approve"] : []

  if (options.resume) await terraform(context, paths, { argv: ["terraform", "init", "-input=false"], env, what: "terraform init" })
  context.out("\nStep 5: the cluster, the database and the firewalls, before anything that runs inside the cluster.\n")
  await terraform(context, paths, {
    argv: ["terraform", "apply", "-target=module.cluster", "-target=module.database", "-target=module.ingress_firewall", ...approve],
    env,
    what: "Step 5 (the cluster, the database and the firewalls)",
  })

  const missing: string[] = []
  for (const file of [paths.edgeCa, paths.databaseCa]) if (!(await exists(file))) missing.push(shown(paths, file))
  if (missing.length > 0) {
    context.out(`
Stopped before the full apply: ${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} missing. Make them, then resume:
  bun run setup origin-pull --environment ${environment} --zone ${zoneFor(environment)}
  bun run setup database-ca --environment ${environment}
  bun run setup first-apply --environment ${environment} --resume
`)
    return
  }

  context.out("\nStep 6: the namespaces, the platform chart, the deployer and the Cloudflare zone.\n")
  await terraform(context, paths, { argv: ["terraform", "apply", ...approve], env, what: "Step 6 (the full apply)" })
  context.out(`
Applied ${environment}. Next:
  bun run setup init-secrets --environment ${environment}
  bun run setup publish-env --environment ${environment}${environment === "staging" ? " --enable" : ""}
Then pin the cluster version (infra/civo/README.md, First apply, step 8): civo kubernetes show answerable-${environment}-cluster,
and set kubernetes_version in ${shown(paths, join(paths.envDir, "terraform.tfvars"))}.
`)
}
