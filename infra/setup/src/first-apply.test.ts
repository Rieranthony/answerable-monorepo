import { afterEach, describe, expect, test } from "bun:test"
import { join } from "node:path"
import { exists } from "./context"
import { pathsFor } from "./environments"
import { firstApply } from "./first-apply"
import { createContext, createFakeRunner, createRoot, type RecordedCall } from "./testing"
import type { RunResult } from "./run"

const TOKENS = { CIVO_TOKEN: "civo-token", CLOUDFLARE_API_TOKEN: "cloudflare-token" }
const STATE = { AWS_ACCESS_KEY_ID: "STATEKEYID", AWS_SECRET_ACCESS_KEY: "state-secret-value" }
const CA = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function fixture(files: Record<string, string> = {}, reply: (call: RecordedCall) => Partial<RunResult> | undefined = () => undefined) {
  const root = await createRoot({ "infra/civo/envs/staging/main.tf": "", "infra/civo/envs/production/main.tf": "", ...files })
  cleanups.push(root.remove)
  const paths = pathsFor("staging", { root: root.path, home: root.path })
  const seen: { overrideAtInit?: boolean } = {}
  // Terraform as first-apply sees it: the targeted state apply leaves a local state, the outputs answer from it.
  const runner = createFakeRunner(async (call) => {
    const answer = reply(call)
    if (answer) return answer
    const line = call.argv.join(" ")
    if (line === "terraform init -input=false" && seen.overrideAtInit === undefined)
      seen.overrideAtInit = await exists(join(call.options.cwd!, "backend_override.tf"))
    if (line.startsWith("terraform apply -target=module.state")) {
      await Bun.write(join(call.options.cwd!, "terraform.tfstate"), "{}")
      await Bun.write(join(call.options.cwd!, "terraform.tfstate.backup"), "{}")
    }
    if (line === "terraform output -raw state_access_key_id") return { stdout: STATE.AWS_ACCESS_KEY_ID }
    if (line === "terraform output -raw state_secret_access_key") return { stdout: STATE.AWS_SECRET_ACCESS_KEY }
    if (line === "terraform state list") return { stdout: "module.state.civo_object_store.this\nmodule.state.civo_object_store_credential.this\n" }
    return undefined
  })
  return { paths, runner, seen }
}

describe("first-apply", () => {
  test("creates the bucket, moves the state, applies the cluster and stops for the CA files", async () => {
    const { paths, runner, seen } = await fixture()
    const { context, output } = createContext({ run: runner.run, env: TOKENS })
    await firstApply({ environment: "staging", paths }, context)
    expect(runner.commands()).toEqual([
      "terraform init -input=false",
      "terraform apply -target=module.state",
      "terraform output -raw state_access_key_id",
      "terraform output -raw state_secret_access_key",
      "terraform init -input=false -migrate-state",
      "terraform state list",
      "terraform apply -target=module.cluster -target=module.database -target=module.ingress_firewall",
    ])
    expect(seen.overrideAtInit).toBe(true)
    expect(await exists(join(paths.envDir, "backend_override.tf"))).toBe(false)
    expect(await exists(join(paths.envDir, "terraform.tfstate"))).toBe(false)
    expect(await exists(join(paths.envDir, "terraform.tfstate.backup"))).toBe(false)
    // Terraform asks before each change; the state credential reaches the commands that need it and nothing prints it.
    const [init, apply, , , migrate, list, cluster] = runner.calls
    expect(apply!.options).toMatchObject({ interactive: true, env: TOKENS })
    expect(init!.options.env).toEqual(TOKENS)
    expect(migrate!.options.env).toEqual({ ...TOKENS, ...STATE })
    expect(list!.options.env).toEqual({ ...TOKENS, ...STATE })
    expect(cluster!.options.env).toEqual({ ...TOKENS, ...STATE })
    expect(runner.calls[2]!.options.onOutput).toBeUndefined()
    expect(output()).not.toContain(STATE.AWS_SECRET_ACCESS_KEY)
    expect(output()).toContain("AWS_ACCESS_KEY_ID=STATEKEYID")
    expect(output()).toContain("civo objectstore credential secret -a STATEKEYID")
    expect(output()).toContain('"Error acquiring the\nstate lock"')
    expect(output()).toContain("infra/civo/envs/staging/edge-ca/ca.pem and infra/civo/envs/staging/database-ca.pem are missing")
    expect(output()).toContain("bun run setup origin-pull --environment staging --zone answerable-staging.uk")
    expect(output()).toContain("bun run setup first-apply --environment staging --resume")
  })

  test("with --yes and both CA files, runs through the full apply without a question", async () => {
    const { paths, runner } = await fixture({
      "infra/civo/envs/staging/edge-ca/ca.pem": CA,
      "infra/civo/envs/staging/database-ca.pem": CA,
    })
    const { context, output } = createContext({ run: runner.run, env: { ...TOKENS, ALLOWED_API_CIDRS: '["198.51.100.7/32"]' } })
    await firstApply({ environment: "staging", paths, yes: true }, context)
    expect(runner.commands()).toContain("terraform apply -target=module.state -auto-approve")
    expect(runner.commands()).toContain("terraform init -input=false -migrate-state -force-copy")
    expect(runner.commands().at(-1)).toBe("terraform apply -auto-approve")
    expect(runner.calls.at(-1)!.options.env).toEqual({ ...TOKENS, TF_VAR_allowed_api_cidrs: '["198.51.100.7/32"]', ...STATE })
    expect(output()).toContain("Applied staging. Next:")
    expect(output()).toContain("bun run setup publish-env --environment staging --enable")
  })

  test("--resume reads the credential from the environment and finishes", async () => {
    const files = { "edge-ca/ca.pem": CA, "database-ca.pem": CA, ".terraform/terraform.tfstate": '{"backend":{"type":"s3"}}' }
    const { paths, runner } = await fixture(
      Object.fromEntries(Object.entries(files).map(([name, text]) => [`infra/civo/envs/production/${name}`, text])),
    )
    const production = { ...paths, ...pathsFor("production", { root: paths.root, home: paths.root }) }
    const env = { ...TOKENS, ...STATE, ALLOWED_API_CIDRS: '["198.51.100.7/32"]' }
    const { context, output } = createContext({ run: runner.run, env })
    await firstApply({ environment: "production", paths: production, resume: true }, context)
    expect(runner.commands()).toEqual([
      "terraform init -input=false",
      "terraform apply -target=module.cluster -target=module.database -target=module.ingress_firewall",
      "terraform apply",
    ])
    expect(output()).toContain("bun run setup publish-env --environment production\n")
    await expect(
      firstApply({ environment: "production", paths: production, resume: true }, createContext({ run: runner.run, env: { ...TOKENS, ALLOWED_API_CIDRS: '["198.51.100.7/32"]' } }).context),
    ).rejects.toThrow("AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY")
  })

  test("refuses a fresh run where the state already lives in the bucket", async () => {
    const { paths, runner } = await fixture({ "infra/civo/envs/staging/.terraform/terraform.tfstate": '{"backend":{"type":"s3"}}' })
    await expect(firstApply({ environment: "staging", paths }, createContext({ run: runner.run, env: TOKENS }).context)).rejects.toThrow(
      "already keeps its state in the bucket",
    )
    expect(runner.calls).toEqual([])
  })

  test("runs again after a failed local-state step, whatever .terraform holds", async () => {
    for (const backend of ['{"backend":{"type":"local"}}', "not json", "{}"]) {
      const { paths, runner } = await fixture({ "infra/civo/envs/staging/.terraform/terraform.tfstate": backend })
      await firstApply({ environment: "staging", paths }, createContext({ run: runner.run, env: TOKENS }).context)
      expect(runner.commands()[0]).toBe("terraform init -input=false")
    }
  })

  test("needs both tokens, and production needs the operators' addresses", async () => {
    const { paths, runner } = await fixture()
    await expect(firstApply({ environment: "staging", paths }, createContext({ run: runner.run, env: { CIVO_TOKEN: "x" } }).context)).rejects.toThrow(
      "CLOUDFLARE_API_TOKEN is not set",
    )
    await expect(firstApply({ environment: "staging", paths }, createContext({ run: runner.run, env: {} }).context)).rejects.toThrow(
      "CIVO_TOKEN is not set",
    )
    await expect(firstApply({ environment: "production", paths }, createContext({ run: runner.run, env: TOKENS }).context)).rejects.toThrow(
      "ALLOWED_API_CIDRS is not set",
    )
    expect(runner.calls).toEqual([])
  })

  test("names the failing step and keeps the override so that a rerun continues", async () => {
    const { paths, runner } = await fixture({}, (call) => (call.argv[1] === "apply" ? { exitCode: 1 } : undefined))
    await expect(firstApply({ environment: "staging", paths }, createContext({ run: runner.run, env: TOKENS }).context)).rejects.toThrow(
      "Step 2 (the state bucket; infra/civo/envs/staging/backend_override.tf stays so that a rerun continues) failed",
    )
    expect(await exists(join(paths.envDir, "backend_override.tf"))).toBe(true)
  })

  test("keeps the local state when the bucket cannot be read back", async () => {
    const { paths, runner } = await fixture({}, (call) =>
      call.argv.join(" ") === "terraform state list" ? { exitCode: 1, stderr: "AccessDenied" } : undefined,
    )
    await expect(firstApply({ environment: "staging", paths }, createContext({ run: runner.run, env: TOKENS }).context)).rejects.toThrow(
      "did not read the state from the bucket (exit 1): AccessDenied. The local terraform.tfstate is kept",
    )
    expect(await exists(join(paths.envDir, "terraform.tfstate"))).toBe(true)
  })

  test("stops when an output of the local state is missing", async () => {
    const { paths, runner } = await fixture({}, (call) =>
      call.argv[1] === "output" ? { exitCode: 1, stderr: "Output not found" } : undefined,
    )
    await expect(firstApply({ environment: "staging", paths }, createContext({ run: runner.run, env: TOKENS }).context)).rejects.toThrow(
      "terraform output state_access_key_id failed (exit 1): Output not found",
    )
    const empty = await fixture({}, (call) => (call.argv[1] === "output" ? { stdout: "" } : undefined))
    await expect(firstApply({ environment: "staging", paths: empty.paths }, createContext({ run: empty.runner.run, env: TOKENS }).context)).rejects.toThrow(
      "failed (exit 0): empty",
    )
  })

  test("says which single CA file is missing", async () => {
    const { paths, runner } = await fixture({ "infra/civo/envs/staging/edge-ca/ca.pem": CA })
    const { context, output } = createContext({ run: runner.run, env: { ...TOKENS, ...STATE } })
    await firstApply({ environment: "staging", paths, resume: true }, context)
    expect(output()).toContain("infra/civo/envs/staging/database-ca.pem is missing")
  })
})
