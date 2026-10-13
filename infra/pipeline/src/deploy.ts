import { access, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  CHART,
  NAMESPACE,
  REGISTRY,
  RELEASE,
  defaultDatabaseCaFile,
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
const OPS_JOBS = ["bootstrap", "register"] as const

/** One of {@link OPS_JOBS}. */
export type OpsJob = (typeof OPS_JOBS)[number]

/** Read the job name of `run-job`: it must be one of {@link OPS_JOBS}. */
export function parseJob(value: string | undefined): OpsJob {
  const found = OPS_JOBS.find((job) => job === value)
  if (!found) throw new UsageError(`the job must be one of ${OPS_JOBS.join(", ")}`)
  return found
}

/** An image tag the pipeline accepts: the full commit SHA, never a branch or `latest`. */
const IMAGE_TAG = /^sha-[0-9a-f]{40}$/

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

const IMAGE_NAMES = ["id", "toolbox", "admin-mcp", "ops"] as const

/** One of the four images the release runs; the chart names them the same way in `images.<name>.digest`. */
type ImageName = (typeof IMAGE_NAMES)[number]

/** The manifest-list digest, `sha256:` and 64 hex characters, of each of the four images. */
export type Digests = Record<ImageName, string>

const DIGEST = /^sha256:[0-9a-f]{64}$/

/**
 * Read repeated `--image-digest <image>=sha256:<hex>` options. None gives `undefined`, which means "look the
 * digests up"; some must be all four.
 */
export function parseDigests(pairs: readonly string[]): Digests | undefined {
  if (pairs.length === 0) return undefined
  const found = new Map<string, string>()
  for (const pair of pairs) {
    const [name = "", digest = ""] = pair.split("=", 2)
    if (!IMAGE_NAMES.some((image) => image === name))
      throw new UsageError(`--image-digest names an unknown image "${name}"; the images are ${IMAGE_NAMES.join(", ")}`)
    if (!DIGEST.test(digest)) throw new UsageError(`--image-digest ${name}= must be sha256: and 64 hex characters`)
    if (found.has(name)) throw new UsageError(`--image-digest names ${name} twice`)
    found.set(name, digest)
  }
  const missing = IMAGE_NAMES.filter((name) => !found.has(name))
  if (missing.length > 0)
    throw new UsageError(`--image-digest must be given for all four images, or none; missing ${missing.join(", ")}`)
  return Object.fromEntries(found) as Digests
}

/**
 * Ask the registry which manifest list each image's tag points to, so that the release pins the bytes and not a
 * tag that a rerun could move. Needs Docker with buildx; the packages are public, so no login.
 */
async function resolveDigests(imageTag: string, deps: Deps): Promise<Digests> {
  const digests: Partial<Digests> = {}
  for (const name of IMAGE_NAMES) {
    const reference = `${REGISTRY}/${name}:${imageTag}`
    const argv = ["docker", "buildx", "imagetools", "inspect", reference, "--format", "{{.Manifest.Digest}}"]
    deps.log(`$ ${commandLine(argv)}\n`)
    const result = await deps.run(argv, { cwd: deps.root })
    const digest = result.stdout.trim()
    if (result.exitCode !== 0 || !DIGEST.test(digest))
      throw new PipelineError(
        `could not resolve ${reference} to a manifest digest (exit ${result.exitCode}): ${result.stderr.trim() || digest || "no answer"}`,
      )
    deps.log(`${name} is ${digest}\n`)
    digests[name] = digest
  }
  return digests as Digests
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

// What `kubectl apply` prints for an object it applied: its kind, its name and what happened, nothing else.
const APPLIED = /^[a-z][\w.-]*\/[\w.-]+ (created|configured|unchanged|serverside-applied)$/

// Nothing of kubectl's own output is shown when the apply fails: an API error can quote a value, in any encoding.
// Set the database's CA file or stop before the cluster is touched, naming the command that writes it.
async function requireDatabaseCa(root: string, environment: EnvironmentName): Promise<string> {
  const file = defaultDatabaseCaFile(environment)
  try {
    await access(resolve(root, file))
  } catch {
    throw new UsageError(`${file} does not exist; write it with: bun run setup database-ca --environment ${environment}`)
  }
  return file
}

async function applySecrets(session: Session, secretsFile: string): Promise<void> {
  const decrypted = await session.quiet(["sops", "--decrypt", secretsFile])
  if (decrypted.exitCode !== 0)
    throw new PipelineError(`sops could not decrypt ${secretsFile} (exit ${decrypted.exitCode}): ${decrypted.stderr.trim()}`)
  const applied = await session.quiet(["kubectl", "apply", "-n", NAMESPACE, "-f", "-"], { input: decrypted.stdout })
  if (applied.exitCode !== 0)
    throw new PipelineError(
      `kubectl apply of the secrets failed with exit code ${applied.exitCode}; run it by hand with the decrypted file to see why`,
    )
  for (const line of applied.stdout.split("\n"))
    if (APPLIED.test(line.trim())) session.deps.log(`${line.trim()}\n`)
}

// The client Secrets that only `register` writes. The chart keeps the Toolbox and the admin MCP at zero replicas until
// they exist.
const CLIENT_SECRETS = ["toolbox-id-client", "admin-id-client"]

async function missingClientSecrets(session: Session): Promise<string[]> {
  const result = await session.quiet(["kubectl", "get", "secret", ...CLIENT_SECRETS, "-n", NAMESPACE, "-o", "name", "--ignore-not-found"])
  if (result.exitCode !== 0)
    throw new PipelineError(`kubectl get secret failed with exit code ${result.exitCode}: ${result.stderr.trim()}`)
  const found = result.stdout.split("\n").map((line) => line.trim().replace(/^secret\//, ""))
  return CLIENT_SECRETS.filter((name) => !found.includes(name))
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

type Upgrade = {
  install: boolean
  imageTag: string
  digests: Digests
  valuesFile: string
  /** The database's CA file, relative to the repository root; the chart renders it into the `postgres-ca` ConfigMap. */
  databaseCaFile: string
  timeout: string
  jobs: readonly OpsJob[]
}

async function upgrade(session: Session, plan: Upgrade): Promise<void> {
  const result = await session.show([
    "helm",
    "upgrade",
    ...(plan.install ? ["--install"] : []),
    RELEASE,
    CHART,
    "--namespace",
    NAMESPACE,
    // Helm 4 deprecated --atomic for --rollback-on-failure; setup-tools pins Helm 4.
    "--rollback-on-failure",
    "--wait",
    ...(plan.jobs.length ? ["--wait-for-jobs"] : []),
    "--timeout",
    plan.timeout,
    "-f",
    plan.valuesFile,
    "--set-file",
    `database.caPem=${plan.databaseCaFile}`,
    "--set",
    `image.tag=${plan.imageTag}`,
    ...IMAGE_NAMES.flatMap((name) => ["--set", `images.${name}.digest=${plan.digests[name]}`]),
    ...plan.jobs.flatMap((job) => ["--set", `ops.${job}=true`]),
  ])
  if (result.exitCode === 0) return
  session.deps.log("\nThe upgrade failed. The logs of the migration and ops Jobs follow.\n")
  await printJobDiagnostics(session)
  throw new PipelineError(`helm upgrade failed with exit code ${result.exitCode}`)
}

/** What the release runs now: the tag, and the digests when the release was deployed by digest. */
type Release = { tag: string; digests: Digests | undefined }

async function readRelease(session: Session): Promise<Release> {
  const result = await session.quiet(["helm", "get", "values", RELEASE, "--namespace", NAMESPACE, "-o", "json"])
  if (result.exitCode !== 0)
    throw new PipelineError(`helm get values failed with exit code ${result.exitCode}: ${result.stderr.trim()}`)
  let values: { image?: { tag?: unknown }; images?: Record<string, { digest?: unknown } | undefined> } | null
  try {
    values = JSON.parse(result.stdout)
  } catch {
    throw new PipelineError("helm get values did not answer JSON")
  }
  const tag = values?.image?.tag
  if (typeof tag !== "string" || !IMAGE_TAG.test(tag))
    throw new PipelineError(`release ${RELEASE} has no image.tag of the form sha-<commit>; has it been deployed?`)
  const kept = IMAGE_NAMES.map((name) => values?.images?.[name]?.digest)
  const complete = kept.every((digest) => typeof digest === "string" && DIGEST.test(digest))
  return { tag, digests: complete ? (Object.fromEntries(IMAGE_NAMES.map((name, index) => [name, kept[index]])) as Digests) : undefined }
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
  /** The digests to pin, when they have been verified already; otherwise they are looked up from the tag. */
  digests?: Digests
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
 * Deploy an image tag to an environment: pin the four images by digest, log in with the deployer token, apply the
 * decrypted secrets, then `helm upgrade --install --rollback-on-failure` with the database's CA file. The upgrade also
 * runs `register` when the Toolbox's or the admin MCP's client Secret does not exist yet, which is the first install.
 * When the upgrade fails the migration and ops Jobs' logs are printed.
 */
export async function deploy(options: DeployOptions, deps: Deps): Promise<void> {
  assertImageTag(options.imageTag)
  const valuesFile = options.valuesFile ?? defaultValuesFile(options.environment)
  const secretsFile = options.secretsFile ?? defaultSecretsFile(options.environment)
  await requireFiles(deps.root, [valuesFile, secretsFile])
  const databaseCaFile = await requireDatabaseCa(deps.root, options.environment)
  const cluster = readCluster(deps.env)
  const digests = options.digests ?? (await resolveDigests(options.imageTag, deps))
  await withSession(deps, cluster, async (session) => {
    await applySecrets(session, secretsFile)
    // The first install has no client Secrets, so the servers would wait at zero replicas for ever: register them in this
    // upgrade. Not otherwise: once a person holds platform:write, ID refuses the root secret that register would use.
    const missing = await missingClientSecrets(session)
    const jobs: OpsJob[] = options.bootstrap ? ["bootstrap"] : []
    if (missing.length > 0) {
      deps.log(
        `\n${missing.join(" and ")} ${missing.length === 1 ? "does" : "do"} not exist in ${NAMESPACE} yet, so this upgrade also runs register, which creates ${missing.length === 1 ? "it" : "them"} and starts the Toolbox and the admin MCP.\n`,
      )
      jobs.push("register")
    }
    await upgrade(session, {
      install: true,
      imageTag: options.imageTag,
      digests,
      valuesFile,
      databaseCaFile,
      timeout: options.timeout ?? "10m",
      jobs,
    })
    deps.log(`\nDeployed ${options.imageTag} to ${options.environment}.\n`)
  })
}

/** What `runJob` does. */
export type RunJobOptions = {
  environment: EnvironmentName
  job: OpsJob
  /** The tag to run; defaults to the one the release runs now, with the digests it runs. */
  imageTag?: string
  /** The digests of `imageTag`, when they have been verified already; otherwise they are looked up. Needs `imageTag`. */
  digests?: Digests
  /** The Helm values overlay; defaults to the environment's. */
  valuesFile?: string
  /** How long Helm and the restarts wait, as a Go duration; defaults to `10m`. */
  timeout?: string
}

/**
 * Run an `ops` Job once: upgrade the release, on what it runs now unless told otherwise, with the Job's value
 * switched on, wait for the Job, and after `register` restart the Toolbox and the admin MCP so they read the client secrets the Job wrote.
 */
export async function runJob(options: RunJobOptions, deps: Deps): Promise<void> {
  if (options.imageTag !== undefined) assertImageTag(options.imageTag)
  if (options.digests && options.imageTag === undefined) throw new UsageError("digests belong to a tag: give the image tag with them")
  const valuesFile = options.valuesFile ?? defaultValuesFile(options.environment)
  await requireFiles(deps.root, [valuesFile])
  const databaseCaFile = await requireDatabaseCa(deps.root, options.environment)
  const cluster = readCluster(deps.env)
  const timeout = options.timeout ?? "10m"
  await withSession(deps, cluster, async (session) => {
    let imageTag = options.imageTag
    let digests = options.digests
    if (imageTag === undefined) {
      const release = await readRelease(session)
      imageTag = release.tag
      digests = release.digests
    }
    digests ??= await resolveDigests(imageTag, deps)
    await upgrade(session, { install: false, imageTag, digests, valuesFile, databaseCaFile, timeout, jobs: [options.job] })
    if (options.job === "register") await restartServers(session, timeout)
    deps.log(`\nRan ${options.job} in ${options.environment} on ${imageTag}.\n`)
  })
}

/** The image tag an environment's release runs now, read from the release's own values. */
export async function currentTag(deps: Deps): Promise<string> {
  const cluster = readCluster(deps.env)
  return withSession(deps, cluster, async (session) => (await readRelease(session)).tag)
}
