import { createHash } from "node:crypto"
import { access, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { CHART, NAMESPACE, REGISTRY, RELEASE, defaultValuesFile, type EnvironmentName } from "./environments"
import { PipelineError, UsageError } from "./errors"
import { commandLine, type Output, type RunOptions, type RunResult, type Runner } from "./run"

/** What the deploy steps need from the outside world. Tests pass fakes. */
export type Deps = {
  /** Runs `docker`, `kubectl` and `helm`. */
  run: Runner
  /** Progress for people. The pipeline never writes a secret here. */
  log: Output
  /** Where `KUBE_SERVER`, `KUBE_CA`, `KUBE_TOKEN` and ID's secrets come from. */
  env: Readonly<Record<string, string | undefined>>
  /** The repository root: commands run there, and every relative path is relative to it. */
  root: string
}

/** The `ops` Jobs the chart can run on request, and the value that switches each on. */
const OPS_JOBS = { bootstrap: "ops.bootstrap", register: "ops.register", "make-admin": "ops.makeAdmin" } as const

/** One of the ops Jobs. */
export type OpsJob = keyof typeof OPS_JOBS

/** Read the job name of `run-job`: it must be one of the ops Jobs. */
export function parseJob(value: string | undefined): OpsJob {
  const found = Object.keys(OPS_JOBS).find((job) => job === value)
  if (!found) throw new UsageError(`the job must be one of ${Object.keys(OPS_JOBS).join(", ")}`)
  return found as OpsJob
}

/** An image tag the pipeline accepts: the full commit SHA, never a branch or `latest`. */
const IMAGE_TAG = /^sha-[0-9a-f]{40}$/

/** The Deployments whose pods read the machine-client secrets that `register` writes. */
const REGISTERED_SERVERS = ["toolbox", "admin-mcp"]

/** Jobs whose logs are printed when an upgrade fails. */
const DIAGNOSED_JOBS = /(migrate|bootstrap|register|make-admin)/

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

/** ID's secrets the deploy requires, each a variable of the deploy step: the GitHub environment's secrets of the same names. */
const ID_ENV_REQUIRED = ["BETTER_AUTH_SECRET", "UPSTREAM_TOKEN_SECRETS", "ROOT_ADMIN_SECRET"] as const
/** The platform applications' credentials: each pair both or neither. */
const ID_ENV_PAIRS = [
  ["MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET"],
  ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
] as const
/** ID's versioned ring of authentication secrets, when one is being rotated (apps/id/README.md). */
const ID_ENV_OPTIONAL = ["BETTER_AUTH_SECRETS"] as const

/**
 * The values of the Secret `id-env`, from the deploy's environment: the three required secrets, each platform
 * application's pair when both halves are set, and `BETTER_AUTH_SECRETS` when it is. Refuses an empty required value
 * and half a pair, naming the variables, never a value.
 */
export function idEnv(env: Deps["env"]): Record<string, string> {
  const value = (name: string) => env[name]?.trim() || undefined
  const empty = ID_ENV_REQUIRED.filter((name) => !value(name))
  if (empty.length > 0)
    throw new UsageError(`${empty.join(", ")} ${empty.length === 1 ? "is" : "are"} not set: id-env needs ${ID_ENV_REQUIRED.join(", ")}`)
  const names: string[] = [...ID_ENV_REQUIRED, ...ID_ENV_OPTIONAL.filter(value)]
  for (const pair of ID_ENV_PAIRS) {
    const set = pair.filter(value)
    if (set.length === 1)
      throw new UsageError(`${pair[0]} and ${pair[1]} go together: ${set[0]} is set and ${pair.find((name) => name !== set[0])} is not`)
    names.push(...set)
  }
  return Object.fromEntries(names.sort().map((name) => [name, value(name)!]))
}

/** The SHA-256 of `id-env`'s values, keys sorted, as JSON: the chart's `idEnvChecksum`, which rolls ID when a value changes. */
export function idEnvChecksum(values: Record<string, string>): string {
  const sorted = Object.fromEntries(Object.keys(values).sort().map((name) => [name, values[name]]))
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex")
}

const IMAGE_NAMES = ["id", "toolbox", "admin-mcp", "ops"] as const

/** One of the four images the release runs; the chart names them the same way in `images.<name>.digest`. */
type ImageName = (typeof IMAGE_NAMES)[number]

/** The manifest digest, `sha256:` and 64 hex characters, of each of the four images. */
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
 * Ask the registry which manifest each image's tag points to, so that the release pins the bytes and not a tag that a
 * rerun could move. Needs Docker with buildx; the packages are public, so no login.
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

async function requireFile(root: string, file: string): Promise<void> {
  try {
    await access(resolve(root, file))
  } catch {
    throw new UsageError(`${file} does not exist (paths are relative to ${root})`)
  }
}

// What `kubectl apply` prints for an object it applied: its kind, its name and what happened, nothing else.
const APPLIED = /^[a-z][\w.-]*\/[\w.-]+ (created|configured|unchanged|serverside-applied)$/

/**
 * Apply the Secret `id-env` on kubectl's standard input. Its values are `data`, base64, not `stringData`: kubectl
 * records what it applied, and only a key it recorded under `data` is removed when a later apply leaves it out (a
 * platform application's pair, `BETTER_AUTH_SECRETS` after a rotation). Nothing of kubectl's own output is shown when the
 * apply fails: an API error can quote a value, in any encoding.
 */
async function applyIdEnv(session: Session, values: Record<string, string>): Promise<void> {
  const manifest = JSON.stringify({
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name: "id-env", namespace: NAMESPACE },
    type: "Opaque",
    data: Object.fromEntries(Object.entries(values).map(([name, value]) => [name, Buffer.from(value).toString("base64")])),
  })
  const applied = await session.quiet(["kubectl", "apply", "-n", NAMESPACE, "-f", "-"], { input: manifest })
  if (applied.exitCode !== 0)
    throw new PipelineError(
      `kubectl apply of the Secret id-env failed with exit code ${applied.exitCode}; its output is not shown, since it can quote a value`,
    )
  for (const line of applied.stdout.split("\n"))
    if (APPLIED.test(line.trim())) session.deps.log(`${line.trim()}\n`)
  session.deps.log(`id-env holds ${Object.keys(values).join(", ")}.\n`)
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

/** `helm upgrade` of the release with `args` after the chart's, which waits for the pods and the Jobs and rolls back on failure. */
async function upgrade(session: Session, install: boolean, timeout: string, args: readonly string[]): Promise<void> {
  const result = await session.show([
    "helm",
    "upgrade",
    ...(install ? ["--install"] : []),
    RELEASE,
    CHART,
    "--namespace",
    NAMESPACE,
    // Helm 4 deprecated --atomic for --rollback-on-failure; setup-tools pins Helm 4.
    "--rollback-on-failure",
    "--wait",
    "--wait-for-jobs",
    "--timeout",
    timeout,
    ...args,
  ])
  if (result.exitCode === 0) return
  session.deps.log("\nThe upgrade failed. The logs of the migration and ops Jobs follow.\n")
  await printJobDiagnostics(session)
  throw new PipelineError(`helm upgrade failed with exit code ${result.exitCode}`)
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
  /** How long Helm waits, as a Go duration; defaults to `10m`. */
  timeout?: string
}

/**
 * Deploy an image tag to an environment: pin the four images by digest, log in with the deployer token, apply the
 * Secret `id-env` from the deploy's environment, then `helm upgrade --install --rollback-on-failure` with the ops
 * bootstrap switched on and `idEnvChecksum`, which rolls ID when a secret changed. The upgrade also runs `register` when
 * the Toolbox's or the admin MCP's client Secret does not exist yet, which is the first install. When the upgrade fails
 * the migration and ops Jobs' logs are printed.
 */
export async function deploy(options: DeployOptions, deps: Deps): Promise<void> {
  assertImageTag(options.imageTag)
  const valuesFile = defaultValuesFile(options.environment)
  await requireFile(deps.root, valuesFile)
  const cluster = readCluster(deps.env)
  const secrets = idEnv(deps.env)
  const digests = options.digests ?? (await resolveDigests(options.imageTag, deps))
  await withSession(deps, cluster, async (session) => {
    await applyIdEnv(session, secrets)
    // The first install has no client Secrets, so the servers would wait at zero replicas for ever: register them in this
    // upgrade. Not otherwise: once a person holds platform:write, ID refuses the root secret that register would use.
    const missing = await missingClientSecrets(session)
    const jobs: OpsJob[] = ["bootstrap"]
    if (missing.length > 0) {
      deps.log(
        `\n${missing.join(" and ")} ${missing.length === 1 ? "does" : "do"} not exist in ${NAMESPACE} yet, so this upgrade also runs register, which creates ${missing.length === 1 ? "it" : "them"} and starts the Toolbox and the admin MCP.\n`,
      )
      jobs.push("register")
    }
    await upgrade(session, true, options.timeout ?? "10m", [
      "-f",
      valuesFile,
      "--set",
      `image.tag=${options.imageTag}`,
      ...IMAGE_NAMES.flatMap((name) => ["--set", `images.${name}.digest=${digests[name]}`]),
      "--set-string",
      `idEnvChecksum=${idEnvChecksum(secrets)}`,
      ...jobs.flatMap((job) => ["--set", `${OPS_JOBS[job]}=true`]),
    ])
    deps.log(`\nDeployed ${options.imageTag} to ${options.environment}.\n`)
  })
}

/** An address Helm's `--set-string` keeps whole: no comma, which would split it, and no backslash or space. */
const EMAIL = /^[^\s@,\\]+@[^\s@,\\]+\.[^\s@,\\]+$/

/** What `runJob` does. */
export type RunJobOptions = {
  environment: EnvironmentName
  job: OpsJob
  /** `make-admin`'s staff member: the email they signed in with. */
  email?: string
  /** How long Helm and the restarts wait, as a Go duration; defaults to `10m`. */
  timeout?: string
}

/**
 * Run an `ops` Job once: upgrade the release on the values it runs (`--reset-then-reuse-values`, so the images, their
 * digests and `idEnvChecksum` stay) with this Job alone switched on, wait for it, and print its log. After `register`
 * it restarts the Toolbox and the admin MCP so they read the client secrets the Job wrote.
 */
export async function runJob(options: RunJobOptions, deps: Deps): Promise<void> {
  if (options.job === "make-admin" && !options.email) throw new UsageError("make-admin needs --email, the address the staff member signed in with")
  if (options.job !== "make-admin" && options.email !== undefined) throw new UsageError("--email belongs to make-admin")
  if (options.email !== undefined && !EMAIL.test(options.email)) throw new UsageError(`--email must be an email address, got "${options.email}"`)
  const valuesFile = defaultValuesFile(options.environment)
  await requireFile(deps.root, valuesFile)
  const cluster = readCluster(deps.env)
  const timeout = options.timeout ?? "10m"
  await withSession(deps, cluster, async (session) => {
    await upgrade(session, false, timeout, [
      "--reset-then-reuse-values",
      "-f",
      valuesFile,
      ...Object.entries(OPS_JOBS).flatMap(([job, value]) => ["--set", `${value}=${job === options.job}`]),
      ...(options.email ? ["--set-string", `ops.adminEmail=${options.email}`] : []),
    ])
    const log = await session.show(["kubectl", "logs", "-n", NAMESPACE, `job/ops-${options.job}`, "--all-containers"])
    if (log.exitCode !== 0) deps.log(`(The Job's log could not be read: kubectl exited with ${log.exitCode}.)\n`)
    if (options.job === "register") await restartServers(session, timeout)
    deps.log(`\nRan ${options.job} in ${options.environment}.\n`)
  })
}
