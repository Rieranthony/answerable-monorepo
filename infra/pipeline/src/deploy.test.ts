import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { stat } from "node:fs/promises"
import inventory from "../../../packages/config/inventory.json"
import { PipelineError, UsageError } from "./errors"
import {
  assertImageTag,
  deploy,
  ID_ENV_NAMES,
  idEnv,
  idEnvChecksum,
  kubeconfig,
  parseDigests,
  parseJob,
  readCluster,
  runJob,
  type Deps,
  type Digests,
} from "./deploy"
import type { RunResult } from "./run"
import { createFakeRunner, createRoot, type RecordedCall } from "./testing"

const TAG = `sha-${"a".repeat(40)}`
const CERTIFICATE = "-----BEGIN CERTIFICATE-----\nMIIBdemo\n-----END CERTIFICATE-----"
const CLUSTER_ENV = {
  KUBE_SERVER: "https://cluster.example:6443",
  KUBE_CA: Buffer.from(CERTIFICATE).toString("base64"),
  KUBE_TOKEN: "deployer-token-value",
}
/** ID's secrets as the deploy step has them: the GitHub environment's. */
const ID_ENV = {
  BETTER_AUTH_SECRET: "better-auth-secret-value-123",
  ROOT_ADMIN_SECRET: "root-admin-secret-value-789",
  MICROSOFT_CLIENT_ID: "11111111-2222-3333-4444-555555555555",
  MICROSOFT_CLIENT_SECRET: "microsoft-client-secret-value-012",
}
const ENV = { ...CLUSTER_ENV, ...ID_ENV }
const VALUES = "charts/answerable/values-civo-staging.yaml"
const CLIENT_SECRETS_COMMAND = "kubectl get secret toolbox-id-client admin-id-client -n answerable -o name --ignore-not-found"
const BOTH_EXIST = "secret/toolbox-id-client\nsecret/admin-id-client\n"
const NAMES = ["id", "toolbox", "admin-mcp", "ops"] as const

/** The digests the registry answers for TAG, and others given on the command line. */
const DIGESTS: Digests = {
  id: `sha256:${"1".repeat(64)}`,
  toolbox: `sha256:${"2".repeat(64)}`,
  "admin-mcp": `sha256:${"3".repeat(64)}`,
  ops: `sha256:${"4".repeat(64)}`,
}
const OTHER_DIGESTS: Digests = {
  id: `sha256:${"5".repeat(64)}`,
  toolbox: `sha256:${"6".repeat(64)}`,
  "admin-mcp": `sha256:${"7".repeat(64)}`,
  ops: `sha256:${"8".repeat(64)}`,
}
const pins = (digests: Digests) => NAMES.map((name) => `--set images.${name}.digest=${digests[name]}`).join(" ")
const lookups = (tag: string) =>
  NAMES.map((name) => `docker buildx imagetools inspect ghcr.io/rieranthony/answerable/${name}:${tag} --format {{.Manifest.Digest}}`)
const checksum = (values: Record<string, string>) => createHash("sha256").update(JSON.stringify(Object.fromEntries(Object.entries(values).sort(([a], [b]) => (a < b ? -1 : 1))))).digest("hex")
const upgradeCommand = (rest: string) =>
  `helm upgrade --install answerable charts/answerable --namespace answerable --rollback-on-failure --wait --wait-for-jobs --timeout 10m -f ${VALUES} --set image.tag=${TAG} ${rest}`

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

/** The registry: answers DIGESTS for the image named in `docker buildx imagetools inspect <reference> ...`. */
const registry = (call: RecordedCall): Partial<RunResult> => {
  const name = call.argv[4]!.split("/").pop()!.split(":")[0] as keyof Digests
  return { stdout: `${DIGESTS[name]}\n` }
}

type FixtureOptions = {
  env?: Record<string, string | undefined>
  /** Answers `docker buildx imagetools inspect`; the registry by default. */
  docker?: (call: RecordedCall) => Partial<RunResult>
  /** Answers the check for the client Secrets; both exist by default. */
  clients?: (call: RecordedCall) => Partial<RunResult>
}

async function fixture(reply: (call: RecordedCall) => Partial<RunResult> | undefined = () => undefined, { env = ENV, docker = registry, clients = () => ({ stdout: BOTH_EXIST }) }: FixtureOptions = {}) {
  const root = await createRoot({ [VALUES]: "" })
  cleanups.push(root.remove)
  const isClientCheck = (call: RecordedCall) => call.argv[0] === "kubectl" && call.argv[1] === "get" && call.argv[2] === "secret"
  const runner = createFakeRunner((call) =>
    call.argv[0] === "docker" ? docker(call) : isClientCheck(call) ? clients(call) : reply(call),
  )
  const logs: string[] = []
  const deps: Deps = { run: runner.run, log: (text) => logs.push(text), env, root: root.path }
  return {
    deps,
    runner,
    root: root.path,
    log: () => logs.join(""),
    /** The commands that reached the cluster side, without the registry lookups. */
    cluster: () => runner.commands().filter((command) => !command.startsWith("docker ")),
  }
}

describe("readCluster", () => {
  test("reads the server, the certificate authority and the token", () => {
    expect(readCluster(CLUSTER_ENV)).toEqual({
      server: "https://cluster.example:6443",
      certificateAuthority: Buffer.from(`${CERTIFICATE}\n`).toString("base64"),
      token: "deployer-token-value",
    })
  })

  test("accepts the certificate as raw PEM and trims stray whitespace", () => {
    const cluster = readCluster({ ...CLUSTER_ENV, KUBE_CA: `${CERTIFICATE}\n`, KUBE_TOKEN: " deployer-token-value\n" })
    expect(cluster.certificateAuthority).toBe(Buffer.from(`${CERTIFICATE}\n`).toString("base64"))
    expect(cluster.token).toBe("deployer-token-value")
  })

  test("names the variable that is missing or empty", () => {
    for (const name of ["KUBE_SERVER", "KUBE_CA", "KUBE_TOKEN"])
      expect(() => readCluster({ ...CLUSTER_ENV, [name]: " " })).toThrow(`${name} is not set`)
    expect(() => readCluster({})).toThrow(UsageError)
  })

  test("refuses a server that is not an https URL", () => {
    expect(() => readCluster({ ...CLUSTER_ENV, KUBE_SERVER: "http://cluster.example" })).toThrow(
      "KUBE_SERVER must be an https:// URL",
    )
  })

  test("refuses a certificate authority that is not a certificate", () => {
    expect(() => readCluster({ ...CLUSTER_ENV, KUBE_CA: "not a certificate" })).toThrow(
      "KUBE_CA must be a PEM certificate or its base64 encoding",
    )
  })
})

describe("kubeconfig", () => {
  test("selects the answerable namespace and carries the token", () => {
    const config = JSON.parse(kubeconfig(readCluster(CLUSTER_ENV)))
    expect(config.clusters[0].cluster.server).toBe("https://cluster.example:6443")
    expect(config.users[0].user.token).toBe("deployer-token-value")
    expect(config.contexts[0].context.namespace).toBe("answerable")
    expect(config["current-context"]).toBe("answerable")
  })
})

describe("assertImageTag and parseJob", () => {
  test("accept a commit tag and nothing mutable", () => {
    expect(() => assertImageTag(TAG)).not.toThrow()
    for (const tag of ["latest", "staging", "local", "sha-abc", `sha-${"A".repeat(40)}`, `${TAG}x`])
      expect(() => assertImageTag(tag)).toThrow(UsageError)
  })

  test("parseJob accepts the three ops jobs only", () => {
    for (const job of ["bootstrap", "register", "make-admin"] as const) expect(parseJob(job)).toBe(job)
    expect(() => parseJob("migrate")).toThrow("the job must be one of bootstrap, register, make-admin")
    expect(() => parseJob(undefined)).toThrow(UsageError)
  })
})

describe("parseDigests", () => {
  const pairs = NAMES.map((name) => `${name}=${DIGESTS[name]}`)

  test("answers nothing when no digest is given, meaning: look them up", () => {
    expect(parseDigests([])).toBeUndefined()
  })

  test("reads all four, in any order", () => {
    expect(parseDigests([...pairs].reverse())).toEqual(DIGESTS)
  })

  test("refuses an unknown image, a malformed digest or a missing one", () => {
    expect(() => parseDigests(["web=" + DIGESTS.id])).toThrow('unknown image "web"; the images are id, toolbox, admin-mcp, ops')
    expect(() => parseDigests(["id=sha256:abc"])).toThrow("--image-digest id= must be sha256: and 64 hex characters")
    expect(() => parseDigests(["id"])).toThrow("--image-digest id= must be")
    expect(() => parseDigests(["id=" + DIGESTS.id.toUpperCase()])).toThrow(UsageError)
  })

  test("refuses a digest named twice and an incomplete set", () => {
    expect(() => parseDigests([...pairs, pairs[0]!])).toThrow("names id twice")
    expect(() => parseDigests(pairs.slice(0, 2))).toThrow("all four images, or none; missing admin-mcp, ops")
  })
})

describe("id-env's variables", () => {
  test("are exactly those ID's definition says the deploy delivers", () => {
    const id = inventory.find((group) => group.name === "ID")!
    const delivered = id.fields.filter((field) => "source" in field && field.source === "deploy").map((field) => field.name)
    expect(delivered.sort()).toEqual([...ID_ENV_NAMES].sort())
  })

  test("each reaches the deploy step of both workflows from the GitHub environment", async () => {
    for (const workflow of ["deploy-staging.yml", "promote-production.yml"]) {
      const { jobs } = Bun.YAML.parse(await Bun.file(new URL(`../../../.github/workflows/${workflow}`, import.meta.url)).text()) as {
        jobs: Record<string, { steps?: { name?: string; env?: Record<string, string> }[] }>
      }
      const env = Object.values(jobs)
        .flatMap((job) => job.steps ?? [])
        .find((step) => step.name === "Deploy")?.env
      for (const name of ID_ENV_NAMES) expect(env?.[name], `${workflow}: ${name}`).toBe(`\${{ secrets.${name} }}`)
    }
  })
})

describe("idEnv and idEnvChecksum", () => {
  test("hold the two required secrets and the Microsoft pair, trimmed, keys sorted", () => {
    const values = idEnv({ ...ENV, ROOT_ADMIN_SECRET: ` ${ID_ENV.ROOT_ADMIN_SECRET}\n` })
    expect(values).toEqual(ID_ENV)
    expect(Object.keys(values)).toEqual([...Object.keys(ID_ENV)].sort())
  })

  test("add the Google pair and BETTER_AUTH_SECRETS when set, and leave out the Microsoft pair when it is not", () => {
    const required = { BETTER_AUTH_SECRET: ID_ENV.BETTER_AUTH_SECRET, ROOT_ADMIN_SECRET: ID_ENV.ROOT_ADMIN_SECRET }
    const values = idEnv({ ...required, GOOGLE_CLIENT_ID: "google-id", GOOGLE_CLIENT_SECRET: "google-secret", BETTER_AUTH_SECRETS: '[{"version":2}]' })
    expect(Object.keys(values)).toEqual(["BETTER_AUTH_SECRET", "BETTER_AUTH_SECRETS", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "ROOT_ADMIN_SECRET"])
    expect(idEnv({ ...required, BETTER_AUTH_SECRETS: " " })).toEqual(required)
  })

  test("refuse a required secret that is empty, naming every one, and half a pair", () => {
    expect(() => idEnv({ ...ENV, BETTER_AUTH_SECRET: "", ROOT_ADMIN_SECRET: undefined })).toThrow(
      "BETTER_AUTH_SECRET, ROOT_ADMIN_SECRET are not set: id-env needs BETTER_AUTH_SECRET, ROOT_ADMIN_SECRET",
    )
    expect(() => idEnv({ ...ENV, ROOT_ADMIN_SECRET: " " })).toThrow("ROOT_ADMIN_SECRET is not set")
    expect(() => idEnv({ ...ENV, MICROSOFT_CLIENT_SECRET: "" })).toThrow(
      "MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET go together: MICROSOFT_CLIENT_ID is set and MICROSOFT_CLIENT_SECRET is not",
    )
    expect(() => idEnv({ ...ENV, GOOGLE_CLIENT_SECRET: "google-secret" })).toThrow(
      "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET go together: GOOGLE_CLIENT_SECRET is set and GOOGLE_CLIENT_ID is not",
    )
  })

  test("the checksum is the SHA-256 of the values as JSON with sorted keys: the same values, the same sum; one changed, another", () => {
    const values = idEnv(ENV)
    expect(idEnvChecksum(values)).toBe(checksum(ID_ENV))
    expect(idEnvChecksum(Object.fromEntries(Object.entries(values).reverse()))).toBe(idEnvChecksum(values))
    expect(idEnvChecksum({ ...values, ROOT_ADMIN_SECRET: "rotated" })).not.toBe(idEnvChecksum(values))
  })
})

describe("deploy", () => {
  test("looks up the digests, applies id-env and upgrades the release by digest, with the bootstrap and the secrets' checksum", async () => {
    const f = await fixture()
    await deploy({ environment: "staging", imageTag: TAG }, f.deps)
    expect(f.runner.commands()).toEqual([
      ...lookups(TAG),
      "kubectl apply -n answerable -f -",
      CLIENT_SECRETS_COMMAND,
      upgradeCommand(`${pins(DIGESTS)} --set-string idEnvChecksum=${checksum(ID_ENV)} --set ops.bootstrap=true`),
    ])
    expect(f.log()).toContain(`Deployed ${TAG} to staging.`)
    expect(f.log()).toContain(`id is ${DIGESTS.id}`)
    expect(f.log()).toContain("id-env holds BETTER_AUTH_SECRET, MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET, ROOT_ADMIN_SECRET.")
  })

  test("hands kubectl id-env on standard input, as base64 data in the answerable namespace, and logs no value", async () => {
    const f = await fixture()
    await deploy({ environment: "staging", imageTag: TAG }, f.deps)
    const apply = f.runner.calls.find((call) => call.argv[0] === "kubectl")!
    expect(apply.options.onOutput).toBeUndefined()
    const manifest = JSON.parse(apply.options.input!)
    expect(manifest).toMatchObject({ apiVersion: "v1", kind: "Secret", metadata: { name: "id-env", namespace: "answerable" }, type: "Opaque" })
    expect(manifest.stringData).toBeUndefined()
    expect(Object.fromEntries(Object.entries(manifest.data as Record<string, string>).map(([name, value]) => [name, Buffer.from(value, "base64").toString()]))).toEqual(ID_ENV)
    const everything = [f.log(), ...f.runner.calls.flatMap((call) => call.argv)].join(" ")
    for (const value of [...Object.values(ID_ENV), CLUSTER_ENV.KUBE_TOKEN]) expect(everything).not.toContain(value)
  })

  test("a changed secret changes the checksum, so the upgrade rolls ID; the same secrets keep it", async () => {
    const first = await fixture()
    await deploy({ environment: "staging", imageTag: TAG }, first.deps)
    const again = await fixture()
    await deploy({ environment: "staging", imageTag: TAG }, again.deps)
    const rotated = await fixture(undefined, { env: { ...ENV, BETTER_AUTH_SECRETS: '[{"version":2,"value":"x"}]' } })
    await deploy({ environment: "staging", imageTag: TAG }, rotated.deps)
    const sum = (f: Awaited<ReturnType<typeof fixture>>) => f.cluster().at(-1)!.match(/idEnvChecksum=([0-9a-f]{64})/)![1]
    expect(sum(again)).toBe(sum(first))
    expect(sum(rotated)).not.toBe(sum(first))
  })

  test("pins the digests it is given and looks nothing up", async () => {
    const f = await fixture()
    await deploy({ environment: "staging", imageTag: TAG, digests: OTHER_DIGESTS }, f.deps)
    expect(f.runner.commands().some((command) => command.startsWith("docker "))).toBe(false)
    expect(f.cluster()[2]).toContain(`--set image.tag=${TAG} ${pins(OTHER_DIGESTS)}`)
  })

  test("stops before the cluster when a tag cannot be resolved", async () => {
    const f = await fixture(undefined, { docker: () => ({ exitCode: 1, stderr: "ghcr.io/…: manifest unknown\n" }) })
    await expect(deploy({ environment: "staging", imageTag: TAG }, f.deps)).rejects.toThrow(
      `could not resolve ghcr.io/rieranthony/answerable/id:${TAG} to a manifest digest (exit 1): ghcr.io/…: manifest unknown`,
    )
    expect(f.runner.commands()).toEqual([lookups(TAG)[0]!])
  })

  test("refuses an answer that is not a digest, and says so when there was no answer at all", async () => {
    const odd = await fixture(undefined, { docker: () => ({ stdout: "latest\n" }) })
    await expect(deploy({ environment: "staging", imageTag: TAG }, odd.deps)).rejects.toThrow(`to a manifest digest (exit 0): latest`)
    const none = await fixture(undefined, { docker: () => ({}) })
    await expect(deploy({ environment: "staging", imageTag: TAG }, none.deps)).rejects.toThrow("(exit 0): no answer")
  })

  test("runs every cluster command in the repository root with a kubeconfig, readable by its owner only, that exists only meanwhile", async () => {
    const f = await fixture()
    const modes: number[] = []
    const deps: Deps = {
      ...f.deps,
      run: async (argv, options) => {
        if (options?.env?.KUBECONFIG) modes.push((await stat(options.env.KUBECONFIG)).mode & 0o777)
        return f.deps.run(argv, options)
      },
    }
    await deploy({ environment: "staging", imageTag: TAG }, deps)
    const clusterCalls = f.runner.calls.filter((call) => call.argv[0] !== "docker")
    expect(clusterCalls).toHaveLength(3)
    expect(new Set(modes)).toEqual(new Set([0o600]))
    for (const call of f.runner.calls) expect(call.options.cwd).toBe(f.root)
    for (const call of clusterCalls) expect(JSON.parse(call.kubeconfig!).users[0].user.token).toBe("deployer-token-value")
    const path = clusterCalls[0]!.options.env!.KUBECONFIG!
    expect(await stat(path).catch(() => null)).toBeNull()
    // The registry lookups get no kubeconfig.
    for (const call of f.runner.calls.filter((call) => call.argv[0] === "docker")) expect(call.options.env).toBeUndefined()
  })

  test("prints only the lines in which kubectl names an object it applied", async () => {
    const f = await fixture((call) =>
      call.argv[1] === "apply" ? { stdout: `secret/id-env configured\nWarning: ${ID_ENV.ROOT_ADMIN_SECRET} is deprecated\nsecret/x created extra ${ID_ENV.ROOT_ADMIN_SECRET}\n` } : undefined,
    )
    await deploy({ environment: "staging", imageTag: TAG }, f.deps)
    expect(f.log()).toContain("secret/id-env configured\n")
    expect(f.log()).not.toContain(ID_ENV.ROOT_ADMIN_SECRET)
  })

  test("says nothing of what kubectl said when the apply fails", async () => {
    const quoted = [ID_ENV.BETTER_AUTH_SECRET, JSON.stringify(ID_ENV.ROOT_ADMIN_SECRET), Buffer.from(ID_ENV.ROOT_ADMIN_SECRET).toString("base64")]
    const f = await fixture((call) => (call.argv[1] === "apply" ? { exitCode: 1, stdout: `secret/id-env ${quoted[0]}\n`, stderr: `error: invalid value ${quoted.join(" ")}\n` } : undefined))
    const failure = await deploy({ environment: "staging", imageTag: TAG }, f.deps).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(PipelineError)
    expect((failure as Error).message).toBe("kubectl apply of the Secret id-env failed with exit code 1; its output is not shown, since it can quote a value")
    for (const text of [(failure as Error).message, f.log()]) for (const value of quoted) expect(text).not.toContain(value)
    expect(f.cluster()).toHaveLength(1)
  })

  test("registers in the same upgrade when neither client Secret exists yet, and says why", async () => {
    const f = await fixture(undefined, { clients: () => ({ stdout: "" }) })
    await deploy({ environment: "staging", imageTag: TAG }, f.deps)
    expect(f.cluster()).toContain(CLIENT_SECRETS_COMMAND)
    expect(f.cluster().at(-1)).toEndWith("--set ops.bootstrap=true --set ops.register=true")
    expect(f.log()).toContain("toolbox-id-client and admin-id-client do not exist in answerable yet, so this upgrade also runs register")
  })

  test("registers when only one client Secret is missing, naming it", async () => {
    for (const [present, missing] of [
      ["secret/toolbox-id-client\n", "admin-id-client"],
      ["secret/admin-id-client\n", "toolbox-id-client"],
    ] as const) {
      const f = await fixture(undefined, { clients: () => ({ stdout: present }) })
      await deploy({ environment: "staging", imageTag: TAG }, f.deps)
      expect(f.cluster().at(-1)).toEndWith("--set ops.register=true")
      expect(f.log()).toContain(`${missing} does not exist in answerable yet, so this upgrade also runs register, which creates it and`)
    }
  })

  test("does not register once both client Secrets exist: root may be locked by then", async () => {
    const f = await fixture()
    await deploy({ environment: "staging", imageTag: TAG }, f.deps)
    expect(f.cluster().at(-1)).not.toContain("ops.register")
    expect(f.log()).not.toContain("also runs register")
  })

  test("stops before the upgrade when it cannot tell whether the client Secrets exist", async () => {
    const f = await fixture(undefined, { clients: () => ({ exitCode: 1, stderr: "Error from server (Forbidden): secrets is forbidden\n" }) })
    await expect(deploy({ environment: "staging", imageTag: TAG }, f.deps)).rejects.toThrow(
      "kubectl get secret failed with exit code 1: Error from server (Forbidden): secrets is forbidden",
    )
    expect(f.cluster().some((command) => command.startsWith("helm "))).toBe(false)
  })

  test("honours another timeout", async () => {
    const f = await fixture()
    await deploy({ environment: "staging", imageTag: TAG, timeout: "15m" }, f.deps)
    expect(f.cluster().at(-1)).toContain(`--timeout 15m -f ${VALUES}`)
  })

  test("refuses, before anything runs, a mutable tag, a missing values file, missing cluster credentials and a missing secret", async () => {
    const f = await fixture()
    await expect(deploy({ environment: "staging", imageTag: "latest" }, f.deps)).rejects.toThrow(UsageError)
    await expect(deploy({ environment: "production", imageTag: TAG }, f.deps)).rejects.toThrow("charts/answerable/values-civo-production.yaml does not exist")
    const noCluster = await fixture(undefined, { env: ID_ENV })
    await expect(deploy({ environment: "staging", imageTag: TAG }, noCluster.deps)).rejects.toThrow("KUBE_SERVER is not set")
    const noSecret = await fixture(undefined, { env: { ...ENV, ROOT_ADMIN_SECRET: "" } })
    await expect(deploy({ environment: "staging", imageTag: TAG }, noSecret.deps)).rejects.toThrow("ROOT_ADMIN_SECRET is not set")
    for (const each of [f, noCluster, noSecret]) expect(each.runner.calls).toEqual([])
  })

  test("reports a failed upgrade with the migration and ops Jobs' logs, and only those", async () => {
    const f = await fixture((call) => {
      const command = call.argv.join(" ")
      if (call.argv[0] === "helm") return { exitCode: 1, stderr: "Error: timed out waiting for the condition\n" }
      if (command === "kubectl get jobs -n answerable -o name")
        return { stdout: "job.batch/answerable-id-migrate\njob.batch/answerable-cleanup\njob.batch/ops-bootstrap\n" }
      if (command.includes("logs")) return { stdout: `log of ${command.split("job-name=")[1]!.split(" ")[0]}\n` }
      return undefined
    })
    await expect(deploy({ environment: "staging", imageTag: TAG }, f.deps)).rejects.toThrow("helm upgrade failed with exit code 1")
    const commands = f.runner.commands()
    expect(commands).toContain("kubectl logs -n answerable -l job-name=answerable-id-migrate --all-containers --prefix --tail=200")
    expect(commands).toContain("kubectl describe pods -n answerable -l job-name=ops-bootstrap")
    expect(commands.some((command) => command.includes("answerable-cleanup"))).toBe(false)
    expect(f.log()).toContain("Error: timed out waiting for the condition")
    expect(f.log()).toContain("--- Job answerable-id-migrate ---")
    expect(f.log()).toContain("log of ops-bootstrap")
    expect(f.log()).not.toContain("Deployed")
  })

  test("still reports the upgrade failure when no Job can be listed, and removes the kubeconfig", async () => {
    const f = await fixture((call) => {
      if (call.argv[0] === "helm") return { exitCode: 1 }
      if (call.argv[1] === "apply") return undefined
      return { exitCode: 1, stderr: "Error from server (Forbidden): jobs is forbidden\n" }
    })
    await expect(deploy({ environment: "staging", imageTag: TAG }, f.deps)).rejects.toThrow("helm upgrade failed")
    expect(f.log()).toContain("jobs is forbidden")
    expect(f.runner.commands().filter((command) => command.startsWith("kubectl logs"))).toEqual([])
    expect(await stat(f.runner.calls.find((call) => call.argv[1] === "apply")!.options.env!.KUBECONFIG!).catch(() => null)).toBeNull()
  })
})

describe("runJob", () => {
  const jobUpgrade = (switches: string, rest = "") =>
    `helm upgrade answerable charts/answerable --namespace answerable --rollback-on-failure --wait --wait-for-jobs --timeout 10m --reset-then-reuse-values -f ${VALUES} ${switches}${rest}`
  const restarts = (call: RecordedCall) =>
    call.argv.join(" ") === "kubectl get deployments -n answerable -o name"
      ? { stdout: "deployment.apps/answerable-id\ndeployment.apps/answerable-toolbox\ndeployment.apps/answerable-admin-mcp\n" }
      : call.argv[1] === "logs"
        ? { stdout: "the Job's log\n" }
        : undefined

  test("register: an upgrade on the release's own values with register alone switched on, its log, then the MCP servers restarted", async () => {
    const f = await fixture(restarts)
    await runJob({ environment: "staging", job: "register" }, f.deps)
    expect(f.runner.commands()).toEqual([
      jobUpgrade("--set ops.bootstrap=false --set ops.register=true --set ops.makeAdmin=false"),
      "kubectl logs -n answerable job/ops-register --all-containers",
      "kubectl get deployments -n answerable -o name",
      "kubectl rollout restart -n answerable deployment.apps/answerable-toolbox deployment.apps/answerable-admin-mcp",
      "kubectl rollout status -n answerable deployment.apps/answerable-toolbox --timeout=10m",
      "kubectl rollout status -n answerable deployment.apps/answerable-admin-mcp --timeout=10m",
    ])
    expect(f.log()).toContain("the Job's log")
    expect(f.log()).toContain("Ran register in staging.")
  })

  test("make-admin passes the email, and bootstrap runs alone; neither restarts anything", async () => {
    const admin = await fixture(restarts)
    await runJob({ environment: "staging", job: "make-admin", email: "you@answerable.org", timeout: "5m" }, admin.deps)
    expect(admin.runner.commands()).toEqual([
      jobUpgrade("--set ops.bootstrap=false --set ops.register=false --set ops.makeAdmin=true", " --set-string ops.adminEmail=you@answerable.org").replace("--timeout 10m", "--timeout 5m"),
      "kubectl logs -n answerable job/ops-make-admin --all-containers",
    ])
    const bootstrap = await fixture(restarts)
    await runJob({ environment: "staging", job: "bootstrap" }, bootstrap.deps)
    expect(bootstrap.runner.commands()[0]).toBe(jobUpgrade("--set ops.bootstrap=true --set ops.register=false --set ops.makeAdmin=false"))
    expect(bootstrap.runner.commands().some((command) => command.startsWith("kubectl rollout"))).toBe(false)
  })

  test("says so when the Job's log cannot be read, and goes on", async () => {
    const f = await fixture((call) => (call.argv[1] === "logs" ? { exitCode: 1 } : undefined))
    await runJob({ environment: "staging", job: "bootstrap" }, f.deps)
    expect(f.log()).toContain("(The Job's log could not be read: kubectl exited with 1.)")
    expect(f.log()).toContain("Ran bootstrap in staging.")
  })

  test("refuses make-admin without an email, an email for another job, an address Helm would split, and starts nothing", async () => {
    const f = await fixture(restarts)
    await expect(runJob({ environment: "staging", job: "make-admin" }, f.deps)).rejects.toThrow("make-admin needs --email")
    await expect(runJob({ environment: "staging", job: "register", email: "you@answerable.org" }, f.deps)).rejects.toThrow("--email belongs to make-admin")
    for (const email of ["you", "you@answerable.org,ops.bootstrap=true", "you @answerable.org"])
      await expect(runJob({ environment: "staging", job: "make-admin", email }, f.deps)).rejects.toThrow("--email must be an email address")
    await expect(runJob({ environment: "production", job: "register" }, f.deps)).rejects.toThrow("does not exist")
    const bare = await fixture(restarts, { env: {} })
    await expect(runJob({ environment: "staging", job: "register" }, bare.deps)).rejects.toThrow("KUBE_SERVER is not set")
    expect(f.runner.calls).toEqual([])
    expect(bare.runner.calls).toEqual([])
  })

  test("never touches id-env: run-job needs only the cluster's credentials", async () => {
    const f = await fixture(restarts, { env: CLUSTER_ENV })
    await runJob({ environment: "staging", job: "register" }, f.deps)
    expect(f.runner.commands().some((command) => command.startsWith("kubectl apply"))).toBe(false)
  })

  test("prints the Jobs' logs and fails when the Job fails", async () => {
    const f = await fixture((call) => {
      const command = call.argv.join(" ")
      if (command.startsWith("helm upgrade")) return { exitCode: 1 }
      if (command === "kubectl get jobs -n answerable -o name") return { stdout: "job.batch/ops-make-admin\n" }
      return restarts(call)
    })
    await expect(runJob({ environment: "staging", job: "make-admin", email: "you@answerable.org" }, f.deps)).rejects.toThrow("helm upgrade failed")
    expect(f.runner.commands()).toContain("kubectl logs -n answerable -l job-name=ops-make-admin --all-containers --prefix --tail=200")
  })

  test("fails when a Deployment to restart is missing, or there are none", async () => {
    const one = await fixture((call) =>
      call.argv.join(" ") === "kubectl get deployments -n answerable -o name" ? { stdout: "deployment.apps/answerable-id\ndeployment.apps/answerable-toolbox\n" } : restarts(call),
    )
    await expect(runJob({ environment: "staging", job: "register" }, one.deps)).rejects.toThrow(
      "expected Deployments for toolbox and admin-mcp in answerable, found: deployment.apps/answerable-id, deployment.apps/answerable-toolbox",
    )
    const none = await fixture((call) => (call.argv.join(" ") === "kubectl get deployments -n answerable -o name" ? { stdout: "" } : restarts(call)))
    await expect(runJob({ environment: "staging", job: "register" }, none.deps)).rejects.toThrow("found: none")
  })

  test("fails when the Deployments cannot be listed, and when the restart is refused or does not finish", async () => {
    const listing = await fixture((call) => (call.argv.join(" ") === "kubectl get deployments -n answerable -o name" ? { exitCode: 1, stderr: "forbidden\n" } : restarts(call)))
    await expect(runJob({ environment: "staging", job: "register" }, listing.deps)).rejects.toThrow("kubectl get deployments failed with exit code 1: forbidden")
    const refused = await fixture((call) => (call.argv.slice(0, 3).join(" ") === "kubectl rollout restart" ? { exitCode: 1 } : restarts(call)))
    await expect(runJob({ environment: "staging", job: "register" }, refused.deps)).rejects.toThrow("kubectl rollout restart failed with exit code 1")
    const stuck = await fixture((call) => (call.argv.slice(0, 3).join(" ") === "kubectl rollout status" ? { exitCode: 1 } : restarts(call)))
    await expect(runJob({ environment: "staging", job: "register" }, stuck.deps)).rejects.toThrow(
      "deployment.apps/answerable-toolbox did not finish restarting (exit code 1)",
    )
  })
})
