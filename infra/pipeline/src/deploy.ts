import { access, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  CHART,
  NAMESPACE,
  RELEASE,
  defaultSecretsFile,
  defaultValuesFile,
  type EnvironmentName,
} from "./environments"
import { PipelineError, UsageError } from "./errors"
import { commandLine, type Output, type RunOptions, type RunResult, type Runner } from "./run"

/** What the deploy steps need from the outside world. Tests pass fakes. */
export type Deps = {
  /** Runs `sops`, `kubectl` and `helm`. */
  run: Runner
  /** Progress for people. The pipeline never writes a secret here. */
  log: Output
  /** Where `KUBE_SERVER`, `KUBE_CA` and `KUBE_TOKEN` come from; `SOPS_AGE_KEY` reaches `sops` through the process environment. */
  env: Readonly<Record<string, string | undefined>>
  /** The repository root: commands run there, and every relative path is relative to it. */
  root: string
}

/** The `ops` Jobs the chart can run on request. */
export const OPS_JOBS = ["bootstrap", "register"] as const

/** One of {@link OPS_JOBS}. */
export type OpsJob = (typeof OPS_JOBS)[number]

/** Read the job name of `run-job`: it must be one of {@link OPS_JOBS}. */
export function parseJob(value: string | undefined): OpsJob {
  const found = OPS_JOBS.find((job) => job === value)
  if (!found) throw new UsageError(`the job must be one of ${OPS_JOBS.join(", ")}`)
  return found
}

/** An image tag the pipeline accepts: the full commit SHA, never a branch or `latest`. */
export const IMAGE_TAG = /^sha-[0-9a-f]{40}$/

/** The Deployments whose pods read the machine-client secrets that `register` writes. */
const REGISTERED_SERVERS = ["toolbox", "admin-mcp"]

/** Jobs whose logs are printed when an upgrade fails. */
const DIAGNOSED_JOBS = /(migrate|bootstrap|register)/

/** The deployer ServiceAccount's connection to the cluster. */
export type Cluster = {
  /** The API server URL. */
  server: string
  /** The cluster's certificate authority, PEM, base64-encoded. */
  certificateAuthority: string
  /** The `deployer` ServiceAccount's bearer token. */
  token: string
}

function required(env: Deps["env"], name: string): string {
  const value = env[name]?.trim()
  if (!value) throw new UsageError(`${name} is not set`)
  return value
}

function certificateAuthority(value: string): string {
  const pem = value.includes("-----BEGIN") ? value : Buffer.from(value.replace(/\s+/g, ""), "base64").toString("utf8")
  if (!pem.includes("-----BEGIN CERTIFICATE-----"))
    throw new UsageError("KUBE_CA must be a PEM certificate or its base64 encoding")
  return Buffer.from(`${pem.trim()}\n`).toString("base64")
}

/** Read the cluster connection from `KUBE_SERVER`, `KUBE_CA` and `KUBE_TOKEN`. */
export function readCluster(env: Deps["env"]): Cluster {
  const server = required(env, "KUBE_SERVER")
  const authority = required(env, "KUBE_CA")
  const token = required(env, "KUBE_TOKEN")
  if (!/^https:\/\/\S+$/.test(server)) throw new UsageError("KUBE_SERVER must be an https:// URL")
  return { server, certificateAuthority: certificateAuthority(authority), token }
}

/** A kubeconfig document (JSON is valid YAML) for the cluster, with the namespace selected. */
export function kubeconfig(cluster: Cluster): string {
  return JSON.stringify({
    apiVersion: "v1",
    kind: "Config",
    clusters: [
      { name: "answerable", cluster: { server: cluster.server, "certificate-authority-data": cluster.certificateAuthority } },
    ],
    users: [{ name: "deployer", user: { token: cluster.token } }],
    contexts: [{ name: "answerable", context: { cluster: "answerable", user: "deployer", namespace: NAMESPACE } }],
    "current-context": "answerable",
  })
}

/** Raise an error unless `tag` is `sha-` and a full commit SHA. */
export function assertImageTag(tag: string): void {
  if (!IMAGE_TAG.test(tag)) throw new UsageError(`--image-tag must be sha- and the 40-character commit SHA, got "${tag}"`)
}

/**
 * Turn Secret manifests into a function that blanks their values out of a text. Only values under `data` and
 * `stringData` count, with their base64 forms. A manifest that cannot be read withholds the whole text.
 */
export function redactor(manifests: string): (text: string) => string {
  const values = new Set<string>()
  const collect = (node: unknown, inside: boolean): void => {
    if (typeof node === "string") {
      if (!inside) return
      for (const value of [node, ...node.split("\n").map((line) => line.trim())])
        if (value.length >= 4) {
          values.add(value)
          values.add(Buffer.from(value).toString("base64"))
        }
    } else if (Array.isArray(node)) for (const item of node) collect(item, inside)
    else if (node && typeof node === "object")
      for (const [key, child] of Object.entries(node)) collect(child, inside || key === "data" || key === "stringData")
  }
  try {
    collect(Bun.YAML.parse(manifests), false)
  } catch {
    return () => "(output withheld: the manifests could not be parsed to redact it)"
  }
  const longestFirst = [...values].sort((a, b) => b.length - a.length)
  return (text) => longestFirst.reduce((safe, value) => safe.replaceAll(value, "***"), text)
}

type Session = {
  deps: Deps
  /** Run quietly: nothing is printed except the command line. */
  quiet(argv: readonly string[], options?: RunOptions): Promise<RunResult>
  /** Run and print the command's output as it arrives. */
  show(argv: readonly string[], options?: RunOptions): Promise<RunResult>
}

async function withSession<T>(deps: Deps, cluster: Cluster, use: (session: Session) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "answerable-kube-"))
  try {
    const file = join(directory, "config")
    await writeFile(file, kubeconfig(cluster), { mode: 0o600 })
    const run = (argv: readonly string[], options: RunOptions) => {
      deps.log(`$ ${commandLine(argv)}\n`)
      return deps.run(argv, { cwd: deps.root, ...options, env: { KUBECONFIG: file, ...options.env } })
    }
    return await use({
      deps,
      quiet: (argv, options = {}) => run(argv, options),
      show: (argv, options = {}) => run(argv, { ...options, onOutput: deps.log }),
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

async function requireFiles(root: string, files: string[]): Promise<void> {
  for (const file of files)
    try {
      await access(resolve(root, file))
    } catch {
      throw new UsageError(`${file} does not exist (paths are relative to ${root})`)
    }
}

async function applySecrets(session: Session, secretsFile: string): Promise<void> {
  const decrypted = await session.quiet(["sops", "--decrypt", secretsFile])
  if (decrypted.exitCode !== 0)
    throw new PipelineError(`sops could not decrypt ${secretsFile} (exit ${decrypted.exitCode}): ${decrypted.stderr.trim()}`)
  const applied = await session.quiet(["kubectl", "apply", "-n", NAMESPACE, "-f", "-"], { input: decrypted.stdout })
  if (applied.exitCode !== 0)
    throw new PipelineError(
      `kubectl apply of ${secretsFile} failed (exit ${applied.exitCode}): ${redactor(decrypted.stdout)(applied.stderr.trim())}`,
    )
  session.deps.log(applied.stdout)
}

async function printJobDiagnostics(session: Session): Promise<void> {
  const listed = await session.show(["kubectl", "get", "jobs", "-n", NAMESPACE, "-o", "name"])
  const names = listed.stdout
    .split("\n")
    .map((line) => line.trim().replace(/^job\.batch\//, ""))
    .filter((name) => DIAGNOSED_JOBS.test(name))
  for (const name of names) {
    session.deps.log(`\n--- Job ${name} ---\n`)
    await session.show(["kubectl", "logs", "-n", NAMESPACE, "-l", `job-name=${name}`, "--all-containers", "--prefix", "--tail=200"])
    await session.show(["kubectl", "describe", "pods", "-n", NAMESPACE, "-l", `job-name=${name}`])
  }
}

type Upgrade = { install: boolean; imageTag: string; valuesFile: string; timeout: string; jobs: readonly OpsJob[] }

async function upgrade(session: Session, plan: Upgrade): Promise<void> {
  const result = await session.show([
    "helm",
    "upgrade",
    ...(plan.install ? ["--install"] : []),
    RELEASE,
    CHART,
    "--namespace",
    NAMESPACE,
    "--atomic",
    "--wait",
    ...(plan.jobs.length ? ["--wait-for-jobs"] : []),
    "--timeout",
    plan.timeout,
    "-f",
    plan.valuesFile,
    "--set",
    `image.tag=${plan.imageTag}`,
    ...plan.jobs.flatMap((job) => ["--set", `ops.${job}=true`]),
  ])
  if (result.exitCode === 0) return
  session.deps.log("\nThe upgrade failed. The logs of the migration and ops Jobs follow.\n")
  await printJobDiagnostics(session)
  throw new PipelineError(`helm upgrade failed with exit code ${result.exitCode}`)
}

async function readCurrentTag(session: Session): Promise<string> {
  const result = await session.quiet(["helm", "get", "values", RELEASE, "--namespace", NAMESPACE, "-o", "json"])
  if (result.exitCode !== 0)
    throw new PipelineError(`helm get values failed with exit code ${result.exitCode}: ${result.stderr.trim()}`)
  let tag: unknown
  try {
    tag = (JSON.parse(result.stdout) as { image?: { tag?: unknown } } | null)?.image?.tag
  } catch {
    throw new PipelineError("helm get values did not answer JSON")
  }
  if (typeof tag !== "string" || !IMAGE_TAG.test(tag))
    throw new PipelineError(`release ${RELEASE} has no image.tag of the form sha-<commit>; has it been deployed?`)
  return tag
}

async function restartServers(session: Session, timeout: string): Promise<void> {
  const listed = await session.quiet(["kubectl", "get", "deployments", "-n", NAMESPACE, "-o", "name"])
  if (listed.exitCode !== 0)
    throw new PipelineError(`kubectl get deployments failed with exit code ${listed.exitCode}: ${listed.stderr.trim()}`)
  const names = listed.stdout.split("\n").map((line) => line.trim())
  const targets = REGISTERED_SERVERS.map((server) => names.find((name) => name.endsWith(`/${server}`) || name.endsWith(`-${server}`)))
  if (targets.some((target) => target === undefined))
    throw new PipelineError(`expected Deployments for ${REGISTERED_SERVERS.join(" and ")} in ${NAMESPACE}, found: ${names.filter(Boolean).join(", ") || "none"}`)
  const found = targets as string[]
  const restarted = await session.show(["kubectl", "rollout", "restart", "-n", NAMESPACE, ...found])
  if (restarted.exitCode !== 0) throw new PipelineError(`kubectl rollout restart failed with exit code ${restarted.exitCode}`)
  for (const target of found) {
    const status = await session.show(["kubectl", "rollout", "status", "-n", NAMESPACE, target, `--timeout=${timeout}`])
    if (status.exitCode !== 0) throw new PipelineError(`${target} did not finish restarting (exit code ${status.exitCode})`)
  }
}

/** What `deploy` does. */
export type DeployOptions = {
  environment: EnvironmentName
  /** `sha-` and the commit SHA the images were built from. */
  imageTag: string
  /** Also run the idempotent `ops` bootstrap Job in this upgrade. */
  bootstrap?: boolean
  /** The Helm values overlay; defaults to the environment's. */
  valuesFile?: string
  /** The encrypted Secret manifests; defaults to the environment's. */
  secretsFile?: string
  /** How long Helm waits, as a Go duration; defaults to `10m`. */
  timeout?: string
}

/**
 * Deploy an image tag to an environment: log in with the deployer token, apply the decrypted secrets, then
 * `helm upgrade --install --atomic`. When the upgrade fails the migration and ops Jobs' logs are printed.
 */
export async function deploy(options: DeployOptions, deps: Deps): Promise<void> {
  assertImageTag(options.imageTag)
  const valuesFile = options.valuesFile ?? defaultValuesFile(options.environment)
  const secretsFile = options.secretsFile ?? defaultSecretsFile(options.environment)
  await requireFiles(deps.root, [valuesFile, secretsFile])
  const cluster = readCluster(deps.env)
  await withSession(deps, cluster, async (session) => {
    await applySecrets(session, secretsFile)
    await upgrade(session, {
      install: true,
      imageTag: options.imageTag,
      valuesFile,
      timeout: options.timeout ?? "10m",
      jobs: options.bootstrap ? ["bootstrap"] : [],
    })
    deps.log(`\nDeployed ${options.imageTag} to ${options.environment}.\n`)
  })
}

/** What `runJob` does. */
export type RunJobOptions = {
  environment: EnvironmentName
  job: OpsJob
  /** The tag to keep; defaults to the one the release runs now. */
  imageTag?: string
  /** The Helm values overlay; defaults to the environment's. */
  valuesFile?: string
  /** How long Helm and the restarts wait, as a Go duration; defaults to `10m`. */
  timeout?: string
}

/**
 * Run an `ops` Job once: upgrade the release with the Job's value switched on, wait for the Job, and after
 * `register` restart the Toolbox and the admin MCP so they read the client secrets the Job wrote.
 */
export async function runJob(options: RunJobOptions, deps: Deps): Promise<void> {
  if (options.imageTag !== undefined) assertImageTag(options.imageTag)
  const valuesFile = options.valuesFile ?? defaultValuesFile(options.environment)
  await requireFiles(deps.root, [valuesFile])
  const cluster = readCluster(deps.env)
  const timeout = options.timeout ?? "10m"
  await withSession(deps, cluster, async (session) => {
    const imageTag = options.imageTag ?? (await readCurrentTag(session))
    await upgrade(session, { install: false, imageTag, valuesFile, timeout, jobs: [options.job] })
    if (options.job === "register") await restartServers(session, timeout)
    deps.log(`\nRan ${options.job} in ${options.environment} on ${imageTag}.\n`)
  })
}

/** The image tag an environment's release runs now, read from the release's own values. */
export async function currentTag(deps: Deps): Promise<string> {
  const cluster = readCluster(deps.env)
  return withSession(deps, cluster, readCurrentTag)
}
