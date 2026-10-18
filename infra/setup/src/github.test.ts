import { afterEach, describe, expect, test } from "bun:test"
import { pathsFor } from "./environments"
import { publishEnv } from "./github"
import { createContext, createFakeRunner, createRoot, type RecordedCall } from "./testing"
import type { RunResult } from "./run"

const CA = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n"
const OUTPUTS: Record<string, string> = {
  kube_server: "https://74.220.1.2:6443",
  kube_ca: CA,
  kube_token: "deployer-token-value",
  state_access_key_id: "STATEKEYID",
  state_secret_access_key: "state-secret-value",
}
const ENV = {
  CIVO_TOKEN: "civo-token-value",
  CLOUDFLARE_API_TOKEN: "cloudflare-token-value",
  STATE_ACCESS_KEY_ID: "STATEKEYID",
  STATE_SECRET_ACCESS_KEY: "state-secret-value",
}
const AGE_KEY = "AGE-SECRET-KEY-1SECRETVALUE"
const REPO = "repos/Rieranthony/answerable-monorepo"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

type World = { environments: Set<string>; secrets: Record<string, string[]>; owner?: string }

/** Terraform and gh as publish-env sees them, over a little world of environments and secret names. */
function fakeTools(world: World, override: (call: RecordedCall) => Partial<RunResult> | undefined = () => undefined) {
  return createFakeRunner((call) => {
    const answer = override(call)
    if (answer) return answer
    const [tool, first, ...rest] = call.argv
    if (tool === "terraform") return { stdout: `${OUTPUTS[rest[1]!] ?? ""}\n` }
    if (first === "auth") return undefined
    if (first === "api" && rest.length === 1) {
      const name = rest[0]!.split("/").at(-1)!
      return world.environments.has(name) ? { stdout: "{}" } : { exitCode: 1, stderr: "gh: Not Found (HTTP 404)\n" }
    }
    if (first === "api" && rest[0] === `${REPO}`) return { stdout: '{"id":4242,"type":"User"}\n' }
    if (first === "api" && rest[0] === "--method" && rest[1] === "PUT") world.environments.add(rest[2]!.split("/").at(-1)!)
    if (first === "secret" && rest[0] === "list")
      return { stdout: JSON.stringify((world.secrets[rest[2]!] ?? []).map((name) => ({ name }))) }
    return undefined
  })
}

async function fixture() {
  const root = await createRoot({
    "infra/civo/envs/staging/.terraform/terraform.tfstate": "{}",
    "infra/civo/envs/production/.terraform/terraform.tfstate": "{}",
    "keys/answerable-staging.txt": `# public key: age1x\n${AGE_KEY}\n`,
    "keys/answerable-production.txt": `# public key: age1x\n${AGE_KEY}\n`,
  })
  cleanups.push(root.remove)
  return {
    staging: pathsFor("staging", { root: root.path, home: root.path, keyDir: `${root.path}/keys` }),
    production: pathsFor("production", { root: root.path, home: root.path, keyDir: `${root.path}/keys` }),
  }
}

function secretsSet(calls: RecordedCall[]) {
  return calls
    .filter((call) => call.argv[1] === "secret" && call.argv[2] === "set")
    .map((call) => ({ name: call.argv[3]!, env: call.argv[5]!, value: call.options.input!, argv: call.argv.join(" ") }))
}

describe("publish-env", () => {
  test("creates staging's two environments, sets every secret from stdin and switches the deploys on", async () => {
    const { staging } = await fixture()
    const world: World = { environments: new Set(), secrets: {} }
    const runner = fakeTools(world)
    const { context, output } = createContext({ run: runner.run, env: ENV })
    await publishEnv({ environment: "staging", paths: staging, enable: true }, context)

    const puts = runner.calls.filter((call) => call.argv.includes("PUT"))
    expect(puts.map((call) => [call.argv[4], JSON.parse(call.options.input!)])).toEqual([
      [`${REPO}/environments/staging`, { deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } }],
      [`${REPO}/environments/infra-staging`, { deployment_branch_policy: null }],
    ])
    const policies = runner.calls.filter((call) => call.argv.includes("POST"))
    expect(policies.map((call) => [call.argv[4], call.options.input])).toEqual([
      [`${REPO}/environments/staging/deployment-branch-policies`, '{"name":"main","type":"branch"}'],
    ])
    const set = secretsSet(runner.calls)
    expect(set.map((secret) => `${secret.env}/${secret.name}=${secret.value}`)).toEqual([
      `staging/KUBE_SERVER=${OUTPUTS.kube_server}`,
      `staging/KUBE_CA=${CA.trim()}`,
      `staging/KUBE_TOKEN=${OUTPUTS.kube_token}`,
      `staging/SOPS_AGE_KEY=${AGE_KEY}`,
      `infra-staging/CIVO_TOKEN=${ENV.CIVO_TOKEN}`,
      `infra-staging/CLOUDFLARE_API_TOKEN=${ENV.CLOUDFLARE_API_TOKEN}`,
      `infra-staging/STATE_ACCESS_KEY_ID=STATEKEYID`,
      `infra-staging/STATE_SECRET_ACCESS_KEY=state-secret-value`,
      `infra-staging/ALLOWED_API_CIDRS=[]`,
    ])
    for (const secret of set) {
      expect(secret.argv).toBe(`gh secret set ${secret.name} --env ${secret.env} --repo Rieranthony/answerable-monorepo`)
      if (secret.value !== "[]") expect(output()).not.toContain(secret.value)
    }
    const variable = runner.calls.find((call) => call.argv[1] === "variable")!
    expect(variable.argv.join(" ")).toBe("gh variable set DEPLOY_STAGING --repo Rieranthony/answerable-monorepo")
    expect(variable.options.input).toBe("true")
    expect(output()).toContain("staging: created; deployments from main only\n  set: KUBE_SERVER, KUBE_CA, KUBE_TOKEN, SOPS_AGE_KEY")
    expect(output()).toContain("infra-staging: created; deployments from every branch")
    expect(output()).toContain("repository variable DEPLOY_STAGING: true")
    expect(output()).toContain("Next: push to main; after the first deploy, id-first-run.")
  })

  test("keeps existing secrets and environments unless forced, and says the deploys are still off", async () => {
    const { staging } = await fixture()
    const world: World = {
      environments: new Set(["staging", "infra-staging"]),
      secrets: { staging: ["KUBE_TOKEN"], "infra-staging": ["CIVO_TOKEN"] },
    }
    const runner = fakeTools(world)
    const { context, output } = createContext({ run: runner.run, env: ENV })
    await publishEnv({ environment: "staging", paths: staging }, context)
    expect(secretsSet(runner.calls).map((secret) => secret.name)).not.toContain("KUBE_TOKEN")
    expect(runner.calls.some((call) => call.argv.includes("PUT"))).toBe(false)
    expect(output()).toContain("staging: exists; its settings are left as they are")
    expect(output()).toContain("kept, because they exist (--force replaces them): KUBE_TOKEN")
    expect(output()).toContain("Staging's deploys stay off until publish-env --enable")
    const forced = fakeTools(world)
    await publishEnv({ environment: "staging", paths: staging, force: true }, createContext({ run: forced.run, env: ENV }).context)
    expect(secretsSet(forced.calls)).toHaveLength(9)

    const everything = fakeTools({
      environments: world.environments,
      secrets: { staging: ["KUBE_SERVER", "KUBE_CA", "KUBE_TOKEN", "SOPS_AGE_KEY"] },
    })
    const quiet = createContext({ run: everything.run, env: ENV })
    await publishEnv({ environment: "staging", paths: staging }, quiet.context)
    expect(quiet.output()).toContain("staging: exists; its settings are left as they are\n  set: nothing\n")
  })

  test("creates production as one reviewed environment holding everything", async () => {
    const { production } = await fixture()
    const runner = fakeTools({ environments: new Set(), secrets: {} })
    const { context, output } = createContext({ run: runner.run, env: { ...ENV, ALLOWED_API_CIDRS: '["198.51.100.7/32"]' } })
    await publishEnv({ environment: "production", paths: production }, context)
    const put = runner.calls.find((call) => call.argv.includes("PUT"))!
    expect(put.argv[4]).toBe(`${REPO}/environments/production`)
    expect(JSON.parse(put.options.input!)).toEqual({
      wait_timer: 0,
      prevent_self_review: false,
      reviewers: [{ type: "User", id: 4242 }],
      deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
    })
    const set = secretsSet(runner.calls)
    expect(set.every((secret) => secret.env === "production")).toBe(true)
    expect(set.map((secret) => secret.name)).toEqual([
      "KUBE_SERVER",
      "KUBE_CA",
      "KUBE_TOKEN",
      "SOPS_AGE_KEY",
      "CIVO_TOKEN",
      "CLOUDFLARE_API_TOKEN",
      "STATE_ACCESS_KEY_ID",
      "STATE_SECRET_ACCESS_KEY",
      "ALLOWED_API_CIDRS",
    ])
    expect(set.at(-1)!.value).toBe('["198.51.100.7/32"]')
    expect(output()).toContain("production: created; the repository's owner must approve each run, from main only")
    expect(output()).toContain("Next: push to main, then run Promote production")
  })

  test("refuses --enable for production and needs every input before it touches GitHub", async () => {
    const { staging, production } = await fixture()
    const runner = fakeTools({ environments: new Set(), secrets: {} })
    await expect(
      publishEnv({ environment: "production", paths: production, enable: true }, createContext({ run: runner.run, env: ENV }).context),
    ).rejects.toThrow("--enable switches on staging's deploys")
    await expect(
      publishEnv({ environment: "production", paths: production }, createContext({ run: runner.run, env: ENV }).context),
    ).rejects.toThrow("ALLOWED_API_CIDRS is not set")
    await expect(
      publishEnv({ environment: "staging", paths: staging }, createContext({ run: runner.run, env: { ...ENV, CIVO_TOKEN: "" } }).context),
    ).rejects.toThrow("CIVO_TOKEN is not set")
    await expect(
      publishEnv(
        { environment: "staging", paths: { ...staging, keyFile: "/nowhere/key.txt" } },
        createContext({ run: runner.run, env: ENV }).context,
      ),
    ).rejects.toThrow("run age-init first")
    expect(runner.calls.filter((call) => call.argv[0] === "gh")).toEqual([])
    for (const [output, message] of [
      ["kube_server", "Terraform's kube_server is not an https:// URL"],
      ["kube_ca", "Terraform's kube_ca is not a PEM certificate"],
    ]) {
      const wrong = fakeTools({ environments: new Set(), secrets: {} }, (call) =>
        call.argv[3] === output ? { stdout: "nonsense" } : undefined,
      )
      await expect(
        publishEnv({ environment: "staging", paths: staging }, createContext({ run: wrong.run, env: ENV }).context),
      ).rejects.toThrow(message!)
    }
  })

  test("stops at the first gh failure and names it", async () => {
    const { staging, production } = await fixture()
    const cases: Array<[(call: RecordedCall) => boolean, string, boolean?]> = [
      [(call) => call.argv[1] === "auth", "gh is not signed in to github.com: run gh auth login"],
      [(call) => call.argv[1] === "api" && call.argv.length === 3, "gh could not read the environment staging (exit 1): boom"],
      [(call) => call.argv.includes("PUT"), "gh could not create the environment staging (exit 1): boom"],
      [(call) => call.argv.includes("POST"), "gh could not limit staging to main (exit 1): boom"],
      [(call) => call.argv[2] === "list", "gh could not list the secrets of staging (exit 1): boom"],
      [(call) => call.argv[2] === "set", "gh could not set KUBE_SERVER on staging (exit 1): boom"],
      [(call) => call.argv[1] === "variable", "gh could not set DEPLOY_STAGING (exit 1): boom"],
      [(call) => call.argv[2] === REPO, "gh could not read the repository's owner (exit 1): boom", true],
    ]
    for (const [fails, message, onProduction] of cases) {
      const runner = fakeTools({ environments: new Set(), secrets: {} }, (call) =>
        fails(call) ? { exitCode: 1, stderr: "boom\n" } : undefined,
      )
      const env = { ...ENV, ALLOWED_API_CIDRS: '["198.51.100.7/32"]' }
      const options = onProduction
        ? { environment: "production" as const, paths: production }
        : { environment: "staging" as const, paths: staging, enable: true }
      await expect(publishEnv(options, createContext({ run: runner.run, env }).context)).rejects.toThrow(message)
    }
  })
})
