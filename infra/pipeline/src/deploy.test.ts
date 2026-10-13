import { afterEach, describe, expect, test } from "bun:test"
import { stat } from "node:fs/promises"
import { PipelineError, UsageError } from "./errors"
import {
  assertImageTag,
  currentTag,
  deploy,
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
const OLD_TAG = `sha-${"b".repeat(40)}`
const CERTIFICATE = "-----BEGIN CERTIFICATE-----\nMIIBdemo\n-----END CERTIFICATE-----"
const CLUSTER_ENV = {
  KUBE_SERVER: "https://cluster.example:6443",
  KUBE_CA: Buffer.from(CERTIFICATE).toString("base64"),
  KUBE_TOKEN: "deployer-token-value",
}
const DECRYPTED = `apiVersion: v1
kind: Secret
metadata:
  name: id-env
stringData:
  BETTER_AUTH_SECRET: super-secret-value-123
  ROOT_ADMIN_SECRET: another-secret-456
---
apiVersion: v1
kind: Secret
metadata:
  name: toolbox-extra
data:
  KEY: c2VjcmV0LWJhc2U2NA==
`
const VALUES = "charts/answerable/values-civo-staging.yaml"
const SECRETS = "infra/civo/envs/staging/secrets.enc.yaml"
const NAMES = ["id", "toolbox", "admin-mcp", "ops"] as const

/** The digests the registry answers for TAG, and the ones a release deployed earlier runs. */
const DIGESTS: Digests = {
  id: `sha256:${"1".repeat(64)}`,
  toolbox: `sha256:${"2".repeat(64)}`,
  "admin-mcp": `sha256:${"3".repeat(64)}`,
  ops: `sha256:${"4".repeat(64)}`,
}
const OLD_DIGESTS: Digests = {
  id: `sha256:${"5".repeat(64)}`,
  toolbox: `sha256:${"6".repeat(64)}`,
  "admin-mcp": `sha256:${"7".repeat(64)}`,
  ops: `sha256:${"8".repeat(64)}`,
}
const pins = (digests: Digests) => NAMES.map((name) => `--set images.${name}.digest=${digests[name]}`).join(" ")
const lookups = (tag: string) =>
  NAMES.map((name) => `docker buildx imagetools inspect ghcr.io/rieranthony/answerable/${name}:${tag} --format {{.Manifest.Digest}}`)

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

/** The registry: answers DIGESTS for the image named in `docker buildx imagetools inspect <reference> ...`. */
const registry = (call: RecordedCall): Partial<RunResult> => {
  const name = call.argv[4]!.split("/").pop()!.split(":")[0] as keyof Digests
  return { stdout: `${DIGESTS[name]}\n` }
}

async function fixture(
  reply: (call: RecordedCall) => Partial<RunResult> | undefined,
  env: Record<string, string | undefined> = CLUSTER_ENV,
  docker: (call: RecordedCall) => Partial<RunResult> = registry,
) {
  const root = await createRoot({ [VALUES]: "", [SECRETS]: "sops: {}\n" })
  cleanups.push(root.remove)
  const runner = createFakeRunner((call) => (call.argv[0] === "docker" ? docker(call) : reply(call)))
  const logs: string[] = []
  const deps: Deps = { run: runner.run, log: (text) => logs.push(text), env, root: root.path }
  return {
    deps,
    runner,
    logs,
    root: root.path,
    log: () => logs.join(""),
    /** The commands that reached the cluster side, without the registry lookups. */
    cluster: () => runner.commands().filter((command) => !command.startsWith("docker ")),
  }
}

const happy = (call: RecordedCall) => (call.argv[0] === "sops" ? { stdout: DECRYPTED } : undefined)

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

  test("parseJob accepts the two ops jobs only", () => {
    expect(parseJob("bootstrap")).toBe("bootstrap")
    expect(parseJob("register")).toBe("register")
    expect(() => parseJob("migrate")).toThrow("the job must be one of bootstrap, register")
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

describe("deploy", () => {
  test("looks up the digests, logs in, applies the decrypted secrets and upgrades the release, pinned by digest", async () => {
    const f = await fixture(happy)
    await deploy({ environment: "staging", imageTag: TAG }, f.deps)
    expect(f.runner.commands()).toEqual([
      ...lookups(TAG),
      `sops --decrypt ${SECRETS}`,
      "kubectl apply -n answerable -f -",
      `helm upgrade --install answerable charts/answerable --namespace answerable --rollback-on-failure --wait --timeout 10m -f ${VALUES} --set image.tag=${TAG} ${pins(DIGESTS)}`,
    ])
    expect(f.log()).toContain(`Deployed ${TAG} to staging.`)
    expect(f.log()).toContain(`id is ${DIGESTS.id}`)
  })

  test("pins the digests it is given and looks nothing up", async () => {
    const f = await fixture(happy)
    await deploy({ environment: "staging", imageTag: TAG, digests: OLD_DIGESTS }, f.deps)
    expect(f.runner.commands().some((command) => command.startsWith("docker "))).toBe(false)
    expect(f.cluster()[2]).toContain(`--set image.tag=${TAG} ${pins(OLD_DIGESTS)}`)
  })

  test("stops before the cluster when a tag cannot be resolved", async () => {
    const f = await fixture(happy, CLUSTER_ENV, () => ({ exitCode: 1, stderr: "ghcr.io/…: manifest unknown\n" }))
    await expect(deploy({ environment: "staging", imageTag: TAG }, f.deps)).rejects.toThrow(
      `could not resolve ghcr.io/rieranthony/answerable/id:${TAG} to a manifest digest (exit 1): ghcr.io/…: manifest unknown`,
    )
    expect(f.runner.commands()).toEqual([lookups(TAG)[0]!])
  })

  test("refuses an answer that is not a digest, and says so when there was no answer at all", async () => {
    const odd = await fixture(happy, CLUSTER_ENV, () => ({ stdout: "latest\n" }))
    await expect(deploy({ environment: "staging", imageTag: TAG }, odd.deps)).rejects.toThrow(
      `to a manifest digest (exit 0): latest`,
    )
    const none = await fixture(happy, CLUSTER_ENV, () => ({}))
    await expect(deploy({ environment: "staging", imageTag: TAG }, none.deps)).rejects.toThrow("(exit 0): no answer")
  })

  test("runs every cluster command in the repository root with a kubeconfig that exists only meanwhile", async () => {
    const f = await fixture(happy)
    await deploy({ environment: "staging", imageTag: TAG }, f.deps)
    const clusterCalls = f.runner.calls.filter((call) => call.argv[0] !== "docker")
    expect(clusterCalls).toHaveLength(3)
    for (const call of f.runner.calls) expect(call.options.cwd).toBe(f.root)
    for (const call of clusterCalls) {
      expect(call.kubeconfig).toBeDefined()
      expect(JSON.parse(call.kubeconfig!).users[0].user.token).toBe("deployer-token-value")
    }
    const path = clusterCalls[0]!.options.env!.KUBECONFIG!
    expect(await stat(path).catch(() => null)).toBeNull()
    expect(clusterCalls.every((call) => call.options.env!.KUBECONFIG === path)).toBe(true)
  })

  test("gives the registry lookups no kubeconfig, and the token to nobody else", async () => {
    const f = await fixture(happy)
    await deploy({ environment: "staging", imageTag: TAG }, f.deps)
    for (const call of f.runner.calls.filter((call) => call.argv[0] === "docker")) expect(call.options.env).toBeUndefined()
  })

  test("writes the kubeconfig readable by its owner only", async () => {
    const f = await fixture(happy)
    const modes: number[] = []
    const deps: Deps = {
      ...f.deps,
      run: async (argv, options) => {
        if (options?.env?.KUBECONFIG) modes.push((await stat(options.env.KUBECONFIG)).mode & 0o777)
        return f.deps.run(argv, options)
      },
    }
    await deploy({ environment: "staging", imageTag: TAG }, deps)
    expect(modes).toHaveLength(3)
    expect(new Set(modes)).toEqual(new Set([0o600]))
  })

  test("keeps the decrypted text out of the log and hands it to kubectl on standard input", async () => {
    const f = await fixture(happy)
    await deploy({ environment: "staging", imageTag: TAG }, f.deps)
    const sops = f.runner.calls.find((call) => call.argv[0] === "sops")!
    const apply = f.runner.calls.find((call) => call.argv[0] === "kubectl")!
    expect(sops.options.onOutput).toBeUndefined()
    expect(apply.options.onOutput).toBeUndefined()
    expect(apply.options.input).toBe(DECRYPTED)
    expect(f.log()).not.toContain("super-secret-value-123")
    expect(f.log()).not.toContain("deployer-token-value")
    expect(f.runner.calls.flatMap((call) => call.argv).join(" ")).not.toContain("deployer-token-value")
  })

  test("prints only the lines in which kubectl names an object it applied", async () => {
    const f = await fixture((call) =>
      call.argv[0] === "sops"
        ? { stdout: DECRYPTED }
        : call.argv[0] === "kubectl"
          ? {
              stdout:
                "secret/id-env configured\nsecret/cloudflare-api-token unchanged\nWarning: super-secret-value-123 is deprecated\nsecret/x created extra super-secret-value-123\n",
            }
          : undefined,
    )
    await deploy({ environment: "staging", imageTag: TAG }, f.deps)
    expect(f.log()).toContain("secret/id-env configured\n")
    expect(f.log()).toContain("secret/cloudflare-api-token unchanged\n")
    expect(f.log()).not.toContain("super-secret-value-123")
  })

  test("runs the bootstrap Job in the same upgrade when asked", async () => {
    const f = await fixture(happy)
    await deploy({ environment: "staging", imageTag: TAG, bootstrap: true }, f.deps)
    expect(f.runner.commands().at(-1)).toBe(
      `helm upgrade --install answerable charts/answerable --namespace answerable --rollback-on-failure --wait --wait-for-jobs --timeout 10m -f ${VALUES} --set image.tag=${TAG} ${pins(DIGESTS)} --set ops.bootstrap=true`,
    )
  })

  test("honours another values file, secrets file and timeout", async () => {
    const f = await fixture(happy)
    await deploy(
      { environment: "staging", imageTag: TAG, valuesFile: SECRETS, secretsFile: VALUES, timeout: "15m" },
      f.deps,
    )
    expect(f.cluster()[0]).toBe(`sops --decrypt ${VALUES}`)
    expect(f.cluster()[2]).toContain(`--timeout 15m -f ${SECRETS}`)
  })

  test("refuses a mutable tag before touching anything", async () => {
    const f = await fixture(happy)
    await expect(deploy({ environment: "staging", imageTag: "latest" }, f.deps)).rejects.toThrow(UsageError)
    expect(f.runner.calls).toEqual([])
  })

  test("refuses to start when a file is missing", async () => {
    const f = await fixture(happy)
    await expect(
      deploy({ environment: "production", imageTag: TAG }, f.deps),
    ).rejects.toThrow("charts/answerable/values-civo-production.yaml does not exist")
    expect(f.runner.calls).toEqual([])
  })

  test("refuses to start without cluster credentials", async () => {
    const f = await fixture(happy, {})
    await expect(deploy({ environment: "staging", imageTag: TAG }, f.deps)).rejects.toThrow("KUBE_SERVER is not set")
    expect(f.runner.calls).toEqual([])
  })

  test("stops when sops cannot decrypt, naming the file", async () => {
    const f = await fixture((call) => (call.argv[0] === "sops" ? { exitCode: 128, stderr: "no age identity found\n" } : undefined))
    const failure = deploy({ environment: "staging", imageTag: TAG }, f.deps)
    await expect(failure).rejects.toThrow(`sops could not decrypt ${SECRETS} (exit 128): no age identity found`)
    expect(f.cluster()).toEqual([`sops --decrypt ${SECRETS}`])
  })

  test("says nothing of what kubectl said when the apply fails", async () => {
    const quoted = [
      "super-secret-value-123",
      "super\\u002dsecret-value-123",
      JSON.stringify("another-secret-456"),
      Buffer.from("another-secret-456").toString("base64"),
      "7421",
    ]
    const f = await fixture((call) =>
      call.argv[0] === "sops"
        ? { stdout: DECRYPTED }
        : { exitCode: 1, stdout: `secret/id-env ${quoted[0]}\n`, stderr: `error: invalid value ${quoted.join(" ")} in id-env\n` },
    )
    const failure = await deploy({ environment: "staging", imageTag: TAG }, f.deps).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(PipelineError)
    expect((failure as Error).message).toBe(
      "kubectl apply of the secrets failed with exit code 1; run it by hand with the decrypted file to see why",
    )
    for (const text of [(failure as Error).message, f.log()])
      for (const value of quoted) expect(text).not.toContain(value)
    expect(f.log()).not.toContain("invalid value")
    expect(f.cluster()).toHaveLength(2)
  })

  test("reports a failed upgrade with the migration and ops Jobs' logs, and only those", async () => {
    const f = await fixture((call) => {
      const command = call.argv.join(" ")
      if (call.argv[0] === "sops") return { stdout: DECRYPTED }
      if (call.argv[0] === "helm") return { exitCode: 1, stderr: "Error: timed out waiting for the condition\n" }
      if (command === "kubectl get jobs -n answerable -o name")
        return { stdout: "job.batch/answerable-id-migrate\njob.batch/answerable-cleanup\njob.batch/ops-bootstrap\n" }
      if (command.includes("logs")) return { stdout: `log of ${command.split("job-name=")[1]!.split(" ")[0]}\n` }
      return undefined
    })
    await expect(deploy({ environment: "staging", imageTag: TAG }, f.deps)).rejects.toThrow(
      "helm upgrade failed with exit code 1",
    )
    const commands = f.runner.commands()
    expect(commands).toContain("kubectl logs -n answerable -l job-name=answerable-id-migrate --all-containers --prefix --tail=200")
    expect(commands).toContain("kubectl describe pods -n answerable -l job-name=ops-bootstrap")
    expect(commands.some((command) => command.includes("answerable-cleanup"))).toBe(false)
    expect(f.log()).toContain("Error: timed out waiting for the condition")
    expect(f.log()).toContain("--- Job answerable-id-migrate ---")
    expect(f.log()).toContain("log of answerable-id-migrate")
    expect(f.log()).toContain("log of ops-bootstrap")
    expect(f.log()).not.toContain("Deployed")
  })

  test("still reports the upgrade failure when no Job can be listed", async () => {
    const f = await fixture((call) => {
      if (call.argv[0] === "sops") return { stdout: DECRYPTED }
      if (call.argv[0] === "helm") return { exitCode: 1 }
      if (call.argv[1] === "apply") return undefined
      return { exitCode: 1, stderr: "Error from server (Forbidden): jobs is forbidden\n" }
    })
    await expect(deploy({ environment: "staging", imageTag: TAG }, f.deps)).rejects.toThrow("helm upgrade failed")
    expect(f.log()).toContain("jobs is forbidden")
    expect(f.runner.commands().filter((command) => command.startsWith("kubectl logs"))).toEqual([])
  })

  test("removes the kubeconfig even when the upgrade fails", async () => {
    const f = await fixture((call) => (call.argv[0] === "helm" ? { exitCode: 1 } : happy(call)))
    await expect(deploy({ environment: "staging", imageTag: TAG }, f.deps)).rejects.toThrow()
    const path = f.runner.calls.find((call) => call.argv[0] === "sops")!.options.env!.KUBECONFIG!
    expect(await stat(path).catch(() => null)).toBeNull()
  })
})

describe("runJob", () => {
  const releaseValues = (digests?: Partial<Record<keyof Digests, string>>) =>
    JSON.stringify({
      image: { tag: OLD_TAG },
      ...(digests && { images: Object.fromEntries(Object.entries(digests).map(([name, digest]) => [name, { digest }])) }),
    })
  const registerReply =
    (values: string = releaseValues(OLD_DIGESTS)) =>
    (call: RecordedCall) => {
      const command = call.argv.join(" ")
      if (command.startsWith("helm get values")) return { stdout: values }
      if (command === "kubectl get deployments -n answerable -o name")
        return { stdout: "deployment.apps/answerable-id\ndeployment.apps/answerable-toolbox\ndeployment.apps/answerable-admin-mcp\n" }
      return undefined
    }

  test("upgrades the release on what it runs, with the Job switched on, then restarts the MCP servers after register", async () => {
    const f = await fixture(registerReply())
    await runJob({ environment: "staging", job: "register" }, f.deps)
    expect(f.runner.commands()).toEqual([
      "helm get values answerable --namespace answerable -o json",
      `helm upgrade answerable charts/answerable --namespace answerable --rollback-on-failure --wait --wait-for-jobs --timeout 10m -f ${VALUES} --set image.tag=${OLD_TAG} ${pins(OLD_DIGESTS)} --set ops.register=true`,
      "kubectl get deployments -n answerable -o name",
      "kubectl rollout restart -n answerable deployment.apps/answerable-toolbox deployment.apps/answerable-admin-mcp",
      "kubectl rollout status -n answerable deployment.apps/answerable-toolbox --timeout=10m",
      "kubectl rollout status -n answerable deployment.apps/answerable-admin-mcp --timeout=10m",
    ])
    expect(f.log()).toContain(`Ran register in staging on ${OLD_TAG}.`)
  })

  test("looks the digests up when the release was deployed without them or with only some", async () => {
    for (const values of [releaseValues(), releaseValues({ id: OLD_DIGESTS.id }), releaseValues({ ...OLD_DIGESTS, ops: "sha256:abc" })]) {
      const f = await fixture(registerReply(values))
      await runJob({ environment: "staging", job: "bootstrap" }, f.deps)
      expect(f.runner.commands().slice(0, 5)).toEqual(["helm get values answerable --namespace answerable -o json", ...lookups(OLD_TAG)])
      expect(f.runner.commands()[5]).toContain(`--set image.tag=${OLD_TAG} ${pins(DIGESTS)}`)
    }
  })

  test("looks up the digests of a tag it is given, and does not restart anything after bootstrap", async () => {
    const f = await fixture(registerReply())
    await runJob({ environment: "staging", job: "bootstrap", imageTag: TAG, timeout: "5m" }, f.deps)
    expect(f.runner.commands()).toEqual([
      ...lookups(TAG),
      `helm upgrade answerable charts/answerable --namespace answerable --rollback-on-failure --wait --wait-for-jobs --timeout 5m -f ${VALUES} --set image.tag=${TAG} ${pins(DIGESTS)} --set ops.bootstrap=true`,
    ])
  })

  test("pins the digests it is given for the tag it is given", async () => {
    const f = await fixture(registerReply())
    await runJob({ environment: "staging", job: "bootstrap", imageTag: TAG, digests: OLD_DIGESTS }, f.deps)
    expect(f.runner.commands()).toHaveLength(1)
    expect(f.runner.commands()[0]).toContain(`--set image.tag=${TAG} ${pins(OLD_DIGESTS)}`)
  })

  test("refuses digests without the tag they belong to", async () => {
    const f = await fixture(registerReply())
    await expect(runJob({ environment: "staging", job: "bootstrap", digests: DIGESTS }, f.deps)).rejects.toThrow(
      "digests belong to a tag: give the image tag with them",
    )
    expect(f.runner.calls).toEqual([])
  })

  test("never touches the secrets", async () => {
    const f = await fixture(registerReply())
    await runJob({ environment: "staging", job: "register" }, f.deps)
    expect(f.runner.commands().some((command) => command.startsWith("sops") || command.startsWith("kubectl apply"))).toBe(false)
  })

  test("prints the Jobs' logs and fails when the Job fails", async () => {
    const f = await fixture((call) => {
      const command = call.argv.join(" ")
      if (command.startsWith("helm upgrade")) return { exitCode: 1 }
      if (command === "kubectl get jobs -n answerable -o name") return { stdout: "job.batch/ops-register\n" }
      return registerReply()(call)
    })
    await expect(runJob({ environment: "staging", job: "register" }, f.deps)).rejects.toThrow("helm upgrade failed")
    expect(f.runner.commands()).toContain("kubectl logs -n answerable -l job-name=ops-register --all-containers --prefix --tail=200")
    expect(f.runner.commands().some((command) => command.startsWith("kubectl rollout"))).toBe(false)
  })

  test("refuses a bad tag, a missing values file and missing credentials before any command", async () => {
    const f = await fixture(registerReply())
    await expect(runJob({ environment: "staging", job: "register", imageTag: "staging" }, f.deps)).rejects.toThrow(UsageError)
    await expect(runJob({ environment: "production", job: "register" }, f.deps)).rejects.toThrow("does not exist")
    const bare = await fixture(registerReply(), {})
    await expect(runJob({ environment: "staging", job: "register" }, bare.deps)).rejects.toThrow("KUBE_SERVER is not set")
    expect(f.runner.calls).toEqual([])
    expect(bare.runner.calls).toEqual([])
  })

  test("fails when the release's tag cannot be read", async () => {
    const f = await fixture((call) => (call.argv[0] === "helm" ? { exitCode: 1, stderr: "Error: release: not found\n" } : undefined))
    await expect(runJob({ environment: "staging", job: "register" }, f.deps)).rejects.toThrow(
      "helm get values failed with exit code 1: Error: release: not found",
    )
  })

  test("fails when a Deployment to restart is missing", async () => {
    const f = await fixture((call) =>
      call.argv.join(" ") === "kubectl get deployments -n answerable -o name"
        ? { stdout: "deployment.apps/answerable-id\ndeployment.apps/answerable-toolbox\n" }
        : registerReply()(call),
    )
    await expect(runJob({ environment: "staging", job: "register" }, f.deps)).rejects.toThrow(
      "expected Deployments for toolbox and admin-mcp in answerable, found: deployment.apps/answerable-id, deployment.apps/answerable-toolbox",
    )
  })

  test("says so when there are no Deployments at all", async () => {
    const f = await fixture((call) =>
      call.argv.join(" ") === "kubectl get deployments -n answerable -o name" ? { stdout: "" } : registerReply()(call),
    )
    await expect(runJob({ environment: "staging", job: "register" }, f.deps)).rejects.toThrow("found: none")
  })

  test("fails when the Deployments cannot be listed", async () => {
    const f = await fixture((call) =>
      call.argv.join(" ") === "kubectl get deployments -n answerable -o name"
        ? { exitCode: 1, stderr: "forbidden\n" }
        : registerReply()(call),
    )
    await expect(runJob({ environment: "staging", job: "register" }, f.deps)).rejects.toThrow(
      "kubectl get deployments failed with exit code 1: forbidden",
    )
  })

  test("fails when the restart is refused or does not finish", async () => {
    const refused = await fixture((call) =>
      call.argv.slice(0, 3).join(" ") === "kubectl rollout restart" ? { exitCode: 1 } : registerReply()(call),
    )
    await expect(runJob({ environment: "staging", job: "register" }, refused.deps)).rejects.toThrow(
      "kubectl rollout restart failed with exit code 1",
    )
    const stuck = await fixture((call) =>
      call.argv.slice(0, 3).join(" ") === "kubectl rollout status" ? { exitCode: 1 } : registerReply()(call),
    )
    await expect(runJob({ environment: "staging", job: "register" }, stuck.deps)).rejects.toThrow(
      "deployment.apps/answerable-toolbox did not finish restarting (exit code 1)",
    )
  })
})

describe("currentTag", () => {
  test("reads the tag from the release's values, whatever else they hold", async () => {
    const f = await fixture(() => ({
      stdout: JSON.stringify({ image: { tag: TAG }, images: { id: { digest: DIGESTS.id } }, ops: { register: false } }),
    }))
    expect(await currentTag(f.deps)).toBe(TAG)
    expect(f.runner.commands()).toEqual(["helm get values answerable --namespace answerable -o json"])
  })

  test("fails clearly when the release has no tag, null values or no JSON", async () => {
    for (const stdout of ["null", "{}", JSON.stringify({ image: { tag: "latest" } }), JSON.stringify({ image: { tag: 7 } })]) {
      const f = await fixture(() => ({ stdout }))
      await expect(currentTag(f.deps)).rejects.toThrow("has no image.tag of the form sha-<commit>")
    }
    const broken = await fixture(() => ({ stdout: "Error: not json" }))
    await expect(currentTag(broken.deps)).rejects.toThrow("helm get values did not answer JSON")
  })

  test("fails without credentials", async () => {
    const f = await fixture(() => undefined, {})
    await expect(currentTag(f.deps)).rejects.toThrow(UsageError)
  })
})
