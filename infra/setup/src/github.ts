import { requireVariable, type Context } from "./context"
import { allowedApiCidrs, REPOSITORY, type EnvironmentName, type Paths } from "./environments"
import { SetupError, UsageError } from "./errors"
import { commandLine } from "./run"
import { readAgeKey } from "./secrets"
import { readOutput, stateEnv } from "./terraform"

/** What `publish-env` does. */
export type PublishEnvOptions = {
  environment: EnvironmentName
  paths: Paths
  /** Set the repository variable `DEPLOY_STAGING=true`, which turns on the staging jobs of `deploy-staging.yml`. */
  enable?: boolean
  /** Replace secrets that already exist. Without it they are kept. */
  force?: boolean
}

/** How a GitHub environment is created when it is missing (infra/pipeline/README.md, What each GitHub environment holds). */
type Settings = "main-only" | "all-branches" | "reviewed"

/** One GitHub environment and the secrets it holds. */
type Target = { name: string; settings: Settings; secrets: Record<string, string> }

async function gh(context: Context, argv: string[], input?: string) {
  context.out(`$ ${commandLine(["gh", ...argv])}${input === undefined ? "" : " < (from memory)"}\n`)
  return context.run(["gh", ...argv], input === undefined ? {} : { input })
}

async function ghJson<T>(context: Context, argv: string[], what: string): Promise<T> {
  const result = await gh(context, argv)
  if (result.exitCode !== 0) throw new SetupError(`gh could not ${what} (exit ${result.exitCode}): ${result.stderr.trim()}`)
  return JSON.parse(result.stdout) as T
}

async function ensureEnvironment(context: Context, target: Target): Promise<string> {
  const path = `repos/${REPOSITORY}/environments/${target.name}`
  const found = await gh(context, ["api", path])
  if (found.exitCode === 0) return "exists; its settings are left as they are"
  if (!/HTTP 404|Not Found/.test(found.stderr))
    throw new SetupError(`gh could not read the environment ${target.name} (exit ${found.exitCode}): ${found.stderr.trim()}`)
  const mainOnly = { protected_branches: false, custom_branch_policies: true }
  let body: Record<string, unknown>
  if (target.settings === "reviewed") {
    const owner = await ghJson<{ id: number; type: string }>(context, ["api", `repos/${REPOSITORY}`, "--jq", ".owner"], "read the repository's owner")
    body = { wait_timer: 0, prevent_self_review: false, reviewers: [{ type: owner.type, id: owner.id }], deployment_branch_policy: mainOnly }
  } else body = { deployment_branch_policy: target.settings === "main-only" ? mainOnly : null }
  const created = await gh(context, ["api", "--method", "PUT", path, "--input", "-"], JSON.stringify(body))
  if (created.exitCode !== 0) throw new SetupError(`gh could not create the environment ${target.name} (exit ${created.exitCode}): ${created.stderr.trim()}`)
  if (target.settings === "all-branches") return "created; deployments from every branch, so that pull requests can plan"
  const policy = await gh(
    context,
    ["api", "--method", "POST", `${path}/deployment-branch-policies`, "--input", "-"],
    JSON.stringify({ name: "main", type: "branch" }),
  )
  if (policy.exitCode !== 0)
    throw new SetupError(`gh could not limit ${target.name} to main (exit ${policy.exitCode}): ${policy.stderr.trim()}`)
  return target.settings === "reviewed"
    ? "created; the repository's owner must approve each run, from main only"
    : "created; deployments from main only"
}

/** Read every value first, so that nothing is created when one is missing. */
async function targetsFor(options: PublishEnvOptions, context: Context): Promise<Target[]> {
  const { environment, paths } = options
  const env = context.env
  const civo = requireVariable(env, "CIVO_TOKEN", `the ${environment} Civo account's API key`)
  const cloudflare = requireVariable(env, "CLOUDFLARE_API_TOKEN", "Terraform's Cloudflare token for the zone")
  const cidrs = allowedApiCidrs(env, environment) ?? "[]"
  const ageKey = await readAgeKey(paths)
  const state = stateEnv(env)
  const output = async (name: string) => (await readOutput(context, paths.envDir, name, state)).trim()
  const deploy = {
    KUBE_SERVER: await output("kube_server"),
    KUBE_CA: await output("kube_ca"),
    KUBE_TOKEN: await output("kube_token"),
    SOPS_AGE_KEY: ageKey,
  }
  if (!/^https:\/\/\S+$/.test(deploy.KUBE_SERVER)) throw new SetupError("Terraform's kube_server is not an https:// URL")
  if (!deploy.KUBE_CA.includes("-----BEGIN CERTIFICATE-----")) throw new SetupError("Terraform's kube_ca is not a PEM certificate")
  const infra = {
    CIVO_TOKEN: civo,
    CLOUDFLARE_API_TOKEN: cloudflare,
    STATE_ACCESS_KEY_ID: await output("state_access_key_id"),
    STATE_SECRET_ACCESS_KEY: await output("state_secret_access_key"),
    ALLOWED_API_CIDRS: cidrs,
  }
  return environment === "staging"
    ? [
        { name: "staging", settings: "main-only", secrets: deploy },
        { name: "infra-staging", settings: "all-branches", secrets: infra },
      ]
    : [{ name: "production", settings: "reviewed", secrets: { ...deploy, ...infra } }]
}

/**
 * Hand an environment to GitHub: create its GitHub environments when they are missing, then set their secrets from
 * Terraform's outputs, the operator's tokens and the `age` key, each value on `gh`'s standard input and never on its
 * command line. Secrets that exist are kept unless `force`. With `enable`, staging's deploys are switched on.
 */
export async function publishEnv(options: PublishEnvOptions, context: Context): Promise<void> {
  if (options.enable && options.environment !== "staging")
    throw new UsageError("--enable switches on staging's deploys; production is promoted by hand, with no switch")
  const targets = await targetsFor(options, context)
  const auth = await gh(context, ["auth", "status", "--hostname", "github.com"])
  if (auth.exitCode !== 0) throw new SetupError("gh is not signed in to github.com: run gh auth login, then this again")

  const report: string[] = []
  for (const target of targets) {
    report.push(`${target.name}: ${await ensureEnvironment(context, target)}`)
    const existing = new Set(
      (await ghJson<{ name: string }[]>(
        context,
        ["secret", "list", "--env", target.name, "--repo", REPOSITORY, "--json", "name"],
        `list the secrets of ${target.name}`,
      )).map((secret) => secret.name),
    )
    const set: string[] = []
    const kept: string[] = []
    for (const [name, value] of Object.entries(target.secrets)) {
      if (existing.has(name) && !options.force) {
        kept.push(name)
        continue
      }
      const result = await gh(context, ["secret", "set", name, "--env", target.name, "--repo", REPOSITORY], value)
      if (result.exitCode !== 0) throw new SetupError(`gh could not set ${name} on ${target.name} (exit ${result.exitCode}): ${result.stderr.trim()}`)
      set.push(name)
    }
    report.push(`  set: ${set.join(", ") || "nothing"}`)
    if (kept.length) report.push(`  kept, because they exist (--force replaces them): ${kept.join(", ")}`)
  }

  if (options.enable) {
    const result = await gh(context, ["variable", "set", "DEPLOY_STAGING", "--repo", REPOSITORY], "true")
    if (result.exitCode !== 0) throw new SetupError(`gh could not set DEPLOY_STAGING (exit ${result.exitCode}): ${result.stderr.trim()}`)
    report.push("repository variable DEPLOY_STAGING: true (a push to main now deploys staging)")
  }

  context.out(`\nPublished to ${REPOSITORY}:\n${report.join("\n")}\n`)
  if (options.environment === "staging" && !options.enable)
    context.out("Staging's deploys stay off until publish-env --enable sets DEPLOY_STAGING=true.\n")
  context.out(`Next: push to main${options.environment === "production" ? ", then run Promote production" : ""}; after the first deploy, id-first-run.\n`)
}
